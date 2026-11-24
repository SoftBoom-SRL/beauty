"""Invia i messaggi WhatsApp delle automazioni di cui è l'ora (automations.whatsapp).

Uso: `python manage.py run_automations`, ogni 5 minuti (vedi DEPLOY.md).
"""

from django.core.management.base import BaseCommand

from apps.automations.whatsapp import run


class Command(BaseCommand):
    help = "Invia i modelli WhatsApp delle automazioni di cui è l'ora"

    def handle(self, *args, **options):
        counts = run()
        if any(counts.values()):
            self.stdout.write(
                f"inviati {counts['sent']}, falliti {counts['failed']}, saltati {counts['skipped']}"
            )
