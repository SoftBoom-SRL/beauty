"""Cambi di stato di una visita: check-in, inizio trattamento, no-show, annullamento."""

import datetime as dt

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity

from .. import undo as undo_log
from ..models import Appointment, UndoEntry
from .deposits import close_deposit_link_after_commit
from .freed_slots import _appointment_spans, emit_with_freed_slots
from .locking import _lock_and_reload
from .messages import _event_payload, _withdraw_deposit_messages, emit_appointment_event
from .refunds import settle_deposit_refund


@transaction.atomic
def check_in(appointment: Appointment, *, actor=None) -> Appointment:
    _lock_and_reload(appointment)
    # Una seconda postazione con la scheda vecchia riportava «in corso» a
    # «check-in»: lo stato tornava indietro a trattamento avviato e l'evento
    # ripartiva verso Yourang.
    if appointment.status == Appointment.Status.IN_PROGRESS:
        raise HttpError(400, "Il trattamento è già iniziato: il check-in è già stato fatto")
    if appointment.status == Appointment.Status.CHECKED_IN:
        # Già fatto (doppio clic, due postazioni): niente di nuovo da dire né
        # da annullare.
        return appointment
    before = undo_log.appointment_snapshot(appointment)
    appointment.status = Appointment.Status.CHECKED_IN
    appointment.save(update_fields=["status", "updated_at"])
    log_activity(
        appointment.salon,
        "appointment.checked_in",
        f"Check-in di {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id},
    )
    emit_appointment_event(appointment, "appointment.checked_in")
    undo_log.record_appointment_change(
        appointment,
        kind=UndoEntry.Kind.STATUS,
        label=f"Check-in di {appointment.client.full_name}",
        actor=actor,
        before=before,
    )
    return appointment


@transaction.atomic
def start_appointment(appointment: Appointment, *, actor=None) -> Appointment:
    _lock_and_reload(appointment)
    before = undo_log.appointment_snapshot(appointment)
    appointment.status = Appointment.Status.IN_PROGRESS
    appointment.save(update_fields=["status", "updated_at"])
    log_activity(
        appointment.salon,
        "appointment.started",
        f"Trattamento iniziato per {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id},
    )
    undo_log.record_appointment_change(
        appointment,
        kind=UndoEntry.Kind.STATUS,
        label=f"Inizio trattamento di {appointment.client.full_name}",
        actor=actor,
        before=before,
    )
    return appointment


@transaction.atomic
def mark_no_show(appointment: Appointment, *, reason: str = "", actor=None) -> Appointment:
    """No-show: stato + deposito paid->forfeited. L'addebito Stripe è di sales.

    Solo da «confermato» e a orario già iniziato. Prima passava anche con la
    cliente in poltrona (check-in, trattamento in corso) o per la visita di
    domani: caparra trattenuta, un no-show nello storico che pesa sulle regole
    caparra delle prossime prenotazioni e lo slot annunciato come libero.
    """
    _lock_and_reload(appointment)
    if appointment.status != Appointment.Status.CONFIRMED:
        raise HttpError(400, "La cliente è già in salone: non può essere un no-show")
    if appointment.start > timezone.now():
        raise HttpError(
            400, "L'appuntamento non è ancora iniziato: il no-show si segna dopo l'orario d'inizio"
        )
    before = undo_log.appointment_snapshot(appointment)
    appointment.status = Appointment.Status.NO_SHOW
    appointment.cancel_reason = reason or ""
    if appointment.deposit_status == Appointment.DepositStatus.PAID:
        appointment.deposit_status = Appointment.DepositStatus.FORFEITED
    appointment.save(
        update_fields=["status", "cancel_reason", "deposit_status", "updated_at"]
    )
    log_activity(
        appointment.salon,
        "appointment.no_show",
        f"No-show di {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id, "reason": reason},
    )
    if appointment.deposit_status == Appointment.DepositStatus.REQUIRED:
        # Come nell'annullamento: il link della caparra non ha più niente da
        # incassare. Restava pagabile, e la cliente che lo apriva la sera
        # pagava per una visita saltata: il webhook segnava la caparra «da
        # rimborsare» e la restituiva, con le commissioni perse dal salone.
        _withdraw_deposit_messages(appointment)
        close_deposit_link_after_commit(appointment)
    emit_with_freed_slots(
        appointment, "appointment.no_show", {**_event_payload(appointment), "reason": reason},
        before=_appointment_spans(appointment), after={},
    )
    undo_log.record_appointment_change(
        appointment,
        kind=UndoEntry.Kind.NO_SHOW,
        label=f"No-show di {appointment.client.full_name}",
        actor=actor,
        before=before,
    )
    return appointment


def client_notice_ok(appointment: Appointment) -> bool:
    """Vero se mancano almeno CLIENT_MOVE_CANCEL_MIN_HOURS ore alla visita.

    È il preavviso della cliente: dall'app sposta e annulla solo così, e sotto
    la soglia la sua disdetta (anche registrata dalla reception con
    `by_client`) è tardiva.
    """
    return appointment.start - timezone.now() >= dt.timedelta(
        hours=settings.CLIENT_MOVE_CANCEL_MIN_HOURS
    )


def cancel_appointment(
    appointment: Appointment,
    *,
    reason: str = "",
    actor=None,
    by_client: bool = False,
    undoable: bool | None = None,
) -> Appointment:
    """Annulla la visita. `by_client=True` quando è la cliente a disdire: dall'app,
    oppure al telefono o al banco con la reception che lo registra.

    `undoable`: se il gesto entra in «torna indietro». Di serie sì per il
    salone e no per la cliente dall'app (chi sta al banco non deve poter
    rimettere in agenda una visita che la cliente ha disdetto da sé); la
    disdetta registrata dalla reception è un gesto della postazione, e un clic
    sbagliato si deve poter disfare.

    La penale — caparra trattenuta e `cancelled_late`, che alimenta le regole
    caparra dei prossimi appuntamenti — si applica SOLO all'annullamento della
    cliente sotto le CLIENT_MOVE_CANCEL_MIN_HOURS ore. Prima si guardava
    soltanto l'orologio: ma l'app cliente rifiuta già l'annullamento tardivo
    (`client_notice_ok`), quindi «tardivo» capitava solo quando era il SALONE ad
    annullare. Se l'operatrice si ammalava e la reception disdiceva due ore
    prima, la cliente perdeva la caparra e si ritrovava schedata come
    inaffidabile. E siccome l'app manda la cliente in ritardo a «contattare il
    salone», la sua disdetta tardiva arriva proprio alla reception: che la
    registra con `by_client=True` perché la penale valga.

    Deposito pagato: forfeited se tardivo, altrimenti «da rimborsare»; subito
    dopo si tenta il rimborso su Stripe (fuori dalla transazione) e solo se
    riesce lo stato diventa «rimborsato». Prima lo stato veniva scritto
    «rimborsato» senza che nessun rimborso avvenisse.
    """
    with transaction.atomic():
        _lock_and_reload(appointment)
        before = undo_log.appointment_snapshot(appointment)
        late = by_client and not client_notice_ok(appointment)
        appointment.status = Appointment.Status.CANCELLED
        appointment.cancel_reason = reason or ""
        appointment.cancelled_late = late
        if appointment.deposit_status == Appointment.DepositStatus.PAID:
            appointment.deposit_status = (
                Appointment.DepositStatus.FORFEITED
                if late
                else Appointment.DepositStatus.REFUND_DUE
            )
        appointment.save(
            update_fields=[
                "status",
                "cancel_reason",
                "cancelled_late",
                "deposit_status",
                "updated_at",
            ]
        )
        log_activity(
            appointment.salon,
            "appointment.cancelled",
            f"Appuntamento di {appointment.client.full_name} annullato"
            + (" su richiesta della cliente" if by_client else "")
            + (" (tardivo)" if late else ""),
            actor=actor,
            payload={
                "appointment_id": appointment.id,
                "reason": reason,
                "late": late,
                "by_client": by_client,
            },
        )
        unpaid_link = appointment.deposit_status == Appointment.DepositStatus.REQUIRED
        if unpaid_link:
            # Il link della caparra non ha più niente da incassare: quello non
            # ancora partito non parte, quello già inviato si chiude su Stripe.
            _withdraw_deposit_messages(appointment)
            close_deposit_link_after_commit(appointment)
        emit_with_freed_slots(
            appointment,
            "appointment.cancelled",
            {**_event_payload(appointment), "reason": reason, "late": late, "by_client": by_client},
            before=_appointment_spans(appointment),
            after={},
        )
        # L'annullamento della CLIENTE dall'app non entra nello storico della
        # postazione: chi sta al banco non deve poter rimettere in agenda una
        # visita che la cliente ha disdetto (vedi `undoable`).
        if (not by_client) if undoable is None else undoable:
            undo_log.record_appointment_change(
                appointment,
                kind=UndoEntry.Kind.CANCEL,
                label=f"Annullamento dell'appuntamento di {appointment.client.full_name}",
                actor=actor,
                before=before,
            )
    if appointment.deposit_status == Appointment.DepositStatus.REFUND_DUE:
        settle_deposit_refund(appointment, actor=actor)
    return appointment
