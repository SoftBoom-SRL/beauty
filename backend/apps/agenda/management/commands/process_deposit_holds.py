"""Solleciti e rilascio automatico degli appuntamenti con caparra non pagata.

L'agenda lo fa già da sola a ogni lettura (vista giorno/settimana/mese); questo
comando serve al cron per i saloni in cui nessuno ha la dashboard aperta:

    */5 * * * *  python manage.py process_deposit_holds
"""

from django.core.management.base import BaseCommand

from apps.agenda.services.deposit_holds import process_deposit_holds
from apps.core.models import Salon


class Command(BaseCommand):
    help = "Sollecita e libera gli appuntamenti con caparra scaduta (tutti i saloni)"

    def handle(self, *args, **options):
        reminded = released = 0
        for salon in Salon.objects.select_related("settings").all():
            result = process_deposit_holds(salon)
            reminded += result["reminded"]
            released += result["released"]
        self.stdout.write(f"solleciti {reminded}, slot liberati {released}")
