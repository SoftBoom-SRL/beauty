"""Eventi verso Yourang: ritardo di sicurezza e fusione.

Al banco si corregge quello che si è appena fatto: si inserisce la cliente,
la si guarda in griglia e la si sposta di mezz'ora. Se l'evento partisse
nell'istante stesso, alla cliente arriverebbero due messaggi a venti secondi
di distanza — la conferma sbagliata e poi lo spostamento. Gli eventi
dell'appuntamento vengono quindi TRATTENUTI qualche secondo
(`SalonSettings.automation_delay_seconds`, 30 di serie) e quelli ancora
trattenuti sullo stesso appuntamento si fondono in uno solo, con i dati
dell'ultimo gesto. È anche ciò che rende «torna indietro» silenzioso: annullare
entro la finestra non manda niente a nessuno.

Ciò che conta è quello che la cliente SA: l'ultimo messaggio consegnato (o
ormai in consegna) sull'appuntamento, vedi `_told_event`. Una fusione o un
«torna indietro» non devono mai far tacere una modifica che resta in vigore
rispetto a quel messaggio, né raccontarle una modifica che per lei non c'è.

Qui stanno anche il payload standard dei messaggi (`_event_payload`) e il
ritiro dei messaggi della caparra non ancora partiti.
"""

import datetime as dt

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import OutboxEvent
from apps.core.services import automation_delay_seconds, emit_event, held_events, supersede_events

from ..models import Appointment


def _event_payload(appointment: Appointment) -> dict:
    """Payload standard per Yourang: id + dati utili (nome, telefono, lingua, orari ISO).

    Di ogni servizio anche posa e operatrice: a Yourang dicono chi fa cosa, e
    all'agenda permettono di ricostruire da un messaggio già consegnato quali
    orari la cliente — e chi è in lista d'attesa — sa occupati.

    `whatsapp_reminders` e `wa` sono le preferenze della cliente: con
    `whatsapp_reminders` falso non vuole conferme né promemoria degli
    appuntamenti su WhatsApp (l'interruttore «Promemoria WhatsApp» dell'app e
    della scheda Consensi, che finora non leggeva nessuno), con `wa` falso
    WhatsApp non lo usa. L'evento parte lo stesso: Yourang ha bisogno di sapere
    dove sta l'appuntamento, e tacere uno spostamento farebbe partire un suo
    promemoria all'ora vecchia. Il canale lo sceglie Yourang, rispettandole.
    """
    client = appointment.client
    return {
        "appointment_id": appointment.id,
        "client_id": client.id,
        "client_name": client.full_name,
        "phone": client.phone,
        "lang": client.lang,
        "whatsapp_reminders": client.whatsapp_reminders,
        "wa": client.wa,
        "start": appointment.start.isoformat(),
        "end": appointment.end.isoformat(),
        "operator_id": appointment.operator_id,
        "services": [
            {
                "id": item.service_id,
                "name": item.service.name_it,
                "duration_min": item.duration_min,
                "soak_min": item.soak_min,
                "operator_id": item.operator_id,
            }
            for item in appointment.items.select_related("service")
        ],
        "total_price": str(appointment.total_price),
        "deposit_amount": str(appointment.deposit_amount),
        "deposit_status": appointment.deposit_status,
        "deposit_due_at": appointment.deposit_due_at.isoformat() if appointment.deposit_due_at else None,
        "deposit_payment_link": appointment.deposit_payment_link or "",
    }


def deposit_paid_payload(appointment: Appointment) -> dict:
    """Payload di `deposit.paid`: quello standard più `amount`, la caparra arrivata.

    Lo emettono il pagamento online (webhook Stripe) e l'incasso al banco, e
    deve avere la stessa forma. Il webhook lo scriveva a mano senza
    `whatsapp_reminders` e `wa`: per le caparre pagate online Yourang non
    sapeva se la cliente aveva spento i promemoria WhatsApp, e poteva scriverle
    su un canale che lei aveva rifiutato. L'incasso al banco, invece, non
    portava `amount`.
    """
    return {**_event_payload(appointment), "amount": str(appointment.deposit_amount)}


# Quando due eventi si fondono resta il più alto di questa scala: la conferma di
# un appuntamento appena nato batte lo spostamento, perché la cliente non ha
# ancora ricevuto nulla e quello che le serve è la conferma, con l'orario buono.
_EVENT_PRIORITY = {
    "appointment.created": 40,
    "appointment.moved": 30,
    "appointment.updated": 20,
    "appointment.checked_in": 10,
}
# Eventi finali: azzerano quelli trattenuti invece di fondersi con loro. Il
# rilascio per caparra non pagata è uno di loro: partiva per conto suo, e uno
# spostamento trattenuto un istante prima arrivava a Yourang DOPO «posto
# liberato», facendo rivivere alla nuova ora un appuntamento annullato.
_TERMINAL_EVENTS = ("appointment.cancelled", "appointment.no_show", "appointment.released_unpaid")
# Tutto ciò che racconta l'appuntamento ALLA CLIENTE, e che quindi si fonde.
# `slot.freed` parla alla lista d'attesa: è un altro discorso e un'altra chiave.
_CLIENT_EVENTS = tuple(_EVENT_PRIORITY) + _TERMINAL_EVENTS
# La trattenuta si allunga a ogni correzione, ma non all'infinito: dopo questo
# multiplo del ritardo, contato dal primo gesto, il messaggio parte comunque.
MAX_HOLD_FACTOR = 4
# Stati di un evento che non è mai arrivato e non arriverà.
_NEVER_DELIVERED = (
    OutboxEvent.Status.SUPERSEDED,
    OutboxEvent.Status.FAILED,
    OutboxEvent.Status.EXPIRED,
)


def appointment_event_key(appointment_id) -> str:
    return f"appointment:{appointment_id}"


def slot_event_key(appointment_id) -> str:
    return f"slot:{appointment_id}"


def _extended_hold(event, delay: int):
    """Nuova scadenza della trattenuta: `delay` da adesso, col tetto dal primo gesto."""
    now = timezone.now()
    return min(
        now + dt.timedelta(seconds=delay),
        event.created_at + dt.timedelta(seconds=delay * MAX_HOLD_FACTOR),
    )


def _hold(event, delay: int) -> None:
    """Trattiene ancora l'evento fuso — o lo libera subito se il ritardo è spento."""
    if delay > 0:
        event.next_attempt_at = _extended_hold(event, delay)
        event.due_at = event.next_attempt_at
    else:
        event.next_attempt_at = None
        event.due_at = timezone.now()


def _priority(event_type: str) -> int:
    return _EVENT_PRIORITY.get(event_type, 0)


def _when(value):
    """Istante di un campo ISO del payload (None se manca o è illeggibile)."""
    if isinstance(value, dt.datetime) or not value:
        return value or None
    try:
        return parse_datetime(str(value))
    except ValueError:
        return None


def _told_event(appointment: Appointment):
    """L'ultimo messaggio sull'appuntamento che la cliente ha ricevuto, o che
    ormai riceverà: consegnato, in consegna, in ritentativo o scaduta la
    trattenuta. None se nessuno (tutto ancora trattenuto, sostituito, perso)."""
    return (
        OutboxEvent.objects.filter(
            salon=appointment.salon,
            coalesce_key=appointment_event_key(appointment.id),
            event_type__in=_CLIENT_EVENTS,
        )
        .exclude(status__in=_NEVER_DELIVERED)
        .exclude(
            status=OutboxEvent.Status.PENDING, attempts=0, next_attempt_at__gt=timezone.now()
        )
        .order_by("-id")
        .first()
    )


def _never_told(appointment: Appointment) -> bool:
    """La cliente non ha mai ricevuto niente: la conferma è ancora ferma in coda,
    o è sparita con lei. Da non confondere con l'assenza di storia (appuntamento
    importato da Yourang, messaggi già cancellati dopo i trenta giorni): lì la
    cliente sa, e non sappiamo cosa."""
    return (
        _told_event(appointment) is None
        and OutboxEvent.objects.filter(
            salon=appointment.salon,
            coalesce_key=appointment_event_key(appointment.id),
            event_type="appointment.created",
        ).exists()
    )


def _deposit_messages(appointment: Appointment):
    """Link di pagamento e solleciti della caparra di questo appuntamento."""
    return OutboxEvent.objects.filter(
        salon=appointment.salon,
        event_type__in=("deposit.payment_link", "deposit.reminder"),
        payload__appointment_id=appointment.id,
    )


def _withdraw_deposit_messages(appointment: Appointment) -> int:
    """Ritira link e solleciti della caparra mai partiti (non ancora tentati)."""
    waiting = list(
        _deposit_messages(appointment)
        .filter(status=OutboxEvent.Status.PENDING, attempts=0)
        .select_for_update()
    )
    return supersede_events(waiting)


def _client_aware(appointment: Appointment) -> bool:
    """La cliente sa dell'appuntamento anche senza una nostra conferma.

    L'ha prenotato lei dall'app (e ha visto «prenotato» a schermo) o da Yourang,
    oppure le è arrivato il link per pagare la caparra, che parte subito.
    Per lei l'appuntamento esiste: se il salone lo annulla va avvisata.
    """
    if appointment.created_via in (Appointment.CreatedVia.APP, Appointment.CreatedVia.YOURANG):
        return True
    return (
        _deposit_messages(appointment)
        .filter(event_type="deposit.payment_link")
        .exclude(status__in=_NEVER_DELIVERED)
        .exists()
    )


def _same_for_client(told: dict, current: dict) -> bool:
    """Per la cliente non è cambiato niente: stessi orari, stessa operatrice,
    stessi servizi con le stesse durate."""
    for field in ("start", "end"):
        if _when(told.get(field)) != _when(current.get(field)):
            return False
    if told.get("operator_id") != current.get("operator_id"):
        return False
    before, after = told.get("services") or [], current.get("services") or []
    if len(before) != len(after):
        return False
    for was, now in zip(before, after):
        # I campi che un messaggio di prima non portava non contano.
        for field in ("id", "duration_min", "soak_min", "operator_id"):
            if field in was and was.get(field) != now.get(field):
                return False
    return True


def emit_appointment_event(appointment: Appointment, event_type: str, payload: dict | None = None):
    """Accoda un evento dell'appuntamento fondendolo con quelli ancora trattenuti.

    Ritorna l'evento che partirà (nuovo o aggiornato), oppure None quando non
    deve partire più niente: è il caso dell'appuntamento inserito per errore e
    annullato subito dopo, di cui la cliente non ha mai saputo nulla, o di un
    ritocco riportato dov'era prima che partisse.

    Nella fusione uno spostamento conserva l'`old_start` del PRIMO spostamento
    trattenuto, cioè l'orario che la cliente conosce: 10→11→12 le arrivava come
    «spostato dalle 11», un orario che non aveva mai saputo, e «sposta, poi
    allunga» come uno spostamento senza orario di prima.
    """
    salon = appointment.salon
    payload = _event_payload(appointment) if payload is None else dict(payload)
    key = appointment_event_key(appointment.id)
    delay = automation_delay_seconds(salon)
    # Anche col ritardo spento si guarda cosa è ancora trattenuto: passando a
    # «Subito» la correzione partiva al volo e la conferma vecchia trenta
    # secondi dopo, ultima parola sbagliata per Yourang.
    held = [e for e in held_events(salon, key, lock=True) if e.event_type in _CLIENT_EVENTS]
    if held and event_type in _TERMINAL_EVENTS:
        supersede_events(held)
        if any(e.event_type == "appointment.created" for e in held) and not _client_aware(appointment):
            # La conferma non era ancora partita: per il mondo fuori dal
            # salone quell'appuntamento non è mai esistito. Annunciarne
            # l'annullamento significherebbe raccontare un appuntamento che
            # la cliente non ha mai saputo di avere. Non vale per chi l'ha
            # prenotato dall'app o ha già in mano il link della caparra.
            return None
    elif held and event_type in _CLIENT_EVENTS and all(e.event_type in _TERMINAL_EVENTS for e in held):
        # Un annullamento (o un rilascio) ancora trattenuto e poi rimesso a
        # posto, per esempio ripristinando subito un appuntamento liberato: non
        # è partito niente, e se per la cliente tutto è com'era non si dice nulla.
        supersede_events(held)
        told = _told_event(appointment)
        if (
            told is not None
            and told.event_type not in _TERMINAL_EVENTS
            and _same_for_client(told.payload, payload)
        ):
            return None
    elif held and event_type in _CLIENT_EVENTS:
        keep = max(held, key=lambda e: _priority(e.event_type))
        supersede_events([e for e in held if e.id != keep.id])
        if _priority(event_type) > _priority(keep.event_type):
            keep.event_type = event_type
        if keep.event_type == "appointment.moved":
            first = next(
                (
                    e.payload.get("old_start")
                    for e in held  # in ordine di nascita
                    if e.event_type == "appointment.moved" and e.payload.get("old_start")
                ),
                None,
            )
            if first or payload.get("old_start"):
                payload["old_start"] = first or payload["old_start"]
        else:
            # la cliente non ha mai saputo l'orario di prima di una conferma
            payload.pop("old_start", None)
        if keep.event_type in ("appointment.moved", "appointment.updated"):
            told = _told_event(appointment)
            if (
                told is not None
                and told.event_type not in _TERMINAL_EVENTS
                and _same_for_client(told.payload, payload)
            ):
                # Riportato com'era prima che il messaggio partisse: per la
                # cliente non è successo niente.
                supersede_events([keep])
                return None
        keep.payload = payload
        _hold(keep, delay)
        keep.save(update_fields=["event_type", "payload", "next_attempt_at", "due_at"])
        return keep
    # Con il ritardo spento (delay <= 0) `emit_event` non trattiene niente.
    return emit_event(salon, event_type, payload, delay_seconds=delay, coalesce_key=key)


def _rectify(appointment: Appointment, held: list, wanted: str | None, payload: dict) -> None:
    """Lascia in coda UN messaggio `wanted` (None = nessuno), riusando un trattenuto."""
    if wanted is None:
        supersede_events(held)
        return
    reusable = [e for e in held if e.event_type not in _TERMINAL_EVENTS]
    keep = max(reusable, key=lambda e: _priority(e.event_type)) if reusable else None
    supersede_events([e for e in held if keep is None or e.id != keep.id])
    delay = automation_delay_seconds(appointment.salon)
    if keep is None:
        emit_event(
            appointment.salon, wanted, payload,
            delay_seconds=max(delay, 0), coalesce_key=appointment_event_key(appointment.id),
        )
        return
    keep.event_type = wanted
    keep.payload = payload
    _hold(keep, delay)
    keep.save(update_fields=["event_type", "payload", "next_attempt_at", "due_at"])
