"""«Torna indietro» in agenda: registra ogni gesto e sa rimetterlo a posto.

In agenda si lavora a mano libera — si trascina, si stacca, si annulla — e ogni
tanto un gesto parte per sbaglio: il blocco cade una riga più in basso, il dito
scivola su «no-show», la cliente sbagliata finisce sotto le forbici. Finora
l'unico rimedio era rifare tutto a mano e sperare che nel frattempo non fosse
partito nessun messaggio.

Come funziona: ogni mutazione chiama `record(...)` passando lo stato di PRIMA
(`before`), quello che ha prodotto (`after`) e ciò che ha creato (`created`).
`perform(entry)` rimette le cose com'erano e sistema anche i messaggi:
quelli ancora trattenuti dal ritardo di sicurezza spariscono senza lasciare
traccia, quelli già partiti vengono rettificati.

Due garanzie, perché «torna indietro» non diventi un modo per cancellare il
lavoro altrui:

- lo storico è PER PERSONA e dura `UNDO_WINDOW_MINUTES` minuti: si annulla
  l'ultima cosa fatta da chi preme il tasto, non quella della postazione accanto;
- prima di toccare qualunque cosa si verifica che sia ancora com'era stata
  lasciata (`after`). Se una collega l'ha spostata nel frattempo, l'operazione
  viene rifiutata invece di sovrascriverla.
"""

import datetime as dt
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from ninja.errors import HttpError

from apps.core.services import log_activity

from .models import Appointment, AppointmentService, Pause, UndoEntry

# Quanto resta annullabile un gesto, e quanti se ne tengono per persona.
UNDO_WINDOW_MINUTES = 10
UNDO_STACK_LIMIT = 20

# Stati in cui l'appuntamento non si tocca più: il conto è chiuso o è passato in
# cassa. Tornare indietro qui vorrebbe dire smontare una vendita.
_FROZEN_STATUSES = (Appointment.Status.CLOSED,)

# Messaggio da mandare alla cliente quando l'annullamento arriva TARDI, cioè
# quando quello del gesto originale era già partito (vedi services.revert_held_events).
_FALLBACK_EVENT = {
    UndoEntry.Kind.MOVE: "appointment.moved",
    UndoEntry.Kind.EDIT: "appointment.updated",
    UndoEntry.Kind.SPLIT: "appointment.updated",
    UndoEntry.Kind.CANCEL: "appointment.created",
    UndoEntry.Kind.NO_SHOW: "appointment.created",
    UndoEntry.Kind.STATUS: "",  # check-in e inizio trattamento restano in salone
}


# ---------------------------------------------------------------------------
# Istantanee
# ---------------------------------------------------------------------------
#
# Le istantanee servono anche a CONFRONTARE lo stato («è ancora come l'abbiamo
# lasciato?»), quindi ogni valore va scritto in una forma sola. Lo stesso
# istante ha due `isoformat()` diversi a seconda che l'oggetto arrivi dal
# database (UTC) o sia ancora quello appena salvato (ora locale), e la stessa
# cifra vale `0` o `0.00`: senza normalizzare, ogni confronto falliva e «torna
# indietro» rispondeva sempre «qualcuno ha già cambiato tutto».


def _at(value) -> str:
    """L'istante, sempre in UTC: una sola scrittura per lo stesso momento."""
    return value.astimezone(dt.timezone.utc).isoformat()


def _money(value) -> str:
    return str(Decimal(value or 0).quantize(Decimal("0.01")))


def appointment_snapshot(appointment: Appointment) -> dict:
    """Tutto ciò che «torna indietro» sa rimettere a posto di un appuntamento."""
    return {
        "id": appointment.id,
        "start": _at(appointment.start),
        "operator_id": appointment.operator_id,
        "status": appointment.status,
        "cancel_reason": appointment.cancel_reason,
        "cancelled_late": appointment.cancelled_late,
        "note": appointment.note,
        "flexible": appointment.flexible,
        "forced": appointment.forced,
        "auto_released": appointment.auto_released,
        "deposit_status": appointment.deposit_status,
        "deposit_amount": _money(appointment.deposit_amount),
        "items": [
            {
                "service_id": item.service_id,
                "operator_id": item.operator_id,
                "duration_min": item.duration_min,
                "soak_min": item.soak_min,
                "price": _money(item.price),
                "order": item.order,
            }
            for item in appointment.items.all().order_by("order", "id")
        ],
    }


def pause_snapshot(pause: Pause) -> dict:
    return {
        "id": pause.id,
        "operator_id": pause.operator_id,
        "start": _at(pause.start),
        "duration_min": pause.duration_min,
        "note": pause.note,
    }


# ---------------------------------------------------------------------------
# Registrazione
# ---------------------------------------------------------------------------


def record(
    salon,
    *,
    kind: str,
    label: str,
    actor=None,
    before: dict | None = None,
    after: dict | None = None,
    created: dict | None = None,
) -> UndoEntry | None:
    """Mette un gesto nello storico annullabile di `actor`.

    `before`/`after`/`created` hanno la stessa forma:
    `{"appointments": [snapshot…], "pauses": [snapshot…]}`; in `created` bastano
    gli id (`{"appointments": [12], "pauses": []}`).

    Senza operatore non si registra niente: quello che fanno l'app cliente e gli
    automatismi non appartiene a nessuna postazione, e nessuno deve poterlo
    annullare con un tasto.
    """
    if actor is None or not getattr(actor, "pk", None):
        return None
    entry = UndoEntry.objects.create(
        salon=salon,
        actor=actor,
        kind=kind,
        label=label[:160],
        before=before or {},
        after=after or {},
        created=created or {},
    )
    # Lo storico non cresce all'infinito: di ciascuno restano gli ultimi gesti,
    # e solo finché sono annullabili. Le istantanee contengono orari, prezzi e
    # il nome della cliente nell'etichetta: scadute non servono più a nessuno.
    stale = UndoEntry.objects.filter(salon=salon, actor=actor).filter(
        Q(created_at__lt=timezone.now() - dt.timedelta(minutes=UNDO_WINDOW_MINUTES))
        | Q(id__in=[
            e.id
            for e in UndoEntry.objects.filter(salon=salon, actor=actor).order_by("-created_at")[
                UNDO_STACK_LIMIT:
            ]
        ])
    )
    stale.delete()
    return entry


def stack(salon, actor) -> list[UndoEntry]:
    """I gesti che `actor` può ancora annullare, dal più recente."""
    if actor is None or not getattr(actor, "pk", None):
        return []
    return list(
        UndoEntry.objects.filter(
            salon=salon,
            actor=actor,
            undone_at__isnull=True,
            created_at__gte=timezone.now() - dt.timedelta(minutes=UNDO_WINDOW_MINUTES),
        ).order_by("-created_at")[:UNDO_STACK_LIMIT]
    )


# ---------------------------------------------------------------------------
# Esecuzione
# ---------------------------------------------------------------------------


def _live_appointment(snap: dict) -> Appointment:
    appointment = (
        Appointment.objects.filter(id=snap["id"]).select_related("client", "salon").first()
    )
    if appointment is None:
        raise HttpError(409, "L'appuntamento non esiste più: non si può tornare indietro")
    return appointment


def _differs(snap: dict, appointment: Appointment) -> bool:
    """Lo stato attuale non è più quello lasciato dal gesto da annullare."""
    current = appointment_snapshot(appointment)
    return any(current.get(key) != value for key, value in snap.items())


def _restore_appointment(snap: dict) -> Appointment:
    appointment = _live_appointment(snap)
    appointment.start = parse_datetime(snap["start"])
    appointment.operator_id = snap["operator_id"]
    appointment.status = snap["status"]
    appointment.cancel_reason = snap["cancel_reason"]
    appointment.cancelled_late = snap["cancelled_late"]
    appointment.note = snap["note"]
    appointment.flexible = snap["flexible"]
    appointment.forced = snap["forced"]
    appointment.auto_released = snap["auto_released"]
    appointment.deposit_status = snap["deposit_status"]
    appointment.deposit_amount = Decimal(snap["deposit_amount"])
    appointment.save(
        update_fields=[
            "start", "operator", "status", "cancel_reason", "cancelled_late", "note",
            "flexible", "forced", "auto_released", "deposit_status", "deposit_amount",
            "updated_at",
        ]
    )
    # I servizi si riscrivono dall'istantanea: è l'unico modo di rimettere a
    # posto un servizio staccato, una durata allungata o una riga tolta.
    appointment.items.all().delete()
    for item in snap["items"]:
        AppointmentService.objects.create(
            appointment=appointment,
            service_id=item["service_id"],
            operator_id=item["operator_id"],
            duration_min=item["duration_min"],
            soak_min=item["soak_min"],
            price=Decimal(item["price"]),
            order=item["order"],
        )
    return appointment


def _delete_appointment(appointment: Appointment, label: str) -> None:
    """Fa sparire un appuntamento nato per sbaglio, con i suoi servizi."""
    has_sale = (
        Appointment.objects.filter(id=appointment.id)
        .filter(sale__isnull=False)
        .exists()
        or Appointment.objects.filter(id=appointment.id)
        .filter(deposit_sale__isnull=False)
        .exists()
    )
    if appointment.status in _FROZEN_STATUSES or has_sale:
        raise HttpError(409, f"{label}: il conto è già passato in cassa")
    if appointment.deposit_status not in (
        Appointment.DepositStatus.NONE,
        Appointment.DepositStatus.REQUIRED,
    ):
        raise HttpError(409, f"{label}: c'è una caparra da sistemare, annullalo a mano")
    appointment.items.all().delete()
    appointment.delete()


def _restore_pause(snap: dict) -> None:
    """Rimette la pausa com'era, ricreandola se nel frattempo è sparita."""
    pause = Pause.objects.filter(id=snap["id"]).first()
    if pause is None:
        Pause.objects.create(
            id=snap["id"],
            salon_id=snap["salon_id"],
            operator_id=snap["operator_id"],
            start=parse_datetime(snap["start"]),
            duration_min=snap["duration_min"],
            note=snap["note"],
        )
        return
    pause.operator_id = snap["operator_id"]
    pause.start = parse_datetime(snap["start"])
    pause.duration_min = snap["duration_min"]
    pause.note = snap["note"]
    pause.save(update_fields=["operator", "start", "duration_min", "note", "updated_at"])


def perform(entry: UndoEntry, *, actor=None) -> dict:
    """Annulla il gesto. Ritorna {"label", "appointment_ids", "date"}.

    Solleva HttpError(409) quando non si può più: il gesto è scaduto, qualcuno
    ha toccato le stesse righe nel frattempo, il conto è già in cassa.
    """
    from . import services  # lazy: services importa questo modulo

    if entry.undone_at is not None:
        raise HttpError(409, "Questa azione è già stata annullata")
    if entry.created_at < timezone.now() - dt.timedelta(minutes=UNDO_WINDOW_MINUTES):
        raise HttpError(409, "Troppo tempo: questa azione non si può più annullare")

    salon = entry.salon
    touched: list[Appointment] = []
    days: list[dt.datetime] = []
    with transaction.atomic():
        services.lock_salon(salon)

        # 1. Le righe devono essere ancora come le abbiamo lasciate.
        for snap in entry.after.get("appointments", []):
            appointment = _live_appointment(snap)
            if appointment.status in _FROZEN_STATUSES:
                raise HttpError(409, "Il conto è già stato chiuso: non si può tornare indietro")
            if _differs(snap, appointment):
                raise HttpError(409, "Qualcuno ha già cambiato questo appuntamento nel frattempo")
        for snap in entry.after.get("pauses", []):
            pause = Pause.objects.filter(id=snap["id"]).first()
            if pause is None or pause_snapshot(pause) != snap:
                raise HttpError(409, "La pausa è già cambiata nel frattempo")

        # 2. Quello che il gesto ha creato se ne va — ma prima si avvisa la
        #    cliente, se la conferma era già partita: la fusione degli eventi
        #    decide da sola se c'è davvero qualcosa da dire (services).
        for appointment_id in entry.created.get("appointments", []):
            appointment = (
                Appointment.objects.filter(id=appointment_id)
                .select_related("client", "salon")
                .first()
            )
            if appointment is None:
                continue
            days.append(appointment.start)
            # Prima si toglie l'annuncio alla lista d'attesa (quello slot non si
            # è liberato: non è mai stato occupato), poi si passa dall'emissione
            # normale, che sa da sola se c'è qualcosa da dire alla cliente: se la
            # conferma è ancora ferma in coda sparisce tutto e nessuno riceve
            # niente, se invece era già partita parte l'annullamento.
            services.suppress_slot_events(salon, appointment.id)
            services.emit_appointment_event(
                appointment,
                "appointment.cancelled",
                {
                    **services._event_payload(appointment),
                    "reason": "annullato dal salone",
                    "late": False,
                },
            )
            _delete_appointment(appointment, entry.label)
        Pause.objects.filter(id__in=entry.created.get("pauses", [])).delete()

        # 3. Quello che aveva cambiato torna com'era.
        for snap in entry.before.get("appointments", []):
            appointment = _restore_appointment(snap)
            touched.append(appointment)
            days.append(appointment.start)
        for snap in entry.before.get("pauses", []):
            _restore_pause({**snap, "salon_id": salon.id})

        # 4. I messaggi: spariscono se erano ancora trattenuti, si rettificano
        #    se erano già partiti.
        fallback = _FALLBACK_EVENT.get(entry.kind, "appointment.updated")
        for appointment in touched:
            appointment.refresh_from_db()
            services.revert_held_events(appointment, fallback_event=fallback)

        entry.undone_at = timezone.now()
        entry.save(update_fields=["undone_at"])
        # Il registro tiene traccia anche dei ripensamenti, e il feed live lo usa
        # per aggiornare da sé le altre postazioni.
        log_activity(
            salon,
            "appointment.undone",
            f"Annullato: {entry.label}",
            actor=actor,
            payload={"undo_id": entry.id, "kind": entry.kind},
        )
    day = min(days) if days else None
    return {
        "label": entry.label,
        "appointment_ids": [a.id for a in touched],
        "date": timezone.localtime(day).date().isoformat() if day else None,
    }
