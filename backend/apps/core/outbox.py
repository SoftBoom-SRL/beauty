"""Consegna degli eventi dell'outbox alla piattaforma Yourang: il motore di `flush_outbox`.

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

Gli eventi con la stessa `coalesce_key` (lo stesso appuntamento, lo stesso
slot) partono nell'ordine in cui sono nati: uno non parte finché ce n'è uno
più vecchio della stessa chiave ancora da consegnare. Un evento che non ha più
senso (vedi `EXPIRY_FIELDS` / `EXPIRY_AGES`) passa a `expired` invece di
partire in ritardo.

Stava dentro il comando di gestione, dove nessuno lo cercava: chi aggiunge un
tipo di evento con una scadenza lo trova qui, accanto a `emit_event`
(core.services) che lo accoda. Il comando `manage.py flush_outbox` fa i giri
e le pulizie; `delivery_status` è la diagnostica che la dashboard mostra al
titolare.
"""

import datetime as dt
import logging

import httpx
from django.conf import settings
from django.db import transaction
from django.db.models import Exists, OuterRef, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import OutboxEvent

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
    annullati con «torna indietro» — e gli `expired` — scaduti prima di
    partire — hanno gli stessi dati dentro e seguono la stessa sorte, contati
    dalla data di creazione visto che non sono mai stati consegnati.

    L'ultimo messaggio consegnato di ciascun tipo su ciascun oggetto
    (`coalesce_key`) resta invece finché racconta qualcosa che deve ancora
    succedere (`expiry_of`): è ciò che la cliente sa del suo appuntamento, e
    l'agenda lo confronta con lo stato attuale per decidere se c'è da mandarle
    una rettifica. Cancellato dopo trenta giorni, una prenotazione fatta due
    mesi prima restava senza storia proprio quando la si spostava. Per tipo,
    perché sulla stessa chiave possono viaggiare anche messaggi che non
    descrivono l'appuntamento (una ricevuta della caparra).
    """
    now = now or timezone.now()
    cutoff = now - timezone.timedelta(days=days)
    old_sent = OutboxEvent.objects.filter(status=OutboxEvent.Status.SENT, sent_at__lt=cutoff)
    newer_sent = OutboxEvent.objects.filter(
        salon_id=OuterRef("salon_id"),
        coalesce_key=OuterRef("coalesce_key"),
        event_type=OuterRef("event_type"),
        status=OutboxEvent.Status.SENT,
        id__gt=OuterRef("id"),
    )
    keep = [
        event.id
        for event in old_sent.exclude(coalesce_key="")
        .filter(~Exists(newer_sent))
        .only("id", "event_type", "payload", "created_at", "due_at")
        if (deadline := expiry_of(event)) is not None and deadline >= now
    ]
    deleted, _ = (
        OutboxEvent.objects.filter(
            Q(status=OutboxEvent.Status.SENT, sent_at__lt=cutoff)
            | Q(
                status__in=(OutboxEvent.Status.SUPERSEDED, OutboxEvent.Status.EXPIRED),
                created_at__lt=cutoff,
            )
        )
        .exclude(id__in=keep)
        .delete()
    )
    return deleted


# ---- Scadenza dei messaggi -------------------------------------------------------
#
# Il giorno in cui la consegna si accende (YOURANG_API_URL configurato dopo
# settimane) o Yourang torna su dopo un fermo, partiva l'intero arretrato: OTP
# scaduti da giorni, conferme e spostamenti di visite già passate, campagne di
# mesi prima. Un messaggio scade in due modi, a seconda del tipo:
# - quando è passato il momento di cui parla (primo campo presente del payload:
#   l'inizio della visita o dello slot liberato, la scadenza della caparra o
#   dell'invito);
# - quando è più vecchio di un'età massima, contata da quando è diventato
#   consegnabile (`due_at`: per un messaggio programmato è la sua data).
# I tipi non elencati descrivono uno stato che a Yourang serve comunque, anche
# in ritardo (anagrafica, definizioni delle automazioni): non scadono.
EXPIRY_FIELDS = {
    "appointment.created": ("start",),
    "appointment.moved": ("start",),
    "appointment.updated": ("start",),
    "appointment.cancelled": ("start",),
    "appointment.released_unpaid": ("start",),
    "appointment.checked_in": ("end", "start"),
    "slot.freed": ("start",),
    "deposit.payment_link": ("due_at", "start"),
    "deposit.reminder": ("deposit_due_at", "start"),
    "deposit.paid": ("start",),
    "team.invitation": ("expires_at",),
}
EXPIRY_AGES = {
    # un codice di accesso vale dieci minuti (accounts.models.default_otp_expiry)
    "client.otp": dt.timedelta(minutes=10),
    "communication.send": dt.timedelta(hours=12),
    "communication.cancel": dt.timedelta(hours=12),
    "automation.triggered": dt.timedelta(hours=24),
    "appointment.no_show": dt.timedelta(hours=48),
    "visit.completed": dt.timedelta(hours=48),
    "waitlist.deleted": dt.timedelta(hours=48),
    "supplier.order": dt.timedelta(days=3),
    "loyalty.reward": dt.timedelta(days=7),
    "deposit.paid_after_release": dt.timedelta(days=7),
}


def _moment(value):
    """Istante di un campo del payload (ISO 8601), None se assente o illeggibile."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = parse_datetime(value)
    except ValueError:
        return None
    if moment is None:
        return None
    if timezone.is_naive(moment):
        moment = timezone.make_aware(moment)
    return moment


def expiry_of(event: OutboxEvent):
    """Fino a quando il messaggio ha senso (None = non scade)."""
    payload = event.payload if isinstance(event.payload, dict) else {}
    for field in EXPIRY_FIELDS.get(event.event_type, ()):
        moment = _moment(payload.get(field))
        if moment is not None:
            return moment
    age = EXPIRY_AGES.get(event.event_type)
    if age is None:
        return None
    base = event.due_at or event.created_at
    # Una campagna porta anche la sua data: vale quella, se è più avanti.
    scheduled = _moment(payload.get("scheduled_at"))
    if scheduled is not None and scheduled > base:
        base = scheduled
    return base + age


def expire_stale(now=None) -> int:
    """Marca `expired` i pendenti che non ha più senso consegnare. Ritorna quanti.

    Ogni candidato viene riletto sotto lock prima di scadere: nel frattempo una
    correzione dell'agenda può averlo fuso con un orario nuovo, e lo si
    sarebbe buttato via guardando il payload di prima.
    """
    now = now or timezone.now()
    types = set(EXPIRY_FIELDS) | set(EXPIRY_AGES)
    candidates = []
    for event in OutboxEvent.objects.filter(
        status=OutboxEvent.Status.PENDING, event_type__in=types
    ).only("id", "event_type", "payload", "created_at", "due_at"):
        deadline = expiry_of(event)
        if deadline is not None and deadline < now:
            candidates.append(event.id)
    expired = 0
    for event_id in candidates:
        with transaction.atomic():
            event = (
                OutboxEvent.objects.select_for_update()
                .filter(id=event_id, status=OutboxEvent.Status.PENDING)
                .first()
            )
            deadline = expiry_of(event) if event is not None else None
            if deadline is None or deadline >= now:
                continue
            event.status = OutboxEvent.Status.EXPIRED
            event.next_attempt_at = None
            event.last_error = f"Scaduto prima della consegna ({timezone.localtime(deadline):%d/%m %H:%M})"
            event.save(update_fields=["status", "next_attempt_at", "last_error"])
            expired += 1
    if expired:
        logger.info("outbox: %s eventi scaduti prima della consegna", expired)
    return expired


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

    La scadenza si ricontrolla nell'UPDATE stesso, e dopo la presa in carico si
    rilegge il contenuto: fra la lettura della coda e questo istante una
    correzione dell'agenda può aver fuso l'evento (payload nuovo, trattenuta
    allungata). Si consegnava la copia letta prima — l'orario vecchio — e al
    salvataggio la si riscriveva sopra quella fusa.
    """
    now = timezone.now()
    claimed = (
        OutboxEvent.objects.filter(pk=event.pk, status=OutboxEvent.Status.PENDING)
        .filter(_due(now))
        .update(status=OutboxEvent.Status.SENDING, claimed_at=now)
    )
    if claimed:
        # Dopo il claim nessuno lo tocca più (la fusione guarda solo i
        # `pending`): quello che si rilegge è ciò che parte.
        event.refresh_from_db(
            fields=[
                "event_type", "payload", "status", "claimed_at", "attempts",
                "next_attempt_at", "last_error", "coalesce_key",
            ]
        )
    return bool(claimed)


def release_stale_claims(now=None) -> int:
    """Rimette in coda gli eventi presi in carico da un processo che non c'è più."""
    now = now or timezone.now()
    return OutboxEvent.objects.filter(
        status=OutboxEvent.Status.SENDING,
        claimed_at__lt=now - timezone.timedelta(seconds=STALE_CLAIM_SECONDS),
    ).update(status=OutboxEvent.Status.PENDING, claimed_at=None)


def flush_pending(limit: int = 200) -> tuple[int, int]:
    """Consegna fino a `limit` eventi pendenti e scaduti. Ritorna (consegnati, falliti).

    Un evento con `coalesce_key` aspetta che siano consegnati (o falliti,
    sostituiti, scaduti) quelli più vecchi con la stessa chiave. Senza, la
    conferma che aveva preso un 502 ripartiva col suo ritentativo DOPO
    l'annullamento arrivato nel frattempo: l'ultima parola che la cliente
    riceveva era «confermato», e si presentava a un appuntamento annullato.

    Non aspetta invece chi è solo TRATTENUTO (mai tentato, con l'attesa ancora
    in corso: il ritardo di sicurezza dell'agenda). I messaggi dell'appuntamento
    trattenuti si fondono fra loro, quindi dietro a uno così resterebbero solo
    link e sollecito della caparra: fermi anche quaranta minuti mentre il
    termine per pagare corre, e poi consegnati DOPO la conferma fusa con lo
    spostamento, col vecchio orario come ultima parola.
    """
    now = timezone.now()
    release_stale_claims(now)
    expire_stale(now)
    older_undelivered = OutboxEvent.objects.filter(
        salon_id=OuterRef("salon_id"),
        coalesce_key=OuterRef("coalesce_key"),
        id__lt=OuterRef("id"),
        status__in=(OutboxEvent.Status.PENDING, OutboxEvent.Status.SENDING),
    ).exclude(
        status=OutboxEvent.Status.PENDING, attempts=0, next_attempt_at__gt=now,
    )
    pending = list(
        OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
        .filter(_due(now))
        .filter(Q(coalesce_key="") | ~Exists(older_undelivered))
        .select_related("salon")
        .order_by("created_at", "id")[:limit]
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


def delivery_status(salon, now=None) -> dict:
    """Stato della consegna dei messaggi del salone (GET /api/core/outbox/status).

    Senza `YOURANG_API_URL` — o senza il comando schedulato — gli eventi
    restano in coda: è la causa più comune di un OTP «che non arriva», e va
    detta al titolare invece di lasciarlo aspettare un SMS.
    """
    now = now or timezone.now()
    qs = OutboxEvent.objects.filter(salon=salon)
    # `sending` = preso in carico da un worker in questo momento: per chi guarda
    # la diagnostica è ancora un messaggio che non è arrivato.
    active = qs.filter(
        status__in=(OutboxEvent.Status.PENDING, OutboxEvent.Status.SENDING)
    )
    # Trattenuti fino a un istante futuro e mai tentati (una campagna
    # programmata, il ritardo di sicurezza dell'agenda): non sono una coda
    # ferma. Contati fra quelli «in coda», una campagna programmata per sabato
    # faceva dire da lunedì che i messaggi aspettavano da giorni.
    scheduled = active.filter(status=OutboxEvent.Status.PENDING, attempts=0, due_at__gt=now)
    pending = active.exclude(pk__in=scheduled.values("pk"))
    sent = qs.filter(status=OutboxEvent.Status.SENT)
    day_ago = now - dt.timedelta(hours=24)
    return {
        "configured": bool(settings.YOURANG_API_URL),
        "pending": pending.count(),
        "scheduled": scheduled.count(),
        "failed": qs.filter(status=OutboxEvent.Status.FAILED).count(),
        # Scaduti prima di partire (un promemoria oltre l'orario della visita,
        # un codice oltre i suoi dieci minuti): restano fino alla pulizia.
        "expired": qs.filter(status=OutboxEvent.Status.EXPIRED).count(),
        "sent_24h": sent.filter(sent_at__gte=day_ago).count(),
        # Da quando aspetta: la fine della trattenuta, non la creazione.
        "oldest_pending_at": (
            pending.annotate(since=Coalesce("due_at", "created_at"))
            .order_by("since")
            .values_list("since", flat=True)
            .first()
        ),
        "last_sent_at": sent.order_by("-sent_at").values_list("sent_at", flat=True).first(),
        "pending_types": sorted(set(pending.order_by("-id").values_list("event_type", flat=True)[:50])),
    }
