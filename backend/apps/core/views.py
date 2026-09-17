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
from django.db.models import Q
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
STREAM_MAX_CONCURRENT = getattr(settings, "SSE_MAX_CONNECTIONS", 0) or 40
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
LIVE_FEED_PREFIXES = (
    "appointment.", "pause.", "waitlist.", "slot.", "visit.",
    "client.", "client_category.", "sale.", "service.", "package.", "category.",
    "operator.", "product.", "stock.", "order.", "supplier.",
    "coupon.", "giftcard.", "loyalty.", "communication.", "automation.", "settings.",
)


def issue_stream_ticket(salon_id: int, user_id) -> str:
    ticket = secrets.token_urlsafe(32)
    cache.set(f"stream-ticket:{ticket}", {"salon_id": salon_id, "user_id": user_id}, STREAM_TICKET_TTL)
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


def event_generator(salon_id: int, after: int, *, max_seconds: float | None = None, poll: float = STREAM_POLL_SECONDS):
    """Frame SSE: subito `ready` con il cursore, poi `events` a ogni novità, `: ping` come keep-alive."""
    prefix_q = Q()
    for prefix in LIVE_FEED_PREFIXES:
        prefix_q |= Q(type__startswith=prefix)

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
                events = [_event_out(e) for e in rows if any(e.type.startswith(p) for p in LIVE_FEED_PREFIXES)]
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
        event_generator(info["salon_id"], after), content_type="text/event-stream"
    )
    # Il posto si libera alla chiusura della risposta, che Django esegue sempre,
    # anche se il generatore non è mai partito.
    response._resource_closers.append(_release_stream_slot)
    response["Cache-Control"] = "no-cache, no-transform"
    response["X-Accel-Buffering"] = "no"   # nginx/traefik: niente buffering
    # niente "Connection: keep-alive": è hop-by-hop e wsgiref (runserver) lo rifiuta
    return response
