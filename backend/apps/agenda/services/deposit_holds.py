"""Caparra con scadenza: sollecito e rilascio automatico dello slot.

Una caparra non pagata entro `SalonSettings.deposit_hold_minutes` libera il
posto (l'appuntamento resta fra i «da richiamare» e si può ripristinare).
`process_deposit_holds` gira a ogni lettura dell'agenda e dal comando omonimo
per il cron. Qui anche l'incasso della caparra al banco.
"""

import datetime as dt
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity

from ..models import Appointment
from .deposits import close_deposit_link_after_commit
from .freed_slots import _appointment_spans, _sync_freed_slots, emit_with_freed_slots
from .locking import _lock_and_reload, _lock_row, lock_salon
from .messages import _event_payload, _withdraw_deposit_messages, appointment_event_key, deposit_paid_payload, emit_appointment_event
from .resolution import _validate_segments


def _hold_settings(salon) -> tuple[int, int]:
    salon_settings = getattr(salon, "settings", None)
    hold = int(getattr(salon_settings, "deposit_hold_minutes", 0) or 0)
    reminder = int(getattr(salon_settings, "deposit_reminder_minutes", 0) or 0)
    return hold, reminder


def schedule_deposit_hold(appointment: Appointment) -> None:
    """Fissa la scadenza della caparra (deposit_due_at) se il salone la prevede.

    Solo se il salone può davvero incassare online: senza pagamenti attivi non
    parte nessun link (ensure_deposit_link esce in silenzio), nessuno ha modo di
    pagare, e allo scadere del termine OGNI prenotazione con caparra si
    annullava da sola avvisando la cliente. Dove si incassa al banco la caparra
    si registra con `mark_deposit_cashed`.

    La scadenza non supera mai l'inizio della visita, e una visita già iniziata
    non ne prende nessuna: con un'ora di hold, la cliente prenotata alle 09:50
    per le 10:00 si vedeva liberare il posto alle 10:50, mentre era sotto le
    mani dell'operatrice e nessuno aveva premuto check-in.
    """
    from apps.sales.stripe_service import payments_enabled  # lazy

    if appointment.deposit_status != Appointment.DepositStatus.REQUIRED:
        return
    if not payments_enabled(appointment.salon):
        return
    hold, _ = _hold_settings(appointment.salon)
    if hold <= 0:
        return
    now = timezone.now()
    if appointment.start <= now:
        return
    # Il termine intero resta scritto a parte (`deposit_hold_until`): se la
    # visita viene spostata, la scadenza si ricalcola dal nuovo inizio invece
    # di restare tagliata su quello vecchio (vedi `_effective_deposit_due`).
    appointment.deposit_hold_until = now + dt.timedelta(minutes=hold)
    appointment.deposit_due_at = min(appointment.deposit_hold_until, appointment.start)
    appointment.deposit_reminder_sent_at = None
    appointment.save(
        update_fields=["deposit_due_at", "deposit_hold_until", "deposit_reminder_sent_at", "updated_at"]
    )


def clear_deposit_hold(appointment: Appointment) -> None:
    """La caparra è arrivata (o non c'è modo di pagarla): niente più scadenza né rilascio."""
    if appointment.deposit_due_at is None and appointment.deposit_hold_until is None:
        return
    appointment.deposit_due_at = None
    appointment.deposit_hold_until = None
    appointment.save(update_fields=["deposit_due_at", "deposit_hold_until", "updated_at"])


def _effective_deposit_due(appointment: Appointment, hold: int):
    """Scadenza vera della caparra: fine del termine, ma mai oltre l'inizio attuale.

    `deposit_due_at` è tagliato sull'inizio che la visita aveva quando il
    termine è stato fissato. Spostandola più avanti restava la scadenza di
    prima: la visita spostata a martedì veniva liberata all'ora del vecchio
    appuntamento, con «posto liberato» alla cliente (02-04). Per le caparre di
    prima di `deposit_hold_until` il termine intero si ricostruisce dalla
    creazione, senza mai anticipare la scadenza salvata.
    """
    hold_until = appointment.deposit_hold_until
    if hold_until is None:
        hold_until = max(
            appointment.deposit_due_at,
            appointment.created_at + dt.timedelta(minutes=hold),
        )
    return min(hold_until, appointment.start)


def realign_deposit_due(appointment: Appointment) -> bool:
    """La scadenza della caparra segue l'inizio attuale della visita, con la regola del rilascio.

    Per chi cambia l'inizio (spostamento, stacco del primo servizio, «torna
    indietro»): la scadenza non supera mai l'inizio, e restava quella di
    prima finché `process_deposit_holds` non la riallineava, cioè alla lettura
    dopo dell'agenda o col cron, quando il messaggio del gesto era già
    composto con la scadenza sbagliata. Cambia solo l'istanza: ritorna True se
    `deposit_due_at` è cambiata, e chi chiama la aggiunge ai campi che scrive.
    """
    if (
        appointment.deposit_status != Appointment.DepositStatus.REQUIRED
        or appointment.deposit_due_at is None
    ):
        return False
    hold, _ = _hold_settings(appointment.salon)
    if hold <= 0:
        return False
    due = _effective_deposit_due(appointment, hold)
    if due == appointment.deposit_due_at:
        return False
    appointment.deposit_due_at = due
    return True


@transaction.atomic
def mark_deposit_cashed(appointment: Appointment, *, method: str = "cash", actor=None) -> Appointment:
    """La caparra è stata incassata in salone (contanti o POS al banco).

    Era l'anello mancante: l'unico punto che scriveva «pagata» era il webhook
    Stripe, quindi chi incassa al banco vedeva comunque scadere il termine e il
    posto liberarsi. Qui la caparra diventa pagata, la scadenza sparisce e
    l'incasso entra in cassa (lo registra `sales`, che sa di scontrini e metodi
    di pagamento) — così il denaro non resta fuori dai conti di giornata.
    """
    _lock_and_reload(appointment)
    if appointment.deposit_status != Appointment.DepositStatus.REQUIRED:
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di pagamento")
    if Decimal(str(appointment.deposit_amount or 0)) <= 0:
        raise HttpError(400, "Nessuna caparra da incassare su questo appuntamento")

    appointment.deposit_status = Appointment.DepositStatus.PAID
    appointment.save(update_fields=["deposit_status", "updated_at"])
    clear_deposit_hold(appointment)

    from apps.sales.services import record_deposit_cashed  # lazy

    record_deposit_cashed(appointment.salon, appointment, method=method, actor=actor)

    log_activity(
        appointment.salon,
        "deposit.cashed",
        f"Caparra incassata in salone — {appointment.client.full_name}",
        actor=actor,
        payload={
            "appointment_id": appointment.id,
            "amount": str(appointment.deposit_amount),
            "method": method,
        },
    )
    emit_event(
        appointment.salon,
        "deposit.paid",
        deposit_paid_payload(appointment),
        coalesce_key=appointment_event_key(appointment.id),
    )
    return appointment


@transaction.atomic
def release_for_unpaid_deposit(appointment: Appointment) -> Appointment:
    """Libera lo slot di un appuntamento la cui caparra non è arrivata in tempo.

    Lo stato diventa «annullato» ma resta la traccia (`auto_released`): compare
    fra i «da richiamare» in agenda, l'operatrice decide se telefonare o
    ripristinare. Emette `appointment.released_unpaid` (messaggio alla cliente)
    e `slot.freed` per la lista d'attesa.

    Il rilascio passa dalla fusione come evento finale: partiva per conto suo,
    e uno spostamento trattenuto un istante prima arrivava a Yourang dopo
    «posto liberato», riportando in vita l'appuntamento alla nuova ora. Il link
    di pagamento si chiude su Stripe: la cliente lo pagava anche a posto già
    liberato.
    """
    before_spans = _appointment_spans(appointment)
    appointment.status = Appointment.Status.CANCELLED
    appointment.cancel_reason = "Caparra non versata entro il termine"
    appointment.cancelled_late = False
    appointment.auto_released = True
    appointment.save(
        update_fields=[
            "status",
            "cancel_reason",
            "cancelled_late",
            "auto_released",
            "updated_at",
        ]
    )
    log_activity(
        appointment.salon,
        "appointment.released",
        f"Slot liberato: caparra non versata — {appointment.client.full_name}",
        payload={
            "appointment_id": appointment.id,
            "client_id": appointment.client_id,
            "deposit_amount": str(appointment.deposit_amount),
            "due_at": appointment.deposit_due_at.isoformat() if appointment.deposit_due_at else None,
        },
    )
    _withdraw_deposit_messages(appointment)
    emit_with_freed_slots(appointment, "appointment.released_unpaid", before=before_spans, after={})
    close_deposit_link_after_commit(appointment)
    return appointment


def process_deposit_holds(salon, *, now=None) -> dict:
    """Solleciti e rilasci per le caparre scadute del salone. Ritorna {reminded, released}.

    Viene chiamata a ogni lettura dell'agenda (economica: un filtro indicizzato)
    e dal comando `process_deposit_holds` per il cron: così funziona anche se
    nessuno ha la dashboard aperta.
    """
    now = now or timezone.now()
    hold, reminder = _hold_settings(salon)
    result = {"reminded": 0, "released": 0}
    if hold <= 0:
        return result
    # Una caparra «richiesta» a 0 € non c'è: le righe rimaste così da prima che
    # l'azzeramento la portasse a «nessuna» (vedi deposits.shrink_deposit_to_total)
    # si liberavano allo scadere, con «posto liberato, caparra non versata» alla
    # cliente, e prendevano anche il sollecito.
    pending = (
        Appointment.objects.filter(
            salon=salon,
            status=Appointment.Status.CONFIRMED,
            deposit_status=Appointment.DepositStatus.REQUIRED,
            deposit_amount__gt=0,
            deposit_due_at__isnull=False,
        )
        .select_related("client", "salon")
        .order_by("deposit_due_at")
    )
    # Ogni riga viene "presa" prima di agirci sopra. La funzione parte a ogni
    # lettura dell'agenda: con due postazioni aperte, due richieste simultanee
    # trovavano lo stesso appuntamento scaduto e la cliente riceveva due volte
    # l'avviso che il suo posto è stato liberato.
    for appointment in pending:
        if appointment.start <= now:
            # La visita è già cominciata: la cliente è in salone, il posto non
            # si libera e soprattutto non le si scrive che l'appuntamento è
            # saltato. La caparra resta da incassare al banco.
            continue
        due = _effective_deposit_due(appointment, hold)
        if due != appointment.deposit_due_at:
            # Visita spostata: la scadenza mostrata in agenda (e nel messaggio
            # alla cliente) si allinea. Solo quella colonna, senza toccare
            # `updated_at`: è un dato derivato, non una modifica di qualcuno.
            Appointment.objects.filter(
                pk=appointment.pk, deposit_due_at=appointment.deposit_due_at
            ).update(deposit_due_at=due)
            appointment.deposit_due_at = due
        if appointment.deposit_due_at <= now:
            with transaction.atomic():
                # Prima il salone, poi la sola riga dell'appuntamento: il join
                # FOR UPDATE bloccava anche cliente e salone DOPO l'appuntamento,
                # l'ordine opposto a quello di chi modifica l'agenda (18-08).
                lock_salon(salon)
                locked = (
                    Appointment.objects.select_for_update(of=("self",))
                    .filter(
                        pk=appointment.pk,
                        status=Appointment.Status.CONFIRMED,
                        deposit_status=Appointment.DepositStatus.REQUIRED,
                    )
                    .select_related("client", "salon")
                    .first()
                )
                if locked is None:  # già liberato da un'altra richiesta
                    continue
                release_for_unpaid_deposit(locked)
                result["released"] += 1
            continue
        if reminder and appointment.deposit_reminder_sent_at is None:
            # «Il sollecito parte dopo `deposit_reminder_minutes`» dalla
            # prenotazione: si conta dal termine intero, non dalla scadenza
            # tagliata sull'inizio. Con quella, per una prenotazione a ridosso
            # il sollecito cadeva nel passato e partiva insieme al link (02-16).
            hold_until = appointment.deposit_hold_until or appointment.deposit_due_at
            remind_at = hold_until - dt.timedelta(minutes=max(hold - reminder, 0))
            if remind_at >= appointment.deposit_due_at:
                continue  # arriverebbe a termine già scaduto: niente sollecito
            if remind_at <= now:
                # UPDATE condizionale: chi lo vince manda il sollecito, gli altri
                # vedono 0 righe aggiornate e non mandano niente.
                claimed = Appointment.objects.filter(
                    pk=appointment.pk, deposit_reminder_sent_at__isnull=True
                ).update(deposit_reminder_sent_at=now, updated_at=now)
                if not claimed:
                    continue
                appointment.deposit_reminder_sent_at = now
                if appointment.deposit_payment_link:
                    from apps.sales.stripe_service import refresh_deposit_link  # lazy

                    # Il sollecito porta il link: a sessione già chiusa da
                    # Stripe (24 ore al massimo) se ne apre una nuova. Se non ci
                    # si riesce la scadenza è sospesa e un messaggio con una
                    # pagina morta non serve a nessuno.
                    if not refresh_deposit_link(appointment):
                        continue
                emit_event(
                    salon,
                    "deposit.reminder",
                    _event_payload(appointment),
                    coalesce_key=appointment_event_key(appointment.id),
                )
                log_activity(
                    salon,
                    "deposit.reminder",
                    f"Sollecito caparra — {appointment.client.full_name}",
                    payload={"appointment_id": appointment.id, "due_at": appointment.deposit_due_at.isoformat()},
                )
                result["reminded"] += 1
    return result


def released_appointments(salon, *, days: int = 30):
    """Appuntamenti liberati automaticamente di recente: la lista «da richiamare»."""
    since = timezone.now() - dt.timedelta(days=days)
    return (
        Appointment.objects.filter(
            salon=salon,
            status=Appointment.Status.CANCELLED,
            auto_released=True,
            updated_at__gte=since,
        )
        .select_related("client", "operator")
        .prefetch_related("items__service", "items__operator")
        .order_by("-updated_at")
    )


@transaction.atomic
def restore_released(appointment: Appointment, *, actor=None, force: bool = False) -> Appointment:
    """Rimette in agenda un appuntamento liberato per caparra non pagata (se lo slot è ancora libero).

    Lock e rilettura PRIMA di decidere: si decideva sulla copia entrata con la
    richiesta e si riscriveva tutta la riga. Due operatrici che cliccavano
    «Ripristina» insieme mandavano due conferme alla cliente, e se nel frattempo
    la caparra era stata pagata e rimborsata il save riportava «richiesta»
    cancellando l'id del PaymentIntent — con Stripe che aveva già restituito i
    soldi e il gestionale che rimandava il link.
    """
    _lock_row(appointment)
    if not (appointment.status == Appointment.Status.CANCELLED and appointment.auto_released):
        raise HttpError(400, "L'appuntamento non è stato liberato automaticamente")
    items = list(appointment.items.select_related("operator"))
    if not items:
        raise HttpError(400, "Appuntamento senza servizi")
    if not force:
        _validate_segments(
            appointment.salon,
            appointment.start,
            [(it.duration_min, it.soak_min, it.operator) for it in items],
            exclude_appointment_id=appointment.id,
        )
    appointment.status = Appointment.Status.CONFIRMED
    appointment.auto_released = False
    appointment.cancel_reason = ""
    appointment.forced = appointment.forced or force
    appointment.deposit_reminder_sent_at = None
    # Il link di pagamento vecchio porta la scadenza della caparra di prima:
    # riaprendolo la cliente trovava una pagina già chiusa da Stripe, non poteva
    # pagare e lo slot si liberava una seconda volta. Svuotando l'indirizzo (ma
    # non l'id di sessione) il prossimo `ensure_deposit_link` chiude la vecchia
    # sessione e ne manda una nuova.
    appointment.deposit_payment_link = ""
    appointment.save(
        update_fields=[
            "status",
            "auto_released",
            "cancel_reason",
            "forced",
            "deposit_reminder_sent_at",
            "deposit_payment_link",
            "updated_at",
        ]
    )
    schedule_deposit_hold(appointment)
    log_activity(
        appointment.salon,
        "appointment.restored",
        f"Appuntamento di {appointment.client.full_name} ripristinato",
        actor=actor,
        payload={"appointment_id": appointment.id, "forced": force},
    )
    emit_appointment_event(appointment, "appointment.created")
    # L'orario è di nuovo occupato: l'annuncio del rilascio, se non è ancora
    # partito, non parte più.
    _sync_freed_slots(appointment, {}, _appointment_spans(appointment))
    return appointment
