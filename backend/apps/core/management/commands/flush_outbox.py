"""Consegna gli eventi pendenti dell'outbox alla piattaforma Yourang.

Ogni evento viene inviato con una POST JSON a `YOURANG_API_URL` (header
`Authorization: Bearer YOURANG_API_KEY`), corpo:

    {"id": 12, "salon_id": 1, "salon_slug": "the-parlour",
     "event_type": "client.otp", "payload": {...}, "created_at": "…"}

Una risposta 2xx marca l'evento `sent`; un errore incrementa `attempts`, salva
`last_error` e rimanda il prossimo tentativo di un'attesa che raddoppia
(30s, 1m, 2m, … fino a un'ora). Dopo MAX_ATTEMPTS l'evento passa a `failed`
(resta consultabile in admin → Outbox Yourang). Idempotenza lato ricevente:
l'`id` dell'evento è stabile e viene anche inviato come header `Idempotency-Key`.

Ogni evento viene PRESO IN CARICO (`sending`) con un UPDATE condizionale prima
di partire: due worker in parallelo non possono mandare due volte lo stesso
messaggio. Un evento rimasto `sending` oltre `STALE_CLAIM_SECONDS` (processo
morto a metà invio) torna disponibile da solo.

Senza `YOURANG_API_URL` il comando elenca soltanto i pendenti: è questo il
motivo per cui gli OTP dell'app cliente «non arrivano» finché l'URL di
consegna non è configurato (o Yourang non espone ancora l'endpoint).

Uso: `python manage.py flush_outbox [--limit 200] [--loop --interval 5]`
"""

import logging
import time

import httpx
from django.conf import settings
from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from apps.core.models import OutboxEvent
from common import ratelimit

logger = logging.getLogger("youty.outbox")

MAX_ATTEMPTS = 8
TIMEOUT = 15.0
# Attesa prima del ritentativo: 30s, 1m, 2m, 4m… con un tetto a un'ora.
BACKOFF_BASE_SECONDS = 30
BACKOFF_MAX_SECONDS = 3600
# Un evento preso in carico e mai concluso torna libero dopo questo tempo.
STALE_CLAIM_SECONDS = 300


def _due(now):
    """Eventi mai tentati o il cui tempo di attesa è trascorso."""
    return Q(next_attempt_at__isnull=True) | Q(next_attempt_at__lte=now)


# Campi che non devono restare a database una volta consegnato il messaggio: un
# codice di accesso vale finché serve, poi è solo una credenziale in chiaro in
# una tabella che nessuno guarda più.
SENSITIVE_PAYLOAD_KEYS = ("code", "otp", "token")
# Dopo quanti giorni gli eventi già consegnati vengono cancellati.
PURGE_AFTER_DAYS = 30


def _redacted(payload):
    """Copia del payload senza i campi sensibili."""
    if not isinstance(payload, dict):
        return payload
    return {
        key: ("***" if key in SENSITIVE_PAYLOAD_KEYS and value else value)
        for key, value in payload.items()
    }


def purge_delivered(days: int = PURGE_AFTER_DAYS, now=None) -> int:
    """Cancella gli eventi consegnati (o sostituiti) più vecchi di `days` giorni.

    Restavano per sempre, con dentro numeri di telefono e nomi delle clienti.
    Quelli falliti non si toccano: servono a capire cosa è andato storto.
    I `superseded` — mai partiti perché fusi con un evento successivo o
    annullati con «torna indietro» — hanno gli stessi dati dentro e seguono la
    stessa sorte, contati dalla data di creazione visto che non sono mai stati
    consegnati.
    """
    now = now or timezone.now()
    cutoff = now - timezone.timedelta(days=days)
    deleted, _ = OutboxEvent.objects.filter(
        Q(status=OutboxEvent.Status.SENT, sent_at__lt=cutoff)
        | Q(status=OutboxEvent.Status.SUPERSEDED, created_at__lt=cutoff)
    ).delete()
    return deleted


def _backoff_seconds(attempts: int) -> int:
    return min(BACKOFF_BASE_SECONDS * (2 ** max(attempts - 1, 0)), BACKOFF_MAX_SECONDS)


def _mark_failed_attempt(event: OutboxEvent, error: str) -> None:
    now = timezone.now()
    event.attempts += 1
    event.last_error = error[:1000]
    event.claimed_at = None
    if event.attempts >= MAX_ATTEMPTS:
        event.status = OutboxEvent.Status.FAILED
        event.next_attempt_at = None
    else:
        event.status = OutboxEvent.Status.PENDING
        event.next_attempt_at = now + timezone.timedelta(
            seconds=_backoff_seconds(event.attempts)
        )
    event.save(
        update_fields=["status", "last_error", "attempts", "next_attempt_at", "claimed_at"]
    )


def deliver_event(event: OutboxEvent, *, client: httpx.Client | None = None) -> bool:
    """Invia un singolo evento. Ritorna True se consegnato.

    Non solleva mai: qualunque errore diventa un tentativo fallito. Un worker in
    esecuzione continua non deve morire perché un messaggio è andato storto.
    """
    own_client = client is None
    client = client or httpx.Client(timeout=TIMEOUT)
    try:
        body = {
            "id": event.id,
            "salon_id": event.salon_id,
            "salon_slug": event.salon.slug,
            "event_type": event.event_type,
            "payload": event.payload,
            "created_at": event.created_at.isoformat(),
        }
        headers = {"Idempotency-Key": f"outbox-{event.id}"}
        if settings.YOURANG_API_KEY:
            headers["Authorization"] = f"Bearer {settings.YOURANG_API_KEY}"
        try:
            response = client.post(settings.YOURANG_API_URL, json=body, headers=headers)
        except Exception as exc:  # noqa: BLE001 - rete, DNS, TLS, URL malformato…
            _mark_failed_attempt(event, f"{type(exc).__name__}: {exc}")
            return False
        if 200 <= response.status_code < 300:
            event.status = OutboxEvent.Status.SENT
            event.sent_at = timezone.now()
            event.last_error = ""
            event.attempts += 1
            event.next_attempt_at = None
            event.claimed_at = None
            event.payload = _redacted(event.payload)
            event.save(
                update_fields=[
                    "status", "sent_at", "last_error", "attempts",
                    "next_attempt_at", "claimed_at", "payload",
                ]
            )
            return True
        _mark_failed_attempt(event, f"HTTP {response.status_code}: {response.text[:300]}")
        return False
    finally:
        if own_client:
            client.close()


def _claim(event: OutboxEvent) -> bool:
    """Prende in carico l'evento con un UPDATE condizionale.

    Ritorna False se un altro worker è arrivato prima: è questo a impedire che
    la stessa cliente riceva due volte lo stesso messaggio.

    `claimed_at` è l'istante REALE della presa in carico, non quello di inizio
    giro: con 200 eventi da consegnare, l'ultimo risultava preso in carico
    minuti prima di quando è partito davvero e il giro successivo lo
    considerava abbandonato mentre era ancora in volo — la cliente riceveva due
    volte lo stesso OTP.
    """
    now = timezone.now()
    claimed = OutboxEvent.objects.filter(
        pk=event.pk, status=OutboxEvent.Status.PENDING
    ).update(status=OutboxEvent.Status.SENDING, claimed_at=now)
    if claimed:
        event.status = OutboxEvent.Status.SENDING
        event.claimed_at = now
    return bool(claimed)


def release_stale_claims(now=None) -> int:
    """Rimette in coda gli eventi presi in carico da un processo che non c'è più."""
    now = now or timezone.now()
    return OutboxEvent.objects.filter(
        status=OutboxEvent.Status.SENDING,
        claimed_at__lt=now - timezone.timedelta(seconds=STALE_CLAIM_SECONDS),
    ).update(status=OutboxEvent.Status.PENDING, claimed_at=None)


def flush_pending(limit: int = 200) -> tuple[int, int]:
    """Consegna fino a `limit` eventi pendenti e scaduti. Ritorna (consegnati, falliti)."""
    now = timezone.now()
    release_stale_claims(now)
    pending = list(
        OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
        .filter(_due(now))
        .select_related("salon")
        .order_by("created_at")[:limit]
    )
    sent = failed = 0
    with httpx.Client(timeout=TIMEOUT) as client:
        for event in pending:
            if not _claim(event):
                continue
            if deliver_event(event, client=client):
                sent += 1
            else:
                failed += 1
    return sent, failed


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

    def handle(self, *args, **options):
        pending = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
        if not settings.YOURANG_API_URL:
            self.stdout.write(self.style.WARNING(
                f"YOURANG_API_URL non configurato — {pending.count()} eventi restano in coda "
                "(OTP, conferme e promemoria non vengono consegnati)."
            ))
            for event in pending[:20]:
                self.stdout.write(f"  [{event.created_at:%d/%m %H:%M}] {event.event_type}")
            return
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
            if options["purge_days"] > 0:
                purged = purge_delivered(options["purge_days"])
                if purged:
                    self.stdout.write(f"cancellati {purged} eventi consegnati oltre i termini")
            # Le finestre di rate limit scadute non servono più a nessuno: senza
            # questa pulizia la tabella cresce per sempre.
            ratelimit.purge_expired()
            if not options["loop"]:
                break
            time.sleep(max(1.0, options["interval"]))
