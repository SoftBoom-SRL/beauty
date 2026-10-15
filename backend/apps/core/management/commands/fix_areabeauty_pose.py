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

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.agenda.models import Appointment
from apps.catalog.models import Service
from apps.core.importers.areabeauty import SOURCE
from apps.core.importers.areabeauty.repair import chain_starts, imported_appointment_ids, split_off
from apps.core.models import ExternalRef, Salon


class _DryRun(Exception):
    pass


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
        with_soak = (
            Appointment.objects.filter(salon=salon, pk__in=imported_appointment_ids(salon), items__soak_min__gt=0)
            .distinct()
            .order_by("start")
        )
        for appointment in with_soak:
            items = list(appointment.items.order_by("order", "id"))
            before = chain_starts(appointment, items)
            groups = _groups(items)
            for item in items:
                if item.soak_min:
                    item.soak_min = 0
                    item.save(update_fields=["soak_min"])
            if len(groups) == 1:
                counts["pose tolte (fine cliente)"] += 1
                continue
            counts["visite divise"] += 1
            for part in split_off(appointment, items, groups, before, "diviso"):
                counts["appuntamenti nuovi"] += 1
                if part.status in Appointment.OPEN_STATUSES:
                    counts["di cui futuri"] += 1

        service_ids = ExternalRef.objects.filter(salon=salon, source=SOURCE, kind="servizio").values_list("object_id", flat=True)
        counts["servizi del listino senza posa"] = Service.objects.filter(
            salon=salon, pk__in=list(service_ids), active=False, soak_min__gt=0
        ).update(soak_min=0)
