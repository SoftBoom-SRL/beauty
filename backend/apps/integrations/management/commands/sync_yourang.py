"""Riconciliazione completa Clienti+Servizi verso Yourang per i saloni connessi.

Uso manuale o via cron (es. ogni ora): i webhook coprono il tempo reale, questo
comando garantisce la coerenza periodica (come i backfill di food/real_estate).

    python manage.py sync_yourang            # tutti i saloni connessi
    python manage.py sync_yourang --salon 3  # un solo salone (id)
"""

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.integrations.models import YourangConnection
from apps.integrations.sync import sync_clients, sync_services


class Command(BaseCommand):
    help = "Sincronizza Clienti e Servizi dei saloni connessi verso Yourang"

    def add_arguments(self, parser):
        parser.add_argument("--salon", type=int, default=None, help="ID salone singolo")

    def handle(self, *args, **options):
        qs = YourangConnection.objects.filter(status=YourangConnection.Status.CONNECTED)
        if options["salon"]:
            qs = qs.filter(salon_id=options["salon"])

        for conn in qs.select_related("salon"):
            try:
                clients = sync_clients(conn)
                services = sync_services(conn)
                conn.last_sync_at = timezone.now()
                conn.last_error = ""
                conn.save(update_fields=["last_sync_at", "last_error"])
                self.stdout.write(self.style.SUCCESS(
                    f"[{conn.salon}] clienti: +{clients.created} link {clients.linked} "
                    f"push {clients.pushed} · voci catalogo {services.items}"
                ))
                for err in (clients.errors + services.errors):
                    self.stdout.write(self.style.WARNING(f"  {err}"))
            except Exception as exc:  # noqa: BLE001
                conn.last_error = str(exc)
                conn.status = YourangConnection.Status.ERROR
                conn.save(update_fields=["last_error", "status"])
                self.stdout.write(self.style.ERROR(f"[{conn.salon}] {exc}"))
