"""Consegna gli eventi pendenti dell'outbox alla piattaforma Yourang.

Il motore di consegna (presa in carico, ritentativi con attesa crescente,
ordine per oggetto, scadenze, pulizia dei consegnati) sta in apps.core.outbox,
con la descrizione del protocollo: qui ci sono i giri del worker e le pulizie.

Senza `YOURANG_API_URL` il comando elenca soltanto i pendenti (e fa le
pulizie): è questo il motivo per cui gli OTP dell'app cliente «non arrivano»
finché l'URL di consegna non è configurato (o Yourang non espone ancora
l'endpoint).

Uso: `python manage.py flush_outbox [--limit 200] [--loop --interval 5]`
"""

import logging
import time

from django.conf import settings
from django.core.management.base import BaseCommand

from apps.core.models import OutboxEvent
from apps.core.outbox import PURGE_AFTER_DAYS, expire_stale, flush_pending, purge_delivered
from common import ratelimit

logger = logging.getLogger("youty.outbox")

# Con --loop le pulizie (vedi Command._housekeeping) girano al massimo ogni
# tanto, non a ogni giro di pochi secondi.
HOUSEKEEPING_EVERY_SECONDS = 300


class Command(BaseCommand):
    help = "Consegna gli eventi outbox a Yourang (POST JSON su YOURANG_API_URL)"

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=200)
        parser.add_argument("--loop", action="store_true", help="resta in esecuzione (worker)")
        parser.add_argument("--interval", type=float, default=5.0, help="secondi fra un giro e l'altro con --loop")
        parser.add_argument(
            "--purge-days", type=int, default=PURGE_AFTER_DAYS,
            help="cancella gli eventi consegnati più vecchi di N giorni (0 = mai)",
        )

    def _housekeeping(self, options, *, expire: bool) -> None:
        """Pulizie di ogni giro, che girano anche senza YOURANG_API_URL.

        Prima uscivano solo a consegna attiva: finché l'URL mancava restavano
        per sempre i messaggi sostituiti con dentro telefoni e nomi, i contatori
        di rate limit e le istantanee di «torna indietro» — e il giorno in cui
        l'URL arrivava partiva l'arretrato intero, anche quello senza più senso.
        """
        if expire:
            expired = expire_stale()
            if expired:
                self.stdout.write(f"scaduti {expired} eventi mai consegnati")
        purge_days = options.get("purge_days", PURGE_AFTER_DAYS)
        if purge_days and purge_days > 0:
            purged = purge_delivered(purge_days)
            if purged:
                self.stdout.write(f"cancellati {purged} eventi consegnati oltre i termini")
        # Le finestre di rate limit scadute non servono più a nessuno: senza
        # questa pulizia la tabella cresce per sempre.
        ratelimit.purge_expired()
        from apps.agenda.undo import purge_expired as purge_expired_undo  # lazy

        purge_expired_undo()

    def handle(self, *args, **options):
        if not settings.YOURANG_API_URL:
            self._housekeeping(options, expire=True)
            pending = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
            self.stdout.write(self.style.WARNING(
                f"YOURANG_API_URL non configurato — {pending.count()} eventi restano in coda "
                "(OTP, conferme e promemoria non vengono consegnati)."
            ))
            for event in pending[:20]:
                self.stdout.write(f"  [{event.created_at:%d/%m %H:%M}] {event.event_type}")
            return
        last_housekeeping = None
        while True:
            try:
                sent, failed = flush_pending(options["limit"])
            except Exception:  # noqa: BLE001 - il worker non deve morire mai
                logger.exception("Giro di consegna outbox interrotto da un errore")
                sent = failed = 0
                if not options["loop"]:
                    raise
            if sent or failed:
                self.stdout.write(f"consegnati {sent}, falliti {failed}")
            # la scadenza l'ha già fatta flush_pending, prima di consegnare
            if (
                last_housekeeping is None
                or time.monotonic() - last_housekeeping >= HOUSEKEEPING_EVERY_SECONDS
            ):
                self._housekeeping(options, expire=False)
                last_housekeeping = time.monotonic()
            if not options["loop"]:
                break
            time.sleep(max(1.0, options["interval"]))
