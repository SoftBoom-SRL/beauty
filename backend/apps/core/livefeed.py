"""Feed live della dashboard: quali eventi del registro attività arrivano a chi, e in che forma.

Gli eventi arrivano per due strade: lo stream SSE (core.views) e il polling di
riserva ogni 30 secondi (GET /api/core/activity/feed, core.api). La mappa dei
permessi e la finestra di sicurezza stavano in views.py, e il polling ne
importava i nomi a metà di api.py; l'evento consegnato era scritto due volte,
una per strada. Due elenchi separati avevano già perso `settings.` e
`client_category.` solo lato HTTP. Qui c'è tutto una volta sola, con il
polling (`feed_page`); il ciclo dello stream resta in views.py, dove i test ne
regolano i tempi.
"""

from datetime import timedelta

from django.db.models import Q
from django.utils import timezone

from .models import ActivityLog

# Finestra di sicurezza del feed live. Su Postgres l'id si assegna all'INSERT
# ma la riga si vede al COMMIT: una transazione che prendeva l'id N e committava
# dopo N+1 veniva scavalcata dal cursore, e l'evento non arrivava a nessuna
# postazione, nemmeno col polling di coerenza. Stream e polling rileggono quindi
# anche gli eventi con id sotto il cursore scritti negli ultimi secondi (una
# transazione più lunga è un'eccezione). Il prezzo è qualche riconsegna, che la
# dashboard scarta per id (contratto C20).
LIVE_FEED_SAFETY_SECONDS = 15
# Eventi al massimo per ogni risposta del polling.
LIVE_FEED_LIMIT = 50

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


def event_dict(e: ActivityLog) -> dict:
    """Un evento del registro com'è consegnato alla dashboard, dal polling e dallo stream."""
    return {
        "id": e.id,
        "type": e.type,
        "summary": e.summary,
        "actor_id": e.actor_id,
        "actor_name": e.actor_name,
        "payload": e.payload,
        "created_at": e.created_at,
    }


def feed_page(salon, after: int | None, *, is_owner: bool, scopes) -> dict:
    """Una risposta del polling: il cursore e gli eventi dopo `after` che chi chiede può vedere.

    È l'algoritmo di GET /api/core/activity/feed (vedi il suo docstring): senza
    `after` solo il cursore corrente; con `after` gli eventi successivi più
    quelli comparsi da poco sotto il cursore (LIVE_FEED_SAFETY_SECONDS).
    """
    qs = ActivityLog.objects.filter(salon=salon)
    latest = qs.order_by("-id").values_list("id", flat=True).first() or 0
    if after is None:
        return {"cursor": latest, "events": []}

    prefixes = allowed_prefixes(is_owner, scopes)
    events = []
    if prefixes:
        prefix_q = Q()
        for prefix in prefixes:
            prefix_q |= Q(type__startswith=prefix)
        events = list(
            qs.filter(id__gt=after).filter(prefix_q).order_by("id")[:LIVE_FEED_LIMIT]
        )
        # Un id sotto il cursore che si vede solo ora è una transazione che ha
        # committato dopo una successiva: senza rileggerli il cursore l'aveva già
        # scavalcato e l'evento non arrivava più a nessuno. Il cursore stesso è
        # un evento che il client ha già.
        horizon = timezone.now() - timedelta(seconds=LIVE_FEED_SAFETY_SECONDS)
        late = list(
            qs.filter(id__lt=after, created_at__gte=horizon)
            .filter(prefix_q)
            .order_by("id")[:LIVE_FEED_LIMIT]
        )
        events = late + events
    # Il cursore avanza sempre fino all'ultimo id visto (anche se filtrato via),
    # così un evento amministrativo non viene richiesto all'infinito.
    scanned = qs.filter(id__gt=after).order_by("id").values_list("id", flat=True)[:LIVE_FEED_LIMIT]
    scanned = list(scanned)
    cursor = max([after] + scanned + [e.id for e in events])
    if len(scanned) < LIVE_FEED_LIMIT:
        cursor = max(cursor, latest)
    return {
        "cursor": cursor,
        "events": [event_dict(e) for e in events],
    }
