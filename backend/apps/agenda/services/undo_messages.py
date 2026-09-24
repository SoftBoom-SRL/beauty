"""I messaggi dopo un «torna indietro» (vedi `undo.perform`).

Sta a parte da `messages` perché rimette a posto anche gli annunci alla lista
d'attesa (`freed_slots`), che a loro volta si appoggiano a `messages`.
"""

from apps.core.services import held_events, supersede_events

from ..models import Appointment
from .freed_slots import _appointment_spans, _slot_knowledge, _sync_freed_slots
from .messages import (
    _CLIENT_EVENTS,
    _TERMINAL_EVENTS,
    _event_payload,
    _never_told,
    _rectify,
    _same_for_client,
    _told_event,
    _when,
    appointment_event_key,
    emit_appointment_event,
)


def revert_held_events(appointment: Appointment, *, fallback_event: str, previous_spans: dict) -> None:
    """Rimette a posto i messaggi dopo un «torna indietro» (vedi `undo.perform`).

    Lo stato ripristinato si confronta con quello che la cliente sa (l'ultimo
    messaggio consegnato, `_told_event`), non con il gesto annullato: i messaggi
    trattenuti possono portare anche gesti PRECEDENTI ancora in vigore. Prima si
    buttavano via tutti: spostata alle 14, poi per sbaglio alle 16, «Indietro»
    → di nuovo alle 14 ma nessun messaggio, e la cliente si presentava alle 10.
    - la cliente non sa niente (conferma ancora in coda) o le era arrivato
      l'annullamento → parte la conferma, una sola, con lo stato ripristinato;
    - per lei non cambia niente → i messaggi trattenuti spariscono;
    - altrimenti → UN messaggio con lo stato ripristinato: `moved` con come
      `old_start` l'orario che conosceva, o `updated`.
    Senza nessuna storia a cui confrontarsi (importato da Yourang, messaggi già
    cancellati) si fa come prima: via i trattenuti, e se non ce n'erano parte
    `fallback_event` ("" = niente: check-in e inizio trattamento restano in
    salone).

    `previous_spans` (orari occupati prima del ripristino) allinea anche gli
    annunci alla lista d'attesa.
    """
    salon = appointment.salon
    held = [
        e for e in held_events(salon, appointment_event_key(appointment.id), lock=True)
        if e.event_type in _CLIENT_EVENTS
    ]
    active = appointment.status not in Appointment.INACTIVE_STATUSES
    knowledge = _slot_knowledge(appointment, previous_spans)
    if not active:
        supersede_events(held)
    else:
        told = _told_event(appointment)
        payload = _event_payload(appointment)
        if told is not None and told.event_type not in _TERMINAL_EVENTS:
            wanted = None
            if not _same_for_client(told.payload, payload):
                if (
                    _when(told.payload.get("start")) != appointment.start
                    or told.payload.get("operator_id") != appointment.operator_id
                ):
                    wanted = "appointment.moved"
                    payload["old_start"] = told.payload.get("start")
                else:
                    wanted = "appointment.updated"
            _rectify(appointment, held, wanted, payload)
        elif told is not None or _never_told(appointment):
            _rectify(appointment, held, "appointment.created", payload)
        elif held or not fallback_event:
            supersede_events(held)
        else:
            emit_appointment_event(appointment, fallback_event)
    _sync_freed_slots(
        appointment,
        previous_spans,
        _appointment_spans(appointment) if active else {},
        knowledge,
    )
