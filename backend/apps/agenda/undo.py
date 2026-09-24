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
import logging
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.money import CENT

from .models import Appointment, AppointmentService, Pause, UndoEntry
from .services.deposits import close_deposit_link_after_commit, renew_deposit_link_after_commit
from .services.freed_slots import _appointment_spans, _chain_spans, _spans_minus, emit_with_freed_slots
from .services.locking import lock_salon
from .services.messages import _event_payload, _withdraw_deposit_messages
from .services.resolution import _validate_segments
from .services.undo_messages import revert_held_events

logger = logging.getLogger("youty.agenda")

# Quanto resta annullabile un gesto, e quanti se ne tengono per persona.
UNDO_WINDOW_MINUTES = 10
UNDO_STACK_LIMIT = 20

# Stati in cui l'appuntamento non si tocca più: il conto è chiuso o è passato in
# cassa. Tornare indietro qui vorrebbe dire smontare una vendita.
_FROZEN_STATUSES = (Appointment.Status.CLOSED,)

# Messaggio da mandare alla cliente quando l'annullamento arriva TARDI e non
# c'è nessun messaggio consegnato a cui confrontare lo stato ripristinato
# (appuntamento importato, storico già cancellato): vedi services.undo_messages.revert_held_events.
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
    return str(Decimal(value or 0).quantize(CENT))


# I campi dell'appuntamento che l'istantanea copia così come sono, e che
# `_restore_appointment` riscrive: un campo solo qui, e non anche là, verrebbe
# confrontato ma mai rimesso a posto. `start` e `deposit_amount` stanno a parte,
# perché si scrivono in una forma sola (vedi `_at` e `_money`).
_SNAPSHOT_FIELDS = (
    "operator_id",
    "status",
    "cancel_reason",
    "cancelled_late",
    "note",
    "flexible",
    "forced",
    "auto_released",
    "deposit_status",
)


def appointment_snapshot(appointment: Appointment) -> dict:
    """Tutto ciò che «torna indietro» sa rimettere a posto di un appuntamento."""
    return {
        "id": appointment.id,
        "start": _at(appointment.start),
        **{field: getattr(appointment, field) for field in _SNAPSHOT_FIELDS},
        "deposit_amount": _money(appointment.deposit_amount),
        "items": [
            {
                # L'id serve a rimettere a posto la STESSA riga: ricreate con id
                # nuovi, una modifica partita dal pannello rimasto aperto le
                # prendeva per servizi aggiunti e le riprezzava a listino.
                "id": item.id,
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


def record_appointment_change(
    appointment: Appointment, *, kind: str, label: str, actor=None, before: dict
) -> UndoEntry | None:
    """`record` per un gesto che ha cambiato UN appuntamento esistente.

    `before` è la sua istantanea presa prima del gesto (`appointment_snapshot`);
    quella di dopo si prende qui, dallo stato appena scritto.
    """
    return record(
        appointment.salon,
        kind=kind,
        label=label,
        actor=actor,
        before={"appointments": [before]},
        after={"appointments": [appointment_snapshot(appointment)]},
    )


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


def purge_expired(now=None) -> int:
    """Cancella le voci scadute di tutti i saloni. Ritorna quante.

    `record` pulisce soltanto lo storico di chi ha appena fatto un gesto: per
    chi non ne fa più (fine turno, una collaboratrice che se ne va) le
    istantanee — note, prezzi, il nome della cliente nell'etichetta — restavano
    a database per sempre. La chiama `flush_outbox` a ogni giro.
    """
    now = now or timezone.now()
    deleted, _ = UndoEntry.objects.filter(
        created_at__lt=now - dt.timedelta(minutes=UNDO_WINDOW_MINUTES)
    ).delete()
    return deleted


# ---------------------------------------------------------------------------
# Esecuzione
# ---------------------------------------------------------------------------


def _live_appointment(snap: dict) -> Appointment:
    # Riga bloccata (dopo il salone, come in services.locking._lock_and_reload): il
    # webhook della caparra e il rilascio automatico lavorano sulla riga.
    appointment = (
        Appointment.objects.select_for_update(of=("self",))
        .filter(id=snap["id"])
        .select_related("client", "salon")
        .first()
    )
    if appointment is None:
        raise HttpError(409, "L'appuntamento non esiste più: non si può tornare indietro")
    return appointment


def _differs(snap: dict, appointment: Appointment) -> bool:
    """Lo stato attuale non è più quello lasciato dal gesto da annullare.

    Si confrontano solo i campi che l'istantanea porta: una voce scritta prima
    che i servizi avessero l'id non diventa «cambiata» per questo.
    """
    current = appointment_snapshot(appointment)
    for key, value in snap.items():
        if key != "items":
            if current.get(key) != value:
                return True
            continue
        now = current.get("items") or []
        if len(now) != len(value):
            return True
        if any(item.get(field) != was for stored, item in zip(value, now) for field, was in stored.items()):
            return True
    return False


def _ensure_untouched(snap: dict, appointment: Appointment) -> None:
    """409 se l'appuntamento non è più come l'ha lasciato il gesto, col motivo vero.

    Il messaggio generico («qualcuno l'ha cambiato») dava la colpa a una collega
    anche quando era stata la cassa, Stripe o il rilascio automatico: dopo un
    annullamento col rimborso partito da solo, «torna indietro» rispondeva che
    qualcuno aveva cambiato l'appuntamento.
    """
    if appointment.status in _FROZEN_STATUSES:
        raise HttpError(409, "Il conto è già stato chiuso: non si può tornare indietro")
    # L'addebito del no-show crea una vendita agganciata ma non tocca i campi
    # dell'istantanea: si rimetteva «confermato» con la vendita attaccata, e il
    # conto non si chiudeva più («appuntamento già incassato»).
    if appointment.no_show_payment_intent_id:
        raise HttpError(
            409, "Il no-show è già stato addebitato sulla carta: non si può tornare indietro"
        )
    if Appointment.objects.filter(id=appointment.id, sale__isnull=False).exists():
        raise HttpError(409, "C'è già un incasso su questo appuntamento: non si può tornare indietro")
    was, now = snap.get("deposit_status"), appointment.deposit_status
    if was is not None and was != now:
        if now == Appointment.DepositStatus.PAID:
            raise HttpError(
                409,
                "Nel frattempo è arrivato il pagamento della caparra: non si può tornare "
                "indietro, sistemalo a mano",
            )
        if now in (Appointment.DepositStatus.REFUNDING, Appointment.DepositStatus.REFUNDED):
            raise HttpError(
                409,
                "La caparra è già stata rimborsata alla cliente: non si può tornare indietro, "
                "rimetti l'appuntamento in agenda a mano",
            )
        raise HttpError(409, "La caparra è cambiata nel frattempo: non si può tornare indietro")
    if appointment.auto_released and not snap.get("auto_released"):
        raise HttpError(
            409,
            "Nel frattempo l'appuntamento è stato liberato perché la caparra non è "
            "arrivata: ripristinalo da «da richiamare»",
        )
    if _differs(snap, appointment):
        raise HttpError(409, "Qualcuno ha già cambiato questo appuntamento nel frattempo")


def _ensure_slot_free(snap: dict, appointment: Appointment) -> None:
    """Il posto dove l'appuntamento torna dev'essere ancora libero (409 altrimenti).

    Si controlla solo il tempo che l'appuntamento riprende e oggi non tiene:
    spostato dalle 10 alle 15, nel frattempo l'app prenotava Anna alle 10 e
    «Indietro» rimetteva due clienti con la stessa operatrice alla stessa ora.
    Le visite della stessa cliente non contano (come nei gesti dello staff), e
    un appuntamento che era già stato messo lì forzando resta una scelta fatta.
    """
    from apps.staff.models import Operator  # lazy

    if snap.get("forced") or snap.get("status") in Appointment.INACTIVE_STATUSES:
        return
    start = parse_datetime(snap["start"])
    items = snap.get("items") or []
    wanted = _chain_spans(
        start, [(it["operator_id"], it["duration_min"], it["soak_min"]) for it in items]
    )
    held = (
        {}
        if appointment.status in Appointment.INACTIVE_STATUSES
        else _appointment_spans(appointment)
    )
    if not _spans_minus(wanted, held):
        return
    operators = Operator.objects.in_bulk({it["operator_id"] for it in items})
    try:
        _validate_segments(
            appointment.salon,
            start,
            [(it["duration_min"], it["soak_min"], operators[it["operator_id"]]) for it in items],
            exclude_appointment_id=appointment.id,
            ignore_client_id=appointment.client_id,
        )
    except HttpError as err:
        if err.status_code != 409:
            raise
        raise HttpError(
            409, "Nel frattempo quell'orario è stato occupato: non si può tornare indietro"
        )


def _restore_appointment(snap: dict) -> Appointment:
    appointment = _live_appointment(snap)
    appointment.start = parse_datetime(snap["start"])
    for field in _SNAPSHOT_FIELDS:
        setattr(appointment, field, snap[field])
    appointment.deposit_amount = Decimal(snap["deposit_amount"])
    appointment.save(
        update_fields=[
            "start",
            *(field.removesuffix("_id") for field in _SNAPSHOT_FIELDS),
            "deposit_amount",
            "updated_at",
        ]
    )
    items = snap["items"]
    if not all("id" in item for item in items):
        # Voce scritta prima che i servizi avessero l'id: si riscrivono da capo.
        appointment.items.all().delete()
        for item in items:
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
    # Ogni servizio torna com'era nella SUA riga, con lo stesso id: un
    # servizio staccato, una durata allungata, una riga tolta. Le righe che il
    # gesto aveva aggiunto se ne vanno.
    existing = {row.id: row for row in appointment.items.all()}
    appointment.items.exclude(id__in=[item["id"] for item in items]).delete()
    for item in items:
        values = {
            "service_id": item["service_id"],
            "operator_id": item["operator_id"],
            "duration_min": item["duration_min"],
            "soak_min": item["soak_min"],
            "price": Decimal(item["price"]),
            "order": item["order"],
        }
        row = existing.get(item["id"])
        if row is None:
            AppointmentService.objects.create(id=item["id"], appointment=appointment, **values)
            continue
        changed = [field for field, value in values.items() if getattr(row, field) != value]
        if changed:
            for field in changed:
                setattr(row, field, values[field])
            row.save(update_fields=[f.removesuffix("_id") for f in changed])
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


def _reissue_deposit_links(appointments) -> None:
    """Dopo aver annullato un annullamento: un link di pagamento nuovo per la caparra.

    L'annullamento ha chiuso su Stripe la sessione del link (vedi
    services.deposits.close_deposit_link_after_commit): rimessa in agenda con la
    caparra ancora da pagare, la cliente si ritroverebbe con una pagina già
    chiusa e allo scadere il posto si libererebbe da solo. Svuotato l'indirizzo,
    `ensure_deposit_link` ne crea uno nuovo e lo manda, a transazione chiusa.
    """
    from apps.sales.stripe_service import ensure_deposit_link, payments_enabled  # lazy

    for appointment in appointments:
        if (
            appointment.deposit_status != Appointment.DepositStatus.REQUIRED
            or not appointment.deposit_checkout_session_id
            or not payments_enabled(appointment.salon)
        ):
            continue
        appointment.deposit_payment_link = ""
        appointment.save(update_fields=["deposit_payment_link", "updated_at"])

        def send(appointment=appointment):
            try:
                ensure_deposit_link(appointment)
            except Exception:  # noqa: BLE001 — l'undo è fatto: il link si rimanda dalla scheda
                logger.warning(
                    "Link caparra non rimandato dopo l'undo (appuntamento %s)",
                    appointment.id,
                    exc_info=True,
                )

        transaction.on_commit(send)


def _renew_links_for_restored_amount(appointments, after_snapshots) -> None:
    """Dopo aver annullato un gesto che aveva cambiato la caparra ancora da pagare.

    Modificare o staccare servizi riduce anche la caparra richiesta e rifà il
    link con il nuovo importo (services.deposits.shrink_deposit_to_total). «Indietro»
    rimetteva l'importo di prima ma lasciava il link nuovo: la cliente pagava
    20 € su una caparra tornata a 70, il webhook lo registrava come importo
    sbagliato, la caparra restava «richiesta» e alla scadenza il posto si
    liberava da solo. Qui il link (e il messaggio non ancora partito) si rifà
    con l'importo ripristinato, a transazione chiusa; la sessione di prima si
    chiude su Stripe.
    """
    from apps.sales.stripe_service import payments_enabled  # lazy

    amount_after = {snap["id"]: snap.get("deposit_amount") for snap in after_snapshots}
    for appointment in appointments:
        if (
            appointment.deposit_status != Appointment.DepositStatus.REQUIRED
            or appointment.id not in amount_after
            or amount_after[appointment.id] == _money(appointment.deposit_amount)
            or not (appointment.deposit_payment_link or appointment.deposit_checkout_session_id)
            or not payments_enabled(appointment.salon)
        ):
            continue
        # il link con l'importo del gesto annullato, se non è ancora partito, non parte
        _withdraw_deposit_messages(appointment)
        renew_deposit_link_after_commit(
            appointment.id,
            log_message="Link caparra non rifatto dopo l'undo (appuntamento %s)",
            warn=True,
        )


def perform(entry: UndoEntry, *, actor=None) -> dict:
    """Annulla il gesto. Ritorna {"label", "appointment_ids", "date"}.

    Solleva HttpError(409) quando non si può più: il gesto è scaduto, qualcuno
    ha toccato le stesse righe nel frattempo, il conto è già in cassa.
    """
    if entry.undone_at is not None:
        raise HttpError(409, "Questa azione è già stata annullata")
    if entry.created_at < timezone.now() - dt.timedelta(minutes=UNDO_WINDOW_MINUTES):
        raise HttpError(409, "Troppo tempo: questa azione non si può più annullare")

    salon = entry.salon
    touched: list[Appointment] = []
    days: list[dt.datetime] = []
    with transaction.atomic():
        lock_salon(salon)

        # 1. Le righe devono essere ancora come le abbiamo lasciate.
        for snap in entry.after.get("appointments", []):
            _ensure_untouched(snap, _live_appointment(snap))
        for snap in entry.after.get("pauses", []):
            pause = Pause.objects.filter(id=snap["id"]).first()
            if pause is None or pause_snapshot(pause) != snap:
                raise HttpError(409, "La pausa è già cambiata nel frattempo")

        # 2. Quello che il gesto ha creato se ne va — ma prima si avvisa la
        #    cliente, se la conferma era già partita: la fusione degli eventi
        #    decide da sola se c'è davvero qualcosa da dire (services.messages).
        for appointment_id in entry.created.get("appointments", []):
            appointment = (
                Appointment.objects.filter(id=appointment_id)
                .select_related("client", "salon")
                .first()
            )
            if appointment is None:
                continue
            days.append(appointment.start)
            freed = _appointment_spans(appointment)
            # Il link della caparra partito con la prenotazione: se non è ancora
            # uscito non esce più, se è uscito la sessione si chiude su Stripe
            # a transazione chiusa. Restava pagabile, e il pagamento finiva su
            # un appuntamento che non esisteva più.
            _withdraw_deposit_messages(appointment)
            close_deposit_link_after_commit(appointment)
            # Poi si passa dall'emissione normale, che sa da sola se c'è
            # qualcosa da dire alla cliente: se la conferma è ancora ferma in
            # coda sparisce tutto e nessuno riceve niente, se invece era già
            # partita (o la cliente ha in mano il link) parte l'annullamento.
            # E la lista d'attesa sente dello slot solo se qualcuno lo sapeva
            # occupato: con la conferma già partita, lo slot si è liberato.
            emit_with_freed_slots(
                appointment,
                "appointment.cancelled",
                {
                    **_event_payload(appointment),
                    "reason": "annullato dal salone",
                    "late": False,
                },
                before=freed,
                after={},
            )
            _delete_appointment(appointment, entry.label)
        Pause.objects.filter(id__in=entry.created.get("pauses", [])).delete()

        # 3. Quello che aveva cambiato torna com'era.
        previous_spans: dict[int, dict] = {}
        for snap in entry.before.get("appointments", []):
            live = _live_appointment(snap)
            _ensure_slot_free(snap, live)
            previous_spans[live.id] = (
                {}
                if live.status in Appointment.INACTIVE_STATUSES
                else _appointment_spans(live)
            )
            appointment = _restore_appointment(snap)
            touched.append(appointment)
            days.append(appointment.start)
        for snap in entry.before.get("pauses", []):
            _restore_pause({**snap, "salon_id": salon.id})
        if entry.kind == UndoEntry.Kind.CANCEL:
            _reissue_deposit_links(touched)
        else:
            _renew_links_for_restored_amount(touched, entry.after.get("appointments", []))

        # 4. I messaggi: spariscono se erano ancora trattenuti e per la
        #    cliente non cambia niente, si rettificano se ciò che sa è diverso
        #    dallo stato ripristinato (services.undo_messages.revert_held_events).
        fallback = _FALLBACK_EVENT.get(entry.kind, "appointment.updated")
        for appointment in touched:
            appointment.refresh_from_db()
            revert_held_events(
                appointment,
                fallback_event=fallback,
                previous_spans=previous_spans.get(appointment.id, {}),
            )

        entry.undone_at = timezone.now()
        entry.save(update_fields=["undone_at"])
        # Il registro tiene traccia anche dei ripensamenti, e il feed live lo usa
        # per aggiornare da sé le altre postazioni. `appointment_ids` sono le
        # visite toccate, anche quelle tolte: un pannello aperto su un'altra
        # visita non ha bisogno di rileggersi.
        log_activity(
            salon,
            "appointment.undone",
            f"Annullato: {entry.label}",
            actor=actor,
            payload={
                "undo_id": entry.id,
                "kind": entry.kind,
                "appointment_ids": sorted(
                    {a.id for a in touched} | set(entry.created.get("appointments", []))
                ),
            },
        )
    day = min(days) if days else None
    return {
        "label": entry.label,
        "appointment_ids": [a.id for a in touched],
        "date": timezone.localtime(day).date().isoformat() if day else None,
    }
