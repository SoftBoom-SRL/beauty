"""Slot liberati: cosa dire alla lista d'attesa (`slot.freed`).

Gli orari si trattano come intervalli per operatrice ({operator_id: [(inizio,
fine), …]}, posa compresa: è il tempo in cui il posto resta preso). Si
annuncia ciò che la cliente — e quindi chiunque guardasse l'agenda — sapeva
occupato e non lo è più: la differenza fra l'ultimo stato comunicato e quello
attuale. Così un ritocco di un quarto d'ora libera un quarto d'ora e non
l'intera visita, un cambio di colonna libera l'operatrice di partenza, e
10→14→16 annuncia le 10 (le 14 non le ha mai viste occupate nessuno).
"""

import datetime as dt
from collections import defaultdict

from django.db.models import F, Q
from django.utils import timezone

from apps.core.services import automation_delay_seconds, emit_event, held_events, supersede_events
from common.intervals import merge_intervals

from ..models import Appointment, WaitlistEntry
from .messages import (
    _CLIENT_EVENTS,
    _TERMINAL_EVENTS,
    _client_aware,
    _never_told,
    _told_event,
    _when,
    appointment_event_key,
    emit_appointment_event,
    slot_event_key,
)


# Un pezzo di agenda liberato più corto di così non si annuncia: non ci sta
# niente, ed è di solito il resto di un orario tagliato su «adesso».
MIN_FREED_SLOT_MINUTES = 5


def suppress_slot_events(salon, appointment_id) -> int:
    """Toglie di mezzo l'annuncio alla lista d'attesa, se non è ancora partito.

    Serve quando lo slot in realtà non si è liberato: l'appuntamento è tornato
    dov'era, oppure non è mai esistito davvero.
    """
    return supersede_events(list(held_events(salon, slot_event_key(appointment_id), lock=True)))


def _chain_spans(start, chain) -> dict:
    """Intervalli occupati da una catena di servizi: chain = [(operator_id, attivo, posa)]."""
    spans: dict[int, list] = defaultdict(list)
    cursor = start
    for operator_id, active_min, soak_min in chain:
        end = cursor + dt.timedelta(minutes=(active_min or 0) + (soak_min or 0))
        if operator_id and end > cursor:
            spans[operator_id].append((cursor, end))
        cursor = end
    return {op: merge_intervals(intervals) for op, intervals in spans.items()}


def _appointment_spans(appointment: Appointment) -> dict:
    items = appointment.items.all().order_by("order", "id")
    return _chain_spans(
        appointment.start, [(it.operator_id, it.duration_min, it.soak_min) for it in items]
    )


def _payload_spans(payload: dict) -> dict:
    """Gli orari che un messaggio consegnato dava per occupati."""
    start = _when(payload.get("start"))
    if start is None:
        return {}
    services = payload.get("services") or []
    if services and all("operator_id" in s for s in services):
        return _chain_spans(
            start, [(s["operator_id"], s.get("duration_min"), s.get("soak_min")) for s in services]
        )
    # messaggio di prima che portasse operatrici e pose: tutta la visita
    end, operator_id = _when(payload.get("end")), payload.get("operator_id")
    if not operator_id or end is None or end <= start:
        return {}
    return {operator_id: [(start, end)]}


def _spans_minus(spans: dict, other: dict) -> dict:
    out = {}
    for op, intervals in spans.items():
        pieces = list(intervals)
        for cut_start, cut_end in other.get(op, ()):
            pieces = [
                piece
                for start, end in pieces
                for piece in ((start, min(end, cut_start)), (max(start, cut_end), end))
                if piece[0] < piece[1]
            ]
        if pieces:
            out[op] = merge_intervals(pieces)
    return out


def _spans_union(spans: dict, other: dict) -> dict:
    out = {op: list(intervals) for op, intervals in spans.items()}
    for op, intervals in other.items():
        out.setdefault(op, []).extend(intervals)
    return {op: merge_intervals(intervals) for op, intervals in out.items()}


def _slot_piece(event) -> tuple:
    start = _when(event.payload.get("start"))
    return (
        event.payload.get("operator_id"),
        start,
        start + dt.timedelta(minutes=int(event.payload.get("duration_min") or 0)) if start else None,
    )


def _next_minute():
    """Adesso, arrotondato al minuto successivo."""
    now = timezone.now()
    rounded = now.replace(second=0, microsecond=0)
    return rounded if rounded == now else rounded + dt.timedelta(minutes=1)


def _emit_freed_slot(appointment: Appointment, operator_id, start, end, *, since=None, services_before=()):
    """Accoda (trattenuto) `slot.freed` per un pezzo di agenda liberato.

    Compatibili: voci attive per un servizio della visita, con quell'operatrice
    o nessuna, e un servizio che nel pezzo ci sta (posa compresa). Con `since`
    solo chi si è messa in lista dopo quell'istante; se non c'è nessuno non
    parte niente. `services_before` sono i servizi che la visita aveva prima
    del gesto: togliendo o staccando la piega, chi aspettava proprio una piega
    restava fuori dai match, perché la visita non l'aveva più.
    """
    minutes = int((end - start).total_seconds() // 60)
    service_ids = {item.service_id for item in appointment.items.all()} | set(services_before)
    matching = (
        WaitlistEntry.objects.filter(
            salon=appointment.salon,
            status=WaitlistEntry.Status.ACTIVE,
            service_id__in=service_ids,
        )
        .filter(Q(operator__isnull=True) | Q(operator_id=operator_id))
        .annotate(needed=F("service__duration_min") + F("service__soak_min"))
        .filter(needed__lte=minutes)
    )
    if since is not None:
        matching = matching.filter(created_at__gte=since)
    ids = list(matching.values_list("id", flat=True))
    if since is not None and not ids:
        return None
    payload = {
        "appointment_id": appointment.id,
        "start": start.isoformat(),
        # Tempo che si libera per la cliente successiva: lavoro attivo E posa.
        # Con la sola fase attiva un colore da 30' di lavoro e 60' di posa
        # liberava «30 minuti», e alla lista d'attesa venivano proposti servizi
        # che in quel buco non entravano (o non venivano proposti quelli che ci
        # stavano).
        "duration_min": minutes,
        "operator_id": operator_id,
        "matching_waitlist": ids,
    }
    return emit_event(
        appointment.salon,
        "slot.freed",
        payload,
        delay_seconds=max(automation_delay_seconds(appointment.salon), 0),
        coalesce_key=slot_event_key(appointment.id),
    )


def _slot_knowledge(appointment: Appointment, before: dict) -> tuple[dict, object]:
    """Cosa si sapeva occupato PRIMA del gesto: (orari, da quando conta chi aspetta).

    Va chiesto prima di emettere il messaggio del gesto: col ritardo spento
    quel messaggio è «già consegnato» un istante dopo, e l'annullamento
    appena accodato diventava ciò che la cliente sa — niente più slot da
    annunciare.
    """
    told = _told_event(appointment)
    if told is not None:
        return ({} if told.event_type in _TERMINAL_EVENTS else _payload_spans(told.payload)), None
    if _never_told(appointment):
        return before, (None if _client_aware(appointment) else appointment.created_at)
    if any(
        e.event_type in _CLIENT_EVENTS
        for e in held_events(appointment.salon, appointment_event_key(appointment.id))
    ):
        # Nessun messaggio consegnato ma un gesto ancora trattenuto (appuntamento
        # importato, storico cancellato): l'orario di prima di QUESTO gesto non
        # l'ha mai saputo nessuno — è quello del gesto trattenuto.
        return {}, None
    return before, None


def _sync_freed_slots(
    appointment: Appointment, before: dict, after: dict, knowledge: tuple | None = None, *, services_before=()
) -> None:
    """Allinea gli annunci `slot.freed` trattenuti a ciò che si è liberato davvero.

    `before`/`after`: orari occupati dall'appuntamento prima e dopo il gesto
    (`after` vuoto se è stato annullato o è sparito); `knowledge` è
    `_slot_knowledge`, chiesto prima di emettere il messaggio del gesto;
    `services_before`, i servizi della visita prima del gesto, entrano nei
    match degli annunci nuovi (vedi `_emit_freed_slot`). Un
    annuncio trattenuto
    resta finché il suo orario non torna occupato — prima il gesto successivo
    lo sostituiva con la posizione intermedia, e l'orario davvero liberato non
    veniva più proposto a nessuno —; se ne aggiungono i pezzi di `before` che
    la cliente sapeva occupati. Gli orari già passati non si annunciano.

    Se la cliente non ha mai ricevuto niente, lo slot «non si è mai occupato»
    per la lista d'attesa, tranne che per chi si è messa in lista DOPO la
    prenotazione: quella lo ha visto occupato, e va avvisata.
    """
    salon = appointment.salon
    known, since = knowledge if knowledge is not None else _slot_knowledge(appointment, before)
    held = [
        e for e in held_events(salon, slot_event_key(appointment.id), lock=True)
        if e.event_type == "slot.freed"
    ]
    announced = {}
    for event in held:
        operator_id, start, end = _slot_piece(event)
        if operator_id and start and end and end > start:
            announced = _spans_union(announced, {operator_id: [(start, end)]})
    vacated = _spans_minus(before, after)
    announced = _spans_union(announced, _spans_minus(vacated, _spans_minus(vacated, known)))
    wanted = _spans_minus(announced, after)
    # Niente annunci per orari già finiti (un no-show segnato a metà mattina
    # proponeva alla lista d'attesa una visita già iniziata): si taglia su adesso.
    now = _next_minute()
    pieces = [
        (op, max(start, now), end)
        for op, intervals in sorted(wanted.items())
        for start, end in intervals
        if end - max(start, now) >= dt.timedelta(minutes=MIN_FREED_SLOT_MINUTES)
    ]
    kept = set()
    for piece in pieces:
        same = next((e for e in held if e.id not in kept and _slot_piece(e) == piece), None)
        if same is not None:
            kept.add(same.id)
        else:
            _emit_freed_slot(appointment, *piece, since=since, services_before=services_before)
    supersede_events([e for e in held if e.id not in kept])


def emit_with_freed_slots(
    appointment: Appointment,
    event_type: str,
    payload: dict | None = None,
    *,
    before: dict,
    after: dict,
    services_before=(),
):
    """Il messaggio di un gesto alla cliente, poi gli annunci alla lista d'attesa.

    L'ordine è quello che conta: ciò che si sapeva occupato (`_slot_knowledge`)
    va chiesto PRIMA di emettere il messaggio del gesto, perché col ritardo
    spento quel messaggio è «già consegnato» un istante dopo e diventerebbe ciò
    che la cliente sa. `before`/`after` sono gli orari occupati
    dall'appuntamento prima e dopo il gesto ({} se si è liberato del tutto);
    `services_before` i servizi che aveva prima, quando il gesto ne toglie
    (modifica, stacco). Ritorna l'evento del gesto, come `emit_appointment_event`.
    """
    knowledge = _slot_knowledge(appointment, before)
    event = emit_appointment_event(appointment, event_type, payload)
    _sync_freed_slots(appointment, before, after, knowledge, services_before=services_before)
    return event


def free_slot_event(appointment: Appointment, *, start=None, operator_id=None):
    """Annuncia alla lista d'attesa come liberata l'intera visita (o da `start`, per `operator_id`).

    Resta per chi la chiama da fuori dall'agenda: i gesti dell'agenda passano da
    `_sync_freed_slots` (di solito con `emit_with_freed_slots`), che annuncia
    solo ciò che si è liberato davvero. Anche
    qui l'orario si taglia su adesso (una visita già finita non si propone a
    nessuno) e sostituisce gli annunci ancora trattenuti dello stesso
    appuntamento. Ritorna l'evento, o None se non c'è più niente da annunciare.
    """
    start = start or appointment.start
    operator_id = operator_id or appointment.operator_id
    total = sum(item.duration_min + item.soak_min for item in appointment.items.all())
    end = start + dt.timedelta(minutes=total)
    suppress_slot_events(appointment.salon, appointment.id)
    begin = max(start, _next_minute())
    if end - begin < dt.timedelta(minutes=MIN_FREED_SLOT_MINUTES):
        return None
    return _emit_freed_slot(appointment, operator_id, begin, end)
