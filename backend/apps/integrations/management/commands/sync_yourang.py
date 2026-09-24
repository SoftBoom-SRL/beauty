"""Riconciliazione completa Clienti+Servizi verso Yourang per i saloni connessi.

Uso manuale o via cron (es. ogni ora): i webhook coprono il tempo reale, questo
comando garantisce la coerenza periodica (come i backfill di food/real_estate).

    python manage.py sync_yourang            # tutti i saloni connessi
    python manage.py sync_yourang --salon 3  # un solo salone (id)
"""

from django.core.management.base import BaseCommand
from django.utils import timezone

from apps.integrations.models import YourangConnection
from apps.integrations.sync import summarize_errors, sync_clients, sync_services


class Command(BaseCommand):
    help = "Sincronizza Clienti e Servizi dei saloni connessi verso Yourang"

    def add_arguments(self, parser):
        parser.add_argument("--salon", type=int, default=None, help="ID salone singolo")

    def handle(self, *args, **options):
        # Anche i saloni in ERROR: quasi tutti gli errori qui sono passeggeri (un
        # 502 di Yourang, un timeout) e prima bastava uno di questi perché il
        # salone uscisse dal cron PER SEMPRE — nessun percorso lo riportava a
        # CONNECTED senza un OAuth rifatto a mano, e intanto i webhook
        # continuavano a funzionare, quindi nessuno si accorgeva che il backfill
        # era morto. Chi si disconnette (DISCONNECTED) resta fuori.
        qs = YourangConnection.objects.filter(
            status__in=[
                YourangConnection.Status.CONNECTED,
                YourangConnection.Status.ERROR,
            ]
        )
        if options["salon"]:
            qs = qs.filter(salon_id=options["salon"])

        for conn in qs.select_related("salon"):
            # UPDATE sulla riga con la stessa org, non save() della copia letta
            # a inizio giro: se durante la sync il titolare ha scollegato (riga
            # sparita) o ricollegato, l'esito di questo giro non è più suo.
            same_link = YourangConnection.objects.filter(
                pk=conn.pk, yourang_org_id=conn.yourang_org_id
            )
            try:
                clients = sync_clients(conn)
                services = sync_services(conn)
            except Exception as exc:  # noqa: BLE001
                same_link.update(
                    last_error=str(exc)[:500],
                    status=YourangConnection.Status.ERROR,
                    updated_at=timezone.now(),
                )
                self.stdout.write(self.style.ERROR(f"[{conn.salon}] {exc}"))
                continue
            errors = clients.errors + services.errors
            same_link.update(
                last_sync_at=timezone.now(),
                # Gli errori parziali (403 senza contacts:write, voci rifiutate)
                # restano scritti, come fanno collega e login: prima il cron li
                # azzerava a ogni giro e la dashboard diceva «Connesso ·
                # sincronizzati» con metà anagrafica mai arrivata.
                last_error=summarize_errors(errors),
                # Il primo giro arrivato in fondo riporta la connessione a
                # CONNECTED: è l'unico modo perché un errore passeggero non
                # diventi definitivo.
                status=YourangConnection.Status.CONNECTED,
                updated_at=timezone.now(),
            )
            self.stdout.write(self.style.SUCCESS(
                f"[{conn.salon}] clienti: +{clients.created} link {clients.linked} "
                f"push {clients.pushed} · voci catalogo {services.items}"
            ))
            for err in errors:
                self.stdout.write(self.style.WARNING(f"  {err}"))
