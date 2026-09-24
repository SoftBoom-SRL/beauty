"""Pause in agenda: un blocco che occupa l'operatrice come un appuntamento.

Si scrivono sotto il lock delle prenotazioni, finiscono nel registro attività
e in «torna indietro» come ogni altro gesto dell'agenda.
"""

from django.db import transaction
from django.utils import timezone

from apps.core.services import log_activity

from .. import undo as undo_log
from ..models import Pause, UndoEntry
from .locking import lock_salon


def _pause_label(action: str, pause) -> str:
    """«Pausa spostata · Laura, 13:00» — la frase che compare in «torna indietro»."""
    return f"{action} · {pause.operator.full_name}, {timezone.localtime(pause.start):%H:%M}"


def create_pause(salon, operator, *, start, duration_min: int, note: str, actor=None) -> Pause:
    # Una pausa blocca l'agenda esattamente come un appuntamento: si crea sotto
    # lo stesso lock, altrimenti una prenotazione in corso su quello slot non la
    # vede e le due scritture finiscono sovrapposte.
    with transaction.atomic():
        lock_salon(salon)
        pause = Pause.objects.create(
            salon=salon,
            operator=operator,
            start=start,
            duration_min=duration_min,
            note=note,
        )
    log_activity(
        salon,
        "pause.created",
        f"Pausa per {operator.full_name}",
        actor=actor,
        payload={"pause_id": pause.id, "start": pause.start.isoformat()},
    )
    undo_log.record(
        salon,
        kind=UndoEntry.Kind.PAUSE_CREATE,
        label=_pause_label("Pausa aggiunta", pause),
        actor=actor,
        after={"pauses": [undo_log.pause_snapshot(pause)]},
        created={"pauses": [pause.id]},
    )
    return pause


def update_pause(salon, pause: Pause, operator, *, start, duration_min: int, note: str, actor=None) -> Pause:
    before = undo_log.pause_snapshot(pause)
    with transaction.atomic():
        lock_salon(salon)  # stesso lock delle prenotazioni
        pause.operator = operator
        pause.start = start
        pause.duration_min = duration_min
        pause.note = note
        pause.save(update_fields=["operator", "start", "duration_min", "note", "updated_at"])
    log_activity(
        salon,
        "pause.updated",
        f"Pausa di {pause.operator.full_name} aggiornata",
        actor=actor,
        payload={"pause_id": pause.id, "start": pause.start.isoformat()},
    )
    undo_log.record(
        salon,
        kind=UndoEntry.Kind.PAUSE_UPDATE,
        label=_pause_label("Pausa spostata", pause),
        actor=actor,
        before={"pauses": [before]},
        after={"pauses": [undo_log.pause_snapshot(pause)]},
    )
    return pause


def delete_pause(salon, pause: Pause, *, actor=None) -> None:
    pause_id = pause.id  # dopo il delete l'istanza non ha più id
    operator_name = pause.operator.full_name
    start = pause.start.isoformat()
    label = _pause_label("Pausa rimossa", pause)
    before = undo_log.pause_snapshot(pause)
    pause.delete()
    log_activity(
        salon,
        "pause.deleted",
        f"Pausa di {operator_name} rimossa",
        actor=actor,
        payload={"pause_id": pause_id, "start": start},
    )
    undo_log.record(
        salon,
        kind=UndoEntry.Kind.PAUSE_DELETE,
        label=label,
        actor=actor,
        before={"pauses": [before]},
    )
