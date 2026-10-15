"""Toglie le pose inventate dagli import AreaBeauty fatti prima della correzione del 15/10.

    python manage.py fix_areabeauty_pose --salon the-parlour --dry-run
    python manage.py fix_areabeauty_pose --salon the-parlour

Il primo import metteva una posa (`soak_min`) dove AreaBeauty non ne aveva:

- sull'ultimo servizio, la differenza fra la «fine lato cliente» della riga e la
  fine del servizio: un blocco allungato a mano, a volte di ore;
- fra due servizi della stessa visita, il buco che li separava in agenda.

Qui ogni posa delle visite importate torna a zero. Dove c'era un buco, i servizi
dopo il buco diventano un appuntamento a sé della stessa cliente, allo stesso
orario e nello stesso conto («incassato nel conto unico»): in AreaBeauty erano
due blocchi. Nessun servizio cambia orario, e il comando lo verifica: se uno si
spostasse annulla tutto. Anche i servizi creati disattivati dall'import perdono
la posa presa dai «minuti cliente» di AreaBeauty.

Gli appuntamenti nati dalla divisione hanno un riferimento `appuntamento`
(`diviso:<visita>:<n>`): rilanciando l'import su un export nuovo, quelli ancora
aperti si rifanno insieme agli altri invece di restare doppi.
"""

import datetime as dt

from django.contrib.contenttypes.models import ContentType
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service
from apps.core.importers.areabeauty import SOURCE
from apps.core.models import ExternalRef, Salon
from apps.sales.models import Sale


class _DryRun(Exception):
    pass


def _starts(appointment, items):
    """{id voce: inizio} come lo calcola l'agenda: in fila dall'inizio, durata più posa."""
    out, at = {}, appointment.start
    for item in items:
        out[item.id] = at
        at += dt.timedelta(minutes=item.duration_min + item.soak_min)
    return out


def _groups(items):
    """Le voci divise dove c'era una posa prima di un servizio vero (durata > 0).

    Gli aggiuntivi (durata 0) restano con il servizio che li precede.
    """
    groups, pending_gap = [[]], False
    for item in items:
        if groups[-1] and item.duration_min > 0 and pending_gap:
            groups.append([])
        if item.duration_min > 0 or not groups[-1]:
            pending_gap = False
        groups[-1].append(item)
        if item.soak_min > 0:
            pending_gap = True
    return groups


class Command(BaseCommand):
    help = "Toglie le pose inventate dagli import AreaBeauty e divide le visite dove c'era un buco"

    def add_arguments(self, parser):
        parser.add_argument("--salon", required=True, help="slug del salone")
        parser.add_argument("--dry-run", action="store_true", help="fa tutto e poi annulla")

    def handle(self, *args, **opts):
        salon = Salon.objects.filter(slug=opts["salon"]).first()
        if salon is None:
            raise CommandError(f"Salone «{opts['salon']}» non trovato")
        counts = {"pose tolte (fine cliente)": 0, "visite divise": 0, "appuntamenti nuovi": 0, "di cui futuri": 0, "servizi del listino senza posa": 0}
        try:
            with transaction.atomic():
                self._fix(salon, counts)
                if opts["dry_run"]:
                    raise _DryRun
        except _DryRun:
            self.stdout.write(self.style.WARNING("Prova: niente salvato."))
        for key, value in counts.items():
            self.stdout.write(f"  {key}: {value}")

    def _fix(self, salon, counts):
        ct = ContentType.objects.get_for_model(Appointment)
        refs = ExternalRef.objects.filter(salon=salon, source=SOURCE, kind__in=["appuntamento", "annullato"], content_type=ct)
        ids = set(refs.values_list("object_id", flat=True))
        with_soak = (
            Appointment.objects.filter(salon=salon, pk__in=ids, items__soak_min__gt=0)
            .distinct()
            .order_by("start")
        )
        new_refs = []
        for appointment in with_soak:
            items = list(appointment.items.order_by("order", "id"))
            before = _starts(appointment, items)
            groups = _groups(items)
            for item in items:
                if item.soak_min:
                    item.soak_min = 0
                    item.save(update_fields=["soak_min"])
            if len(groups) == 1:
                counts["pose tolte (fine cliente)"] += 1
                continue
            counts["visite divise"] += 1
            sale = Sale.objects.filter(appointment=appointment).first()
            paid_in = sale.pk if sale else appointment.paid_in_sale_id
            for n, group in enumerate(groups[1:], start=1):
                part = Appointment.objects.create(
                    salon=salon,
                    location=appointment.location,
                    client=appointment.client,
                    operator=group[0].operator,
                    start=before[group[0].id],
                    status=appointment.status,
                    created_via=appointment.created_via,
                    cancel_reason=appointment.cancel_reason,
                    cancelled_late=appointment.cancelled_late,
                    paid_in_sale_id=paid_in,
                )
                Appointment.objects.filter(pk=part.pk).update(
                    created_at=appointment.created_at, updated_at=appointment.updated_at
                )
                for order, item in enumerate(group):
                    AppointmentService.objects.filter(pk=item.pk).update(appointment=part, order=order)
                new_refs.append(
                    ExternalRef(salon=salon, source=SOURCE, kind="appuntamento", external_id=f"diviso:{appointment.pk}:{n}", content_type=ct, object_id=part.pk)
                )
                counts["appuntamenti nuovi"] += 1
                if part.status in Appointment.OPEN_STATUSES:
                    counts["di cui futuri"] += 1
            # Nessun servizio deve aver cambiato orario.
            after = {}
            for apt in [appointment] + [Appointment.objects.get(pk=r.object_id) for r in new_refs[-(len(groups) - 1):]]:
                apt.refresh_from_db()
                after.update(_starts(apt, list(apt.items.order_by("order", "id"))))
            first = groups[0]
            Appointment.objects.filter(pk=appointment.pk).update(operator=first[0].operator)
            # Gli aggiuntivi (durata 0) non hanno un orario loro: si appoggiano al servizio prima.
            timed = {item.id for item in items if item.duration_min > 0}
            moved = [i for i in timed if before[i] != after.get(i)]
            if moved:
                raise CommandError(f"visita {appointment.pk}: {len(moved)} servizi cambierebbero orario, niente salvato")
        ExternalRef.objects.bulk_create(new_refs, ignore_conflicts=True)

        service_ids = ExternalRef.objects.filter(salon=salon, source=SOURCE, kind="servizio").values_list("object_id", flat=True)
        counts["servizi del listino senza posa"] = Service.objects.filter(
            salon=salon, pk__in=list(service_ids), active=False, soak_min__gt=0
        ).update(soak_min=0)
