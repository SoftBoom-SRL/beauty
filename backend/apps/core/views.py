"""Stream degli aggiornamenti (Server-Sent Events).

La dashboard apre UNA connessione HTTP a lunga durata e riceve gli eventi del
registro attività appena vengono scritti da qualunque worker: il generatore
interroga la tabella ogni secondo (fan-out via database, niente Redis né
canali), quindi funziona con gunicorn in Docker così com'è, purché i worker
siano `gthread` (una connessione aperta = un thread, non un processo).

Autenticazione: EventSource non può inviare header, perciò il client chiede
prima un ticket effimero (POST /api/core/activity/stream-ticket, con Bearer) e
lo passa in query string. Il ticket vive pochi minuti e vale per un solo salone.
"""

import json
import logging
import secrets
import threading
import time

from django.conf import settings
from django.core.cache import cache
from django.db import close_old_connections
from django.http import HttpResponse, HttpResponseForbidden, StreamingHttpResponse
from django.utils import timezone

from .models import ActivityLog

logger = logging.getLogger("youty.stream")

STREAM_TICKET_TTL = 600           # secondi di validità del ticket
STREAM_MAX_SECONDS = 20 * 60      # poi il server chiude: il client riapre (ricicla i thread)
STREAM_POLL_SECONDS = 1.0
STREAM_KEEPALIVE_SECONDS = 15
# Connessioni live accettate contemporaneamente DA QUESTO PROCESSO. Ogni stream
# aperto occupa un thread di gunicorn (`--worker-class gthread`) e una
# connessione al database per tutta la sua durata: senza tetto, qualche centinaio
# di schede aperte esaurisce il pool e l'intera applicazione smette di
# rispondere, anche per chi non usa l'agenda. Oltre il tetto si risponde 503 e
# la dashboard ripiega da sola sul polling ogni 3 secondi.
# Il ripiego deve valere quanto il default di `SSE_MAX_CONNECTIONS`: era
# rimasto a 40, cioè il vecchio tetto che con `--threads 24` non scattava mai,
# e un'impostazione azzerata riportava di soppiatto quel comportamento.
STREAM_MAX_CONCURRENT = getattr(settings, "SSE_MAX_CONNECTIONS", 0) or 12
_open_streams = 0
_open_streams_lock = threading.Lock()


def _reserve_stream_slot() -> bool:
    global _open_streams
    with _open_streams_lock:
        if _open_streams >= STREAM_MAX_CONCURRENT:
            return False
        _open_streams += 1
        return True


def _release_stream_slot() -> None:
    global _open_streams
    with _open_streams_lock:
        _open_streams = max(0, _open_streams - 1)


def open_stream_count() -> int:
    """Stream live aperti in questo processo (diagnostica e test)."""
    return _open_streams
# Eventi consegnati dal feed live e AREA richiesta per riceverli. Un evento
# arriva a chi ha ALMENO UNO degli scope elencati (il titolare riceve tutto):
# lo stream e il registro attività mostravano incassi, magazzino, fedeltà e
# impostazioni a chiunque fosse autenticato, cioè esattamente i dati che il
# permesso d'area nega a quell'operatrice.
# Tupla vuota = riservato al titolare.
LIVE_FEED_SCOPES = {
    "appointment.": ("agenda",),
    "pause.": ("agenda",),
    "waitlist.": ("agenda",),
    "slot.": ("agenda",),
    "visit.": ("agenda",),
    # La caparra si legge dal pallino in agenda (chi la incassa la vede in cassa):
    # senza questo prefisso la dashboard non sapeva MAI di una caparra pagata o
    # rimborsata e continuava a mostrare «caparra richiesta» col conto alla rovescia.
    "deposit.": ("agenda", "sales"),
    "client.": ("clients",),
    "client_category.": ("clients",),
    "sale.": ("sales",),
    # Listino: l'agenda prenota da lì, quindi serve anche a chi ha solo agenda.
    "service.": ("agenda", "pricing"),
    "category.": ("agenda", "pricing"),
    "package.": ("pricing",),
    # Turni e assenze ridisegnano le corsie dell'agenda.
    "operator.": ("agenda", "team"),
    "product.": ("inventory",),
    "stock.": ("inventory",),
    "order.": ("inventory",),
    "supplier.": ("inventory",),
    "coupon.": ("marketing",),
    "giftcard.": ("marketing", "sales"),
    "loyalty.": ("marketing",),
    "communication.": ("marketing",),
    "automation.": ("marketing",),
    # Orari, intervallo fasce e regole del salone li legge già chiunque da
    # /api/core/salon: senza questo prefisso un cambio di orari fatto dal
    # titolare non raggiungeva più le altre postazioni fino al ricaricamento
    # della pagina. Il sommario non contiene dati di cassa.
    "settings.": ("*",),
}
LIVE_FEED_PREFIXES = tuple(LIVE_FEED_SCOPES)


def allowed_prefixes(is_owner: bool, scopes) -> tuple[str, ...]:
    """Prefissi che questo membro può ricevere dal feed live."""
    if is_owner:
        return LIVE_FEED_PREFIXES
    owned = set(scopes or ())
    return tuple(
        p
        for p, needed in LIVE_FEED_SCOPES.items()
        if "*" in needed or owned.intersection(needed)
    )


def issue_stream_ticket(salon_id: int, user_id, *, is_owner: bool = False, scopes=()) -> str:
    """Biglietto per lo stream SSE.

    I permessi finiscono NEL biglietto: la vista dello stream non ha altro modo
    di sapere chi sta ascoltando (EventSource non manda header) e senza di essi
    consegnava a tutti anche quello che il permesso d'area nega.
    """
    ticket = secrets.token_urlsafe(32)
    cache.set(
        f"stream-ticket:{ticket}",
        {
            "salon_id": salon_id,
            "user_id": user_id,
            "is_owner": bool(is_owner),
            "scopes": sorted(scopes or ()),
        },
        STREAM_TICKET_TTL,
    )
    return ticket


def _event_out(e: ActivityLog) -> dict:
    return {
        "id": e.id,
        "type": e.type,
        "summary": e.summary,
        "actor_id": e.actor_id,
        "actor_name": e.actor_name,
        "payload": e.payload,
        "created_at": e.created_at.isoformat(),
    }


def event_generator(
    salon_id: int,
    after: int,
    *,
    is_owner: bool = False,
    scopes=(),
    max_seconds: float | None = None,
    poll: float = STREAM_POLL_SECONDS,
):
    """Frame SSE: subito `ready` con il cursore, poi `events` a ogni novità, `: ping` come keep-alive.

    Consegna solo gli eventi delle aree su cui chi ascolta ha il permesso: senza
    questo filtro lo stream era una scorciatoia per leggere incassi, magazzino e
    impostazioni senza gli scope corrispondenti.
    """
    # Il filtro si applica in memoria, non nella query: il cursore deve avanzare
    # anche oltre gli eventi che questa persona non può vedere, altrimenti li
    # richiederebbe in eterno.
    prefixes = allowed_prefixes(is_owner, scopes)
    if max_seconds is None:
        max_seconds = STREAM_MAX_SECONDS  # letto a runtime: i test lo abbassano
    started = time.monotonic()
    last_ping = started
    cursor = after
    try:
        if cursor <= 0:
            latest = ActivityLog.objects.filter(salon_id=salon_id).order_by("-id").values_list("id", flat=True).first()
            cursor = latest or 0
        yield f"id: {cursor}\nevent: ready\ndata: {json.dumps({'cursor': cursor})}\n\n"
        while time.monotonic() - started < max_seconds:
            rows = list(
                ActivityLog.objects.filter(salon_id=salon_id, id__gt=cursor).order_by("id")[:100]
            )
            if rows:
                cursor = rows[-1].id
                events = [_event_out(e) for e in rows if e.type.startswith(prefixes)] if prefixes else []
                if events:
                    yield f"id: {cursor}\nevent: events\ndata: {json.dumps({'cursor': cursor, 'events': events})}\n\n"
                last_ping = time.monotonic()
            elif time.monotonic() - last_ping >= STREAM_KEEPALIVE_SECONDS:
                yield f": ping {timezone.now().isoformat()}\n\n"
                last_ping = time.monotonic()
            time.sleep(poll)
        yield f"id: {cursor}\nevent: bye\ndata: {json.dumps({'cursor': cursor})}\n\n"
    finally:
        close_old_connections()


def activity_stream(request):
    ticket = request.GET.get("ticket", "")
    info = cache.get(f"stream-ticket:{ticket}") if ticket else None
    if not info:
        return HttpResponseForbidden("ticket non valido o scaduto")
    try:
        after = int(request.headers.get("Last-Event-ID") or request.GET.get("after") or 0)
    except ValueError:
        after = 0
    if not _reserve_stream_slot():
        logger.warning(
            "Stream live rifiutato: %s connessioni già aperte in questo processo",
            STREAM_MAX_CONCURRENT,
        )
        # 503 e non 403: è temporaneo. Il client passa al polling e riprova.
        response = HttpResponse(
            "Troppe connessioni live aperte: aggiornamento via polling",
            status=503,
            content_type="text/plain; charset=utf-8",
        )
        response["Retry-After"] = "30"
        return response
    response = StreamingHttpResponse(
        event_generator(
            info["salon_id"],
            after,
            is_owner=bool(info.get("is_owner")),
            scopes=info.get("scopes") or (),
        ),
        content_type="text/event-stream",
    )
    # Il posto si libera alla chiusura della risposta, che Django esegue sempre,
    # anche se il generatore non è mai partito.
    response._resource_closers.append(_release_stream_slot)
    response["Cache-Control"] = "no-cache, no-transform"
    response["X-Accel-Buffering"] = "no"   # nginx/traefik: niente buffering
    # niente "Connection: keep-alive": è hop-by-hop e wsgiref (runserver) lo rifiuta
    return response
