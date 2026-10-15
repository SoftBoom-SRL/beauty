"""Divide le visite importate da AreaBeauty che univano servizi di colleghe diverse.

    python manage.py fix_areabeauty_operatrici --salon the-parlour --dry-run
    python manage.py fix_areabeauty_operatrici --salon the-parlour

Il primo import metteva in un unico appuntamento i servizi in fila di colleghe
diverse (manicure con Ilaria 10–11, poi pedicure con Nori 11–12). In AreaBeauty
erano due blocchi, ognuno nella colonna della sua operatrice e spostabile da
solo; in beauty la visita finiva tutta sotto la prima operatrice in vista
settimana e si spostava solo intera.

Qui ogni gruppo di servizi in fila della stessa operatrice diventa un
appuntamento a sé della stessa cliente, allo stesso orario e nello stesso conto
(«incassato nel conto unico»). Gli aggiuntivi restano con il servizio che li
precede. Nessun servizio cambia orario: il comando lo verifica e altrimenti
annulla tutto. Rilanciato, non fa niente.
"""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Count

from apps.agenda.models import Appointment
from apps.core.importers.areabeauty.repair import chain_starts, imported_appointment_ids, split_off
from apps.core.models import Salon


class _DryRun(Exception):
    pass


def _groups(items):
    """Le voci divise dove cambia l'operatrice di un servizio vero (durata > 0)."""
    groups = [[]]
    for item in items:
        if groups[-1] and item.duration_min > 0 and item.operator_id != groups[-1][0].operator_id:
            groups.append([])
        groups[-1].append(item)
    return groups


class Command(BaseCommand):
    help = "Divide le visite importate da AreaBeauty in un appuntamento per operatrice"

    def add_arguments(self, parser):
        parser.add_argument("--salon", required=True, help="slug del salone")
        parser.add_argument("--dry-run", action="store_true", help="fa tutto e poi annulla")

    def handle(self, *args, **opts):
        salon = Salon.objects.filter(slug=opts["salon"]).first()
        if salon is None:
            raise CommandError(f"Salone «{opts['salon']}» non trovato")
        counts = {"visite divise": 0, "appuntamenti nuovi": 0, "di cui aperti": 0}
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
        several = (
            Appointment.objects.filter(salon=salon, pk__in=imported_appointment_ids(salon))
            .annotate(ops=Count("items__operator", distinct=True))
            .filter(ops__gt=1)
            .order_by("start")
        )
        for appointment in several:
            items = list(appointment.items.select_related("operator").order_by("order", "id"))
            groups = _groups(items)
            if len(groups) == 1:
                continue  # una collega solo su un aggiuntivo: niente da dividere
            counts["visite divise"] += 1
            for part in split_off(appointment, items, groups, chain_starts(appointment, items), "operatrice"):
                counts["appuntamenti nuovi"] += 1
                if part.status in Appointment.OPEN_STATUSES:
                    counts["di cui aperti"] += 1
