"""Ricalcola l'affidabilità delle clienti dai no-show e dagli annullamenti tardivi.

L'affidabilità non si scrive più a mano: la ricalcola il gestionale a ogni
no-show, annullamento tardivo e «torna indietro» (`clients.services`). Questo
comando la rifà per tutte le schede, e serve in due momenti:

- dopo un import da un altro gestionale: le visite arrivano già no-show o
  annullate, senza passare dai gesti che ricalcolano;
- una volta al giorno: un no-show di tredici mesi fa esce dalla finestra dei 12
  mesi, ma nessun gesto lo dice alla scheda (la scheda aperta si corregge da
  sola, la lista e i filtri no).

Uso: `python manage.py recompute_reliability [--salon ID]`
"""

from django.core.management.base import BaseCommand, CommandError

from apps.clients.services import recompute_salon_reliability
from apps.core.models import Salon


class Command(BaseCommand):
    help = "Ricalcola l'affidabilità delle clienti (ultimi 12 mesi di no-show e annullamenti tardivi)."

    def add_arguments(self, parser):
        parser.add_argument("--salon", type=int, dest="salon_id", help="solo il salone con questo id (default: tutti)")

    def handle(self, *args, **options):
        salons = Salon.objects.order_by("id")
        if options["salon_id"] is not None:
            salons = salons.filter(id=options["salon_id"])
            if not salons.exists():
                raise CommandError(f"Nessun salone con id {options['salon_id']}.")
        total = 0
        for salon in salons:
            changed = recompute_salon_reliability(salon)
            total += changed
            self.stdout.write(f"{salon.name} (#{salon.id}): {changed} schede aggiornate")
        self.stdout.write(self.style.SUCCESS(f"Affidabilità ricalcolata: {total} schede aggiornate in tutto."))
