"""Stream degli aggiornamenti (Server-Sent Events).

La dashboard apre UNA connessione HTTP a lunga durata e riceve gli eventi del
registro attività appena vengono scritti da qualunque worker: il generatore
interroga la tabella ogni secondo (fan-out via database, niente Redis né
canali), quindi funziona con gunicorn in Docker così com'è, purché i worker
siano `gthread` (una connessione aperta = un thread, non un processo).

Autenticazione: EventSource non può inviare header, perciò il client chiede
prima un ticket effimero (POST /api/core/activity/stream-ticket, con Bearer) e
lo passa in query string. Il ticket vale un minuto e UNA volta, per un solo
salone e per la persona che l'ha chiesto: all'apertura, e poi ogni minuto, lo
stream rilegge la sua membership.
"""

import json
import logging
import secrets
import threading
import time
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import close_old_connections
from django.http import HttpResponse, HttpResponseForbidden, StreamingHttpResponse
from django.utils import timezone

from .models import ActivityLog

logger = logging.getLogger("youty.stream")

# Il ticket si usa appena emesso, e una volta sola. Valeva dieci minuti e si
# poteva riusare: finito in un access log (sta in query string) apriva altri
# stream, anche dopo che la persona era stata tolta dal salone.
STREAM_TICKET_TTL = 60            # secondi di validità del ticket
STREAM_MAX_SECONDS = 20 * 60      # poi il server chiude: il client riapre (ricicla i thread)
STREAM_POLL_SECONDS = 1.0
STREAM_KEEPALIVE_SECONDS = 15
# Ogni quanto uno stream aperto riverifica la membership di chi ascolta: chi
# viene tolta dal salone, cambia password o perde un permesso smette di ricevere
# entro un minuto, non a fine stream (20 minuti).
STREAM_ACCESS_CHECK_SECONDS = 60
# Finestra di sicurezza del feed live. Su Postgres l'id si assegna all'INSERT
# ma la riga si vede al COMMIT: una transazione che prendeva l'id N e committava
# dopo N+1 veniva scavalcata dal cursore, e l'evento non arrivava a nessuna
# postazione, nemmeno col polling di coerenza. Stream e polling rileggono quindi
# anche gli eventi con id sotto il cursore scritti negli ultimi secondi (una
# transazione più lunga è un'eccezione). Il prezzo è qualche riconsegna, che la
# dashboard scarta per id (contratto C20).
LIVE_FEED_SAFETY_SECONDS = 15
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
    # Le etichette compaiono anche nelle condizioni delle automazioni: chi ha
    # solo marketing restava con i nomi vecchi dopo un rinomina (15-07).
    "client_category.": ("clients", "marketing"),
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
    # Regole caparra: le legge e le scrive solo il titolare. Senza prefisso le
    # sue modifiche non arrivavano nemmeno alle altre sue postazioni.
    "deposit_rule.": (),
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


def issue_stream_ticket(
    salon_id: int, user_id, *, is_owner: bool = False, scopes=(), token_version: int = 0
) -> str:
    """Biglietto per lo stream SSE.

    Dice CHI sta ascoltando (EventSource non manda header): utente, salone e
    versione della password. I permessi con cui consegnare si rileggono dalla
    membership all'apertura (`stream_access`); quelli scritti qui restano solo
    come traccia di chi l'ha chiesto.
    """
    ticket = secrets.token_urlsafe(32)
    cache.set(
        f"stream-ticket:{ticket}",
        {
            "salon_id": salon_id,
            "user_id": user_id,
            "tv": token_version or 0,
            "is_owner": bool(is_owner),
            "scopes": sorted(scopes or ()),
        },
        STREAM_TICKET_TTL,
    )
    return ticket


def _redeem_stream_ticket(ticket: str) -> dict | None:
    """Il biglietto vale una volta sola: letto, si cancella.

    `delete()` dice se la riga c'era ancora, quindi di due richieste arrivate
    insieme con lo stesso biglietto passa solo la prima.
    """
    if not ticket:
        return None
    key = f"stream-ticket:{ticket}"
    info = cache.get(key)
    if not info or not cache.delete(key):
        return None
    return info


def stream_access(info: dict):
    """(is_owner, scopes) ATTUALI di chi ha chiesto il biglietto, None se non può più ascoltare.

    Lo stesso controllo di StaffAuth: membership viva, utente attivo e stessa
    versione della password. Senza, chi veniva tolta dal salone (o cambiava
    password) continuava a ricevere incassi e nomi delle clienti con un
    biglietto chiesto poco prima, e un permesso tolto restava valido fino a
    fine stream.
    """
    from apps.accounts.models import Membership  # lazy: evita cicli in fase di load

    membership = (
        Membership.objects.select_related("user", "role")
        .filter(
            user_id=info.get("user_id"),
            salon_id=info.get("salon_id"),
            user__is_active=True,
        )
        .first()
    )
    if membership is None:
        return None
    if (membership.user.token_version or 0) != info.get("tv", 0):
        return None
    scopes = sorted(membership.role.scopes or []) if membership.role else []
    return bool(membership.is_owner), scopes


def _window_rows(salon_id: int, cursor: int, horizon):
    """(id, created_at) degli eventi fino al cursore scritti dopo `horizon`."""
    return (
        ActivityLog.objects.filter(salon_id=salon_id, id__lte=cursor, created_at__gte=horizon)
        .values_list("id", "created_at")
    )


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
    access_check=None,
):
    """Frame SSE: subito `ready` con il cursore, poi `events` a ogni novità, `: ping` come keep-alive.

    Consegna solo gli eventi delle aree su cui chi ascolta ha il permesso: senza
    questo filtro lo stream era una scorciatoia per leggere incassi, magazzino e
    impostazioni senza gli scope corrispondenti. `access_check` (facoltativo)
    ridà i permessi attuali, o None per chiudere: vedi STREAM_ACCESS_CHECK_SECONDS.
    """
    # Il filtro si applica in memoria, non nella query: il cursore deve avanzare
    # anche oltre gli eventi che questa persona non può vedere, altrimenti li
    # richiederebbe in eterno.
    prefixes = allowed_prefixes(is_owner, scopes)
    if max_seconds is None:
        max_seconds = STREAM_MAX_SECONDS  # letto a runtime: i test lo abbassano
    started = time.monotonic()
    last_ping = started
    last_check = started
    cursor = after
    # Eventi della finestra di sicurezza già letti da questo stream (id →
    # created_at): la rilettura consegna solo quelli comparsi dopo.
    seen = {}
    try:
        if cursor <= 0:
            latest = ActivityLog.objects.filter(salon_id=salon_id).order_by("-id").values_list("id", flat=True).first()
            cursor = latest or 0
            # Stream nuovo: parte da adesso, senza storico, nemmeno quello della finestra.
            horizon = timezone.now() - timedelta(seconds=LIVE_FEED_SAFETY_SECONDS)
            seen.update(_window_rows(salon_id, cursor, horizon))
        else:
            # Il cursore è un evento che chi ascolta ha già.
            seen[cursor] = timezone.now()
        yield f"id: {cursor}\nevent: ready\ndata: {json.dumps({'cursor': cursor})}\n\n"
        while time.monotonic() - started < max_seconds:
            if access_check is not None and time.monotonic() - last_check >= STREAM_ACCESS_CHECK_SECONDS:
                last_check = time.monotonic()
                access = access_check()
                if access is None:
                    break  # fuori dal salone o password cambiata: si chiude col `bye`
                prefixes = allowed_prefixes(*access)
            horizon = timezone.now() - timedelta(seconds=LIVE_FEED_SAFETY_SECONDS)
            late_ids = [i for i, _ in _window_rows(salon_id, cursor, horizon) if i not in seen]
            late = list(ActivityLog.objects.filter(id__in=late_ids).order_by("id")) if late_ids else []
            rows = list(
                ActivityLog.objects.filter(salon_id=salon_id, id__gt=cursor).order_by("id")[:100]
            )
            if rows:
                cursor = rows[-1].id
            batch = late + rows  # gli arrivati in ritardo hanno id sotto il cursore
            for e in batch:
                seen[e.id] = e.created_at
            events = [_event_out(e) for e in batch if e.type.startswith(prefixes)] if prefixes else []
            if events:
                yield f"id: {cursor}\nevent: events\ndata: {json.dumps({'cursor': cursor, 'events': events})}\n\n"
                last_ping = time.monotonic()
            elif time.monotonic() - last_ping >= STREAM_KEEPALIVE_SECONDS:
                # Il timer si azzera solo scrivendo qualcosa: con un flusso di
                # eventi che questa persona non vede non partiva mai un ping,
                # gunicorn non si accorgeva del client caduto e il posto restava
                # occupato fino a fine stream.
                yield f": ping {timezone.now().isoformat()}\n\n"
                last_ping = time.monotonic()
            for event_id in [i for i, created in seen.items() if created < horizon]:
                del seen[event_id]
            time.sleep(poll)
        yield f"id: {cursor}\nevent: bye\ndata: {json.dumps({'cursor': cursor})}\n\n"
    finally:
        close_old_connections()


def activity_stream(request):
    info = _redeem_stream_ticket(request.GET.get("ticket", ""))
    if not info:
        return HttpResponseForbidden("ticket non valido o scaduto")
    # I permessi di adesso, non quelli di quando è stato chiesto il biglietto.
    access = stream_access(info)
    if access is None:
        return HttpResponseForbidden("accesso non più valido")
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
    is_owner, scopes = access
    response = StreamingHttpResponse(
        event_generator(
            info["salon_id"],
            after,
            is_owner=is_owner,
            scopes=scopes,
            access_check=lambda: stream_access(info),
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
