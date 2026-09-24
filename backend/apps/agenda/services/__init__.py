"""Logica dell'agenda: disponibilità, depositi, creazione/spostamento/annullamento.

Convenzioni interne:
- tutti i calcoli di disponibilità lavorano in MINUTI DA MEZZANOTTE del giorno
  richiesto, nel fuso del salone (settings.TIME_ZONE);
- le funzioni di staff/clients/sales si importano dentro la funzione che le
  usa, a ogni chiamata: i test le sostituiscono nel loro modulo
  (`apps.staff.services.shift_windows`, `apps.clients.services.client_facts`,
  `apps.sales.stripe_service.*`), e sales a sua volta importa l'agenda;
- le finestre lavorabili arrivano da `staff.services.shift_windows(operator, date)`
  -> list[tuple[int, int]] (minuti), già al netto di pause pranzo e assenze.
"""

import datetime as dt
import logging
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity
# compat refactoring: rimuovere dopo l'integrazione. `default_location` ora vive
# in apps.core.services; agenda/api.py (`services.default_location`) e
# staff/api.py (import pigro da qui) la cercano ancora in questo modulo.
from apps.core.services import default_location  # noqa: F401

from .. import undo as undo_log
from ..models import Appointment, AppointmentService, UndoEntry
from .availability import (
    _slot_is_recommended,  # noqa: F401
    get_free_slots,  # noqa: F401
    slot_assignment,  # noqa: F401
    smart_slots,  # noqa: F401
)
from .deposits import (
    _close_deposit_link_after_commit,
    compute_deposit,
    gift_covered_amount,
    shrink_deposit_to_total,
    spendable_gift_cards,  # noqa: F401
)
from .freed_slots import (
    _appointment_spans,
    _chain_spans,
    _slot_knowledge,
    _spans_minus,  # noqa: F401
    _sync_freed_slots,
    free_slot_event,  # noqa: F401
)
from .locking import _lock_and_reload, _lock_row, lock_salon
from .messages import (
    MAX_HOLD_FACTOR,  # noqa: F401
    _event_payload,
    _withdraw_deposit_messages,
    appointment_event_key,
    emit_appointment_event,
)
from .occupancy import _busy_map, bookable_operator_ids  # noqa: F401
from .refund_ledger import (
    _REFUND_STATUS_RANK,
    REFUND_DONE,
    REFUND_FLOOR_KEY,
    REFUND_GONE,  # noqa: F401
    REFUND_IN_FLIGHT,
    _refund_sums,  # noqa: F401
    _refunds_committed_cents,  # noqa: F401
    _refunds_done_cents,
    _to_cents,
)
from .resolution import _reject_soak_overlap, _validate_segments, resolve_items, resolve_items_edit
from .undo_messages import revert_held_events  # noqa: F401

logger = logging.getLogger("youty.agenda")

# Stati in cui l'appuntamento è ancora "aperto" e quindi modificabile.
OPEN_STATUSES = Appointment.OPEN_STATUSES


# ---------------------------------------------------------------------------
# Mutazioni
# ---------------------------------------------------------------------------


def snapshot_items(appointment: Appointment, resolved: list[tuple]) -> None:
    """Crea gli AppointmentService con snapshot durata/posa/prezzo dal listino."""
    for index, (service, operator) in enumerate(resolved):
        AppointmentService.objects.create(
            appointment=appointment,
            service=service,
            operator=operator,
            duration_min=service.duration_min,
            soak_min=service.soak_min,
            price=service.price,
            order=index,
        )


def snapshot_items_edit(appointment: Appointment, resolved: list[tuple]) -> None:
    """Riscrive gli AppointmentService da resolve_items_edit.

    Le tuple sono (service, operator, duration_min, soak_min, price): durata,
    posa e prezzo arrivano già decisi da resolve_items_edit, che per le voci
    esistenti conserva lo snapshot concordato con la cliente e per quelle nuove
    prende il listino. `order` = posizione nella catena.
    """
    for index, (service, operator, duration_min, soak_min, price) in enumerate(resolved):
        AppointmentService.objects.create(
            appointment=appointment,
            service=service,
            operator=operator,
            duration_min=duration_min,
            soak_min=soak_min,
            price=price,
            order=index,
        )


@transaction.atomic
def create_appointment(
    salon,
    client,
    items: list[dict],
    start: dt.datetime,
    *,
    via: str,
    actor=None,
    flexible: bool = False,
    note: str = "",
    location=None,
    allow_past: bool = True,
    force: bool = False,
    client_overlap_ok: bool = False,
    allow_soak: bool = True,
) -> Appointment:
    """Crea l'appuntamento rivalidando che lo slot sia libero (altrimenti 409).

    allow_past=False (app cliente): un orario già trascorso è rifiutato con 400.
    Lo staff può invece registrare a posteriori un appuntamento già avvenuto.
    force=True (solo staff): ignora turni, orari del centro e sovrapposizioni.
    Si prova comunque PRIMA senza forzare, come nella modifica: un orario
    battuto a mano fuori griglia ma libero (le 10:10) non va marcato «forzato»,
    e la «prima disponibile» va a chi è libera. Si forza solo sul 409.
    `client_overlap_ok=True` (gesti dello staff in agenda): due trattamenti
    sulla stessa cliente possono stare nella stessa fascia — è una seduta sola,
    non un conflitto — e l'appuntamento NON viene marcato come forzato.
    `allow_soak=False` (app cliente): nemmeno con la stilista scelta si entra
    nella posa di un'altra cliente, che resta una decisione dello staff.

    La caparra si calcola su quanto la cliente pagherà in salone, cioè al netto
    dei servizi coperti dalle sue gift card «a trattamento». Nessuna caparra per
    una visita che è già cominciata (walk-in inserito all'ora corrente, visita
    registrata a posteriori): il link di pagamento partiva mentre la cliente era
    sulla poltrona, e la caparra restava «richiesta» senza scadenza.
    """
    now = timezone.now()
    if not allow_past and start < now:
        raise HttpError(400, "Non è possibile prenotare un orario già passato")
    lock_salon(salon)
    kwargs = {
        "location": location,
        "ignore_client_id": client.id if client_overlap_ok else None,
        "allow_soak": allow_soak,
    }
    forced = False
    try:
        resolved = resolve_items(salon, items, start, **kwargs)
    except HttpError as err:
        # Mai forzata l'idoneità (400): solo la disponibilità (409).
        if not force or err.status_code != 409:
            raise
        resolved = resolve_items(salon, items, start, force=True, **kwargs)
        forced = True

    total_price = sum((service.price for service, _ in resolved), start=Decimal("0"))
    if start <= now:
        deposit = Decimal("0.00")
    else:
        covered = gift_covered_amount(
            salon, client, [(service, service.price) for service, _ in resolved]
        )
        deposit = compute_deposit(salon, client, max(total_price - covered, Decimal("0")))

    appointment = Appointment.objects.create(
        salon=salon,
        location=location,
        client=client,
        operator=resolved[0][1],  # operatrice principale = quella del primo servizio
        start=start,
        flexible=flexible,
        note=note,
        created_via=via,
        forced=forced,
        deposit_amount=deposit,
        deposit_status=(
            Appointment.DepositStatus.REQUIRED
            if deposit > 0
            else Appointment.DepositStatus.NONE
        ),
    )
    snapshot_items(appointment, resolved)
    schedule_deposit_hold(appointment)

    log_activity(
        salon,
        "appointment.created",
        f"Nuovo appuntamento per {client.full_name}" + (" (forzato)" if forced else ""),
        actor=actor,
        location=location,
        payload={
            "appointment_id": appointment.id,
            "client_id": client.id,
            "start": appointment.start.isoformat(),
            "via": via,
            "forced": forced,
        },
    )
    emit_appointment_event(appointment, "appointment.created")
    undo_log.record(
        salon,
        kind=UndoEntry.Kind.CREATE,
        label=f"Nuovo appuntamento di {client.full_name}",
        actor=actor,
        after={"appointments": [undo_log.appointment_snapshot(appointment)]},
        created={"appointments": [appointment.id]},
    )
    return appointment


STALE_APPOINTMENT_MESSAGE = "L'appuntamento è stato modificato nel frattempo: ricarica e riprova"


def _to_millis(value: dt.datetime) -> dt.datetime:
    """Lo stesso istante al millesimo: è la precisione con cui l'API lo scrive in JSON."""
    return value.replace(microsecond=value.microsecond // 1000 * 1000)


@transaction.atomic
def edit_appointment(
    appointment: Appointment,
    *,
    items: list[dict] | None = None,
    note: str | None = None,
    force: bool = False,
    actor=None,
    expected_updated_at: dt.datetime | None = None,
    client_overlap_ok: bool = True,
) -> Appointment:
    """Modifica i servizi e/o la nota di una visita aperta.

    `items`, se presente, è la lista COMPLETA dei servizi voluti a partire da
    `appointment.start`: una voce con `id` è una riga già esistente (prezzo e
    posa restano quelli concordati), una senza `id` è un servizio aggiunto,
    quelle omesse vengono tolte.

    Tutto avviene dopo lock e rilettura, e si scrivono solo i campi toccati: la
    riga arrivava qui com'era all'inizio della richiesta e un save() completo
    riportava indietro stato e caparra cambiati nel frattempo — bastava
    correggere una nota mentre il webhook Stripe registrava il pagamento per
    riportare la caparra a «richiesta» e perdere il PaymentIntent, o per far
    ricomparire in agenda una visita annullata da un'altra postazione.

    412 (mai superabile forzando) quando chi scrive partiva da una copia
    vecchia: `expected_updated_at` diverso da quello attuale, oppure una voce
    con un `id` che non è una riga di questa visita. Ogni modifica e ogni
    «torna indietro» ricreano le righe con id nuovi, e dal pannello rimasto
    aperto gli id vecchi diventavano «servizi nuovi»: riprezzati a listino, e il
    servizio staccato nel frattempo tornava nella visita (pagato due volte).

    `client_overlap_ok` (di serie: la modifica è un gesto dello staff, l'app
    non ne ha una): come in creazione, la stessa cliente non occupa e la visita
    non diventa «forzata» per questo. Allungare un servizio accanto a un altro
    della stessa seduta rispondeva 409 e, ritentato forzando, la marcava.
    """
    _lock_and_reload(appointment)
    if expected_updated_at is not None and (
        _to_millis(appointment.updated_at) != _to_millis(expected_updated_at)
    ):
        raise HttpError(412, STALE_APPOINTMENT_MESSAGE)
    before = undo_log.appointment_snapshot(appointment)
    changed = ["updated_at"]
    if note is not None:
        appointment.note = note
        changed.append("note")
    if items is not None:
        if not items:
            raise HttpError(400, "Nessun servizio selezionato")
        existing = {item.id: item for item in appointment.items.select_related("operator")}
        if any(raw.get("id") is not None and raw.get("id") not in existing for raw in items):
            raise HttpError(412, STALE_APPOINTMENT_MESSAGE)
        kwargs = {
            "exclude_appointment_id": appointment.id,
            "location": appointment.location,
            # i servizi già sulla visita restano modificabili anche se nel
            # frattempo sono usciti dal listino
            "keep_service_ids": {item.service_id for item in existing.values()},
            "existing_items": existing,
            "ignore_client_id": appointment.client_id if client_overlap_ok else None,
        }
        try:
            resolved = resolve_items_edit(appointment.salon, items, appointment.start, **kwargs)
        except HttpError as err:
            # Si prova SEMPRE prima senza forzare: così una modifica che sta
            # comodamente nella giornata non marca la visita come forzata senza
            # motivo. Si forza solo se lo staff l'ha chiesto e il rifiuto era di
            # disponibilità (409) — mai di idoneità (400).
            if not force or err.status_code != 409:
                raise
            resolved = resolve_items_edit(appointment.salon, items, appointment.start, force=True, **kwargs)
            appointment.forced = True
            changed.append("forced")
        appointment.items.all().delete()
        snapshot_items_edit(appointment, resolved)
        appointment.operator = resolved[0][1]
        changed.append("operator")
    appointment.save(update_fields=changed)
    if items is not None:
        shrink_deposit_to_total(appointment, actor=actor)

    log_activity(
        appointment.salon,
        "appointment.updated",
        f"Appuntamento di {appointment.client.full_name} aggiornato",
        actor=actor,
        payload={"appointment_id": appointment.id},
    )
    # Cambiando i servizi cambia anche l'ora di fine: senza questo evento il
    # promemoria alla cliente continuava a riportare la durata vecchia.
    emit_appointment_event(appointment, "appointment.updated")
    undo_log.record(
        appointment.salon,
        kind=UndoEntry.Kind.EDIT,
        label=f"Modifica dell'appuntamento di {appointment.client.full_name}",
        actor=actor,
        before={"appointments": [before]},
        after={"appointments": [undo_log.appointment_snapshot(appointment)]},
    )
    return appointment


@transaction.atomic
def move_appointment(
    appointment: Appointment,
    new_start: dt.datetime,
    *,
    operator=None,
    from_operator=None,
    actor=None,
    force: bool = False,
    allow_past: bool = True,
    client_overlap_ok: bool = False,
) -> Appointment:
    """Sposta l'appuntamento (items con lo stesso delta, essendo sequenziali da start).

    Se `operator` è indicata, subentra sugli item di `from_operator` — che di
    default è l'operatrice principale — previa verifica di idoneità. In agenda
    `from_operator` è la COLONNA da cui parte il trascinamento: una visita può
    avere servizi di due operatrici, e trascinando il gruppo di una collega
    devono cambiare mano i suoi, non quelli della principale. Rivalida lo slot
    escludendo l'appuntamento stesso; emette appointment.moved e slot.freed sul
    vecchio orario.
    force=True (solo staff): salta la rivalidazione di turno e sovrapposizioni.
    allow_past=False (app cliente): come in creazione, un orario già trascorso è
    rifiutato. Lo staff può invece sistemare a posteriori un orario sbagliato.
    `client_overlap_ok=True` (gesti dello staff in agenda): due trattamenti
    sulla stessa cliente possono stare nella stessa fascia — è una seduta sola,
    non un conflitto — e l'appuntamento NON viene marcato come forzato.
    """
    if not allow_past and new_start < timezone.now():
        raise HttpError(400, "Non è possibile spostare l'appuntamento a un orario già passato")
    _lock_and_reload(appointment)
    before = undo_log.appointment_snapshot(appointment)
    old_start = appointment.start
    old_operator_id = appointment.operator_id

    items = list(appointment.items.select_related("service", "operator"))
    if not items:
        raise HttpError(400, "Appuntamento senza servizi")
    # Orari occupati prima dello spostamento: a spostamento fatto, la lista
    # d'attesa sente solo ciò che si è liberato davvero (vedi _sync_freed_slots).
    before_spans = _chain_spans(
        old_start, [(item.operator_id, item.duration_min, item.soak_min) for item in items]
    )

    source_id = from_operator.id if from_operator is not None else old_operator_id
    target_operators = []
    for item in items:
        if operator is not None and item.operator_id == source_id:
            if not item.service.operators.filter(id=operator.id).exists():
                raise HttpError(400, "Operatrice non idonea per il servizio selezionato")
            target_operators.append(operator)
        else:
            target_operators.append(item.operator)

    if not force:
        # Verifica anche che la permanenza della cliente, posa finale compresa,
        # stia dentro l'apertura del centro (la fascia in cui la visita
        # comincia): il controllo c'era solo in creazione, e spostando si
        # potevano portare i 60' di posa di un colore mezz'ora dopo la serranda
        # abbassata (anche dall'app cliente).
        _validate_segments(
            appointment.salon,
            new_start,
            [
                (item.duration_min, item.soak_min, op)
                for item, op in zip(items, target_operators)
            ],
            exclude_appointment_id=appointment.id,
            ignore_client_id=appointment.client_id if client_overlap_ok else None,
        )
        if not allow_past:
            # Dall'app cliente la posa di un'altra cliente resta intoccabile:
            # sovrapporvisi è una scelta che lo staff fa a mano, e la ricerca
            # dell'app quell'orario non lo propone. Lo spostamento lo
            # accettava comunque — da una lista vecchia di un minuto o da una
            # richiesta costruita a mano.
            _reject_soak_overlap(
                appointment,
                new_start,
                [
                    (item.duration_min, item.soak_min, op)
                    for item, op in zip(items, target_operators)
                ],
            )
    else:
        appointment.forced = True

    appointment.start = new_start
    # Si scrivono solo i campi dello spostamento: un save() completo
    # riporterebbe indietro tutto quello che è cambiato nel frattempo (stato,
    # caparra, note) sovrascrivendolo con la copia in memoria.
    changed = ["start", "updated_at"]
    if force:
        changed.append("forced")
    if operator is not None:
        # L'operatrice principale cambia solo se è la sua colonna ad aver
        # cambiato mano: spostando i servizi di una collega, la titolare della
        # visita resta quella di prima.
        if source_id == old_operator_id:
            appointment.operator = operator
            changed.append("operator")
        for item, target in zip(items, target_operators):
            if item.operator_id != target.id:
                item.operator = target
                item.save(update_fields=["operator"])
    appointment.save(update_fields=changed)

    log_activity(
        appointment.salon,
        "appointment.moved",
        f"Appuntamento di {appointment.client.full_name} spostato",
        actor=actor,
        payload={
            "appointment_id": appointment.id,
            "old_start": old_start.isoformat(),
            "new_start": appointment.start.isoformat(),
            "forced": force,
        },
    )
    knowledge = _slot_knowledge(appointment, before_spans)
    emit_appointment_event(
        appointment,
        "appointment.moved",
        {**_event_payload(appointment), "old_start": old_start.isoformat()},
    )
    # Prima si annunciava l'intera visita al vecchio orario, con l'operatrice
    # principale: anche per un ritocco di un quarto d'ora (ancora occupato) o
    # per un cambio di colonna, dove a liberarsi era la collega di partenza.
    _sync_freed_slots(appointment, before_spans, _appointment_spans(appointment), knowledge)
    undo_log.record(
        appointment.salon,
        kind=UndoEntry.Kind.MOVE,
        label=f"Spostamento dell'appuntamento di {appointment.client.full_name}",
        actor=actor,
        before={"appointments": [before]},
        after={"appointments": [undo_log.appointment_snapshot(appointment)]},
    )
    return appointment


@transaction.atomic
def split_appointment(
    appointment: Appointment,
    item_id: int,
    new_start: dt.datetime,
    *,
    operator=None,
    actor=None,
    force: bool = False,
    client_overlap_ok: bool = False,
) -> tuple[Appointment, Appointment]:
    """Stacca UN servizio da un appuntamento multi-servizio e lo sposta altrove
    (anche in un altro giorno), come appuntamento a sé della stessa cliente.

    Il servizio staccato mantiene durata, posa e prezzo dello snapshot. Gli altri
    NON si spostano, come mostra l'anteprima del trascinamento: staccando il
    primo, `start` della visita scala in avanti fino al servizio che lo seguiva;
    staccandone uno in mezzo, il suo tempo diventa attesa dopo il servizio
    precedente (il buco si vede in ambra nel dettaglio, con «Chiudi il buco»).
    Ricompattare la catena faceva invece anticipare in silenzio i servizi
    rimasti, e con il 409→force della dashboard finivano sopra un'altra
    cliente. La caparra resta sull'appuntamento di partenza. Con force=True si
    salta la verifica di disponibilità del servizio staccato.
    `client_overlap_ok=True` (gesti dello staff in agenda): due trattamenti
    sulla stessa cliente possono stare nella stessa fascia — è una seduta sola,
    non un conflitto — e l'appuntamento NON viene marcato come forzato.
    Ritorna (originale aggiornato, nuovo appuntamento).
    """
    _lock_and_reload(appointment)
    before = undo_log.appointment_snapshot(appointment)
    items = list(appointment.items.select_related("service", "operator").order_by("order", "id"))
    if len(items) < 2:
        raise HttpError(400, "L'appuntamento ha un solo servizio: usa «Sposta»")
    item = next((it for it in items if it.id == item_id), None)
    if item is None:
        raise HttpError(404, "Servizio non trovato nell'appuntamento")
    target = operator or item.operator
    if operator is not None and not item.service.operators.filter(id=operator.id).exists():
        raise HttpError(400, "Operatrice non idonea per il servizio selezionato")

    # Minuto (dall'inizio della visita) di ogni servizio PRIMA dello stacco:
    # serve per lasciare gli altri dov'erano. Senza questo, staccando il primo
    # servizio la catena ripartiva da `start` e la piega delle 11:00 diventava
    # delle 10:00 da sola.
    was_at: dict[int, int] = {}
    cursor = 0
    for existing in items:
        was_at[existing.id] = cursor
        cursor += existing.duration_min + existing.soak_min
    position = items.index(item)

    # Prima si stacca l'item, POI si valida: così il controllo vede la
    # situazione reale (i servizi rimasti da una parte, quello spostato
    # dall'altra) invece di escludere l'intera visita e lasciar passare una
    # sovrapposizione fra i due pezzi. Siamo in transazione: un conflitto
    # annulla tutto.
    service, duration_min, soak_min, price = item.service, item.duration_min, item.soak_min, item.price
    item.delete()
    remaining = list(appointment.items.select_related("operator").order_by("order", "id"))
    for index, rest in enumerate(remaining):
        if rest.order != index:
            rest.order = index
            rest.save(update_fields=["order"])
    changed = ["operator", "updated_at"]
    if position == 0:
        # Il primo servizio rimasto resta all'ora in cui era: la visita inizia da lì.
        appointment.start = appointment.start + dt.timedelta(minutes=was_at[remaining[0].id])
        changed.append("start")
    elif position < len(remaining):
        # Staccato in mezzo: chi veniva dopo resta alla sua ora, e il tempo del
        # servizio tolto diventa attesa dopo quello che lo precedeva.
        previous = remaining[position - 1]
        previous.soak_min += duration_min + soak_min
        previous.save(update_fields=["soak_min"])
    appointment.operator = remaining[0].operator
    appointment.save(update_fields=changed)
    # La visita di partenza ora vale meno: se la caparra la supera il conto non
    # si chiuderebbe più (la cassa dovrebbe incassare un importo negativo).
    shrink_deposit_to_total(appointment, actor=actor)

    created = Appointment.objects.create(
        salon=appointment.salon,
        location=appointment.location,
        client=appointment.client,
        operator=target,
        start=new_start,
        flexible=appointment.flexible,
        note=appointment.note,
        created_via=Appointment.CreatedVia.DASHBOARD,
        forced=force,
        deposit_amount=Decimal("0.00"),
        deposit_status=Appointment.DepositStatus.NONE,
    )
    AppointmentService.objects.create(
        appointment=created,
        service=service,
        operator=target,
        duration_min=duration_min,
        soak_min=soak_min,
        price=price,
        order=0,
    )

    if not force:
        # il servizio staccato non deve finire sopra nulla — ma i servizi della
        # STESSA cliente (compresi quelli rimasti nella visita di partenza) non
        # contano come ostacolo quando lo staff sta spostando a mano.
        ignore_client = appointment.client_id if client_overlap_ok else None
        _validate_segments(
            appointment.salon, new_start, [(duration_min, soak_min, target)],
            exclude_appointment_id=created.id,
            ignore_client_id=ignore_client,
        )

    client_name = appointment.client.full_name
    log_activity(
        appointment.salon,
        "appointment.split",
        f"{service.name_it} di {client_name} spostato in un appuntamento a parte",
        actor=actor,
        payload={
            "appointment_id": appointment.id,
            "created_id": created.id,
            "service_id": service.id,
            "new_start": created.start.isoformat(),
            "forced": force,
        },
    )
    emit_appointment_event(appointment, "appointment.updated")
    emit_appointment_event(created, "appointment.created")
    undo_log.record(
        appointment.salon,
        kind=UndoEntry.Kind.SPLIT,
        label=f"Stacco di {service.name_it} dall'appuntamento di {client_name}",
        actor=actor,
        before={"appointments": [before]},
        after={
            "appointments": [
                undo_log.appointment_snapshot(appointment),
                undo_log.appointment_snapshot(created),
            ]
        },
        created={"appointments": [created.id]},
    )
    return appointment, created


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
    undo_log.record(
        appointment.salon,
        kind=UndoEntry.Kind.STATUS,
        label=f"Check-in di {appointment.client.full_name}",
        actor=actor,
        before={"appointments": [before]},
        after={"appointments": [undo_log.appointment_snapshot(appointment)]},
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
    undo_log.record(
        appointment.salon,
        kind=UndoEntry.Kind.STATUS,
        label=f"Inizio trattamento di {appointment.client.full_name}",
        actor=actor,
        before={"appointments": [before]},
        after={"appointments": [undo_log.appointment_snapshot(appointment)]},
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
    occupied = _appointment_spans(appointment)
    knowledge = _slot_knowledge(appointment, occupied)
    emit_appointment_event(
        appointment, "appointment.no_show", {**_event_payload(appointment), "reason": reason}
    )
    _sync_freed_slots(appointment, occupied, {}, knowledge)
    undo_log.record(
        appointment.salon,
        kind=UndoEntry.Kind.NO_SHOW,
        label=f"No-show di {appointment.client.full_name}",
        actor=actor,
        before={"appointments": [before]},
        after={"appointments": [undo_log.appointment_snapshot(appointment)]},
    )
    return appointment


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
    (_client_policy_ok), quindi «tardivo» capitava solo quando era il SALONE ad
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
        late = by_client and appointment.start - timezone.now() < dt.timedelta(
            hours=settings.CLIENT_MOVE_CANCEL_MIN_HOURS
        )
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
            _close_deposit_link_after_commit(appointment)
        occupied = _appointment_spans(appointment)
        knowledge = _slot_knowledge(appointment, occupied)
        emit_appointment_event(
            appointment,
            "appointment.cancelled",
            {**_event_payload(appointment), "reason": reason, "late": late, "by_client": by_client},
        )
        _sync_freed_slots(appointment, occupied, {}, knowledge)
        # L'annullamento della CLIENTE dall'app non entra nello storico della
        # postazione: chi sta al banco non deve poter rimettere in agenda una
        # visita che la cliente ha disdetto (vedi `undoable`).
        if (not by_client) if undoable is None else undoable:
            undo_log.record(
                appointment.salon,
                kind=UndoEntry.Kind.CANCEL,
                label=f"Annullamento dell'appuntamento di {appointment.client.full_name}",
                actor=actor,
                before={"appointments": [before]},
                after={"appointments": [undo_log.appointment_snapshot(appointment)]},
            )
    if appointment.deposit_status == Appointment.DepositStatus.REFUND_DUE:
        settle_deposit_refund(appointment, actor=actor)
    return appointment


def settle_deposit_refund(appointment: Appointment, *, actor=None) -> Appointment:
    """Prova il rimborso Stripe della caparra «da rimborsare»; se riesce → «rimborsata».

    Se non è possibile (Stripe assente, caparra incassata in salone, errore)
    lo stato resta «da rimborsare» e il registro attività lo segnala: il
    rimborso va fatto a mano e poi confermato con `mark_deposit_refunded`.
    """
    from apps.sales.stripe_service import as_dict, refund_deposit  # lazy

    if appointment.deposit_status != Appointment.DepositStatus.REFUND_DUE:
        return appointment
    client_name = appointment.client.full_name
    refund = refund_deposit(appointment)
    if refund is not None:
        # Il Refund di stripe-python non è un dict: `.get()` esplodeva DOPO che
        # Stripe aveva già restituito i soldi, e la caparra restava «da rimborsare».
        refund = as_dict(refund)
        # Lo stato lo decide Stripe, non il fatto che la chiamata sia passata:
        # un rimborso «pending» non è denaro già tornato alla cliente.
        record_deposit_refund(
            appointment,
            refund_id=refund.get("id") or f"deposit-refund-{appointment.id}",
            cents=int(refund.get("amount") or 0) or _to_cents(appointment.deposit_amount),
            status=refund.get("status") or REFUND_DONE,
            actor=actor,
        )
    else:
        log_activity(
            appointment.salon,
            "deposit.refund_due",
            f"Caparra da rimborsare manualmente — {client_name}",
            actor=actor,
            payload={"appointment_id": appointment.id, "amount": str(appointment.deposit_amount)},
        )
    return appointment


def _sync_refund_moves(appointment: Appointment) -> None:
    """Il rimborso esce dalla cassa del giorno in cui avviene (vedi sales.DepositRefund)."""
    from apps.sales.services import sync_deposit_refunds  # lazy

    sync_deposit_refunds(appointment)


@transaction.atomic
def record_deposit_refund(
    appointment: Appointment,
    *,
    refund_id: str = "",
    cents: int = 0,
    status: str = REFUND_DONE,
    floor_cents: int = 0,
    actor=None,
) -> Appointment:
    """Registra un rimborso della caparra e ricalcola lo stato del deposito.

    I rimborsi si conservano uno per id Stripe: lo stesso evento ripetuto non
    conta due volte e un aggiornamento successivo (pending → succeeded, oppure
    → failed) corregge quello registrato prima — ma non lo riporta indietro:
    un evento vecchio arrivato tardi non conta (vedi `_REFUND_STATUS_RANK`).
    «Rimborsata» si scrive solo quando i rimborsi RIUSCITI coprono l'intera
    caparra; un rimborso parziale lascia la caparra pagata e riduce soltanto la
    quota detraibile al checkout.

    `floor_cents` è il totale già restituito dichiarato da `charge.refunded`:
    quell'evento non porta l'id del singolo rimborso, quindi vale come soglia
    minima e non come voce a sé. Si conserva (il massimo visto), altrimenti
    l'evento seguente lo dimenticava e lo stato restava «rimborsata» con zero
    euro restituiti.

    I confronti sono con `deposit_amount`, che per una caparra pagata è quanto
    è arrivato davvero (una visita accorciata non lo abbassa più).
    """
    # Prima il salone, poi la riga: lo stesso ordine di chi modifica l'agenda.
    # Al contrario, su PostgreSQL un rimborso e uno spostamento dello stesso
    # appuntamento potevano aspettarsi a vicenda (18-08).
    lock_salon(appointment.salon)
    # Lock di riga PRIMA della rilettura: `deposit_refunds` si legge, si
    # modifica e si riscrive per intero. Stripe consegna gli eventi in
    # parallelo, e due rimborsi parziali finivano per sovrascriversi a vicenda —
    # il secondo commit cancellava la voce del primo e al checkout si detraeva
    # denaro già tornato alla cliente.
    locked = list(
        Appointment.objects.select_for_update()
        .filter(pk=appointment.pk)
        .values_list("id", flat=True)
    )
    if not locked:
        raise HttpError(404, "Appuntamento non trovato")
    appointment.refresh_from_db()
    refunds = dict(appointment.deposit_refunds or {})
    ignored_update = False
    if refund_id:
        known = refunds.get(refund_id) or {}
        rank = _REFUND_STATUS_RANK.get(status or "", 0)
        if known and _REFUND_STATUS_RANK.get(known.get("status") or "", 0) > rank:
            ignored_update = True
        else:
            refunds[refund_id] = {**known, "amount_cents": int(cents or 0), "status": status}
    if floor_cents:
        floor = refunds.get(REFUND_FLOOR_KEY) or {}
        if int(floor_cents) > int(floor.get("amount_cents") or 0):
            refunds[REFUND_FLOOR_KEY] = {"amount_cents": int(floor_cents), "status": "floor"}

    def _sum(predicate) -> int:
        return sum(
            int(row.get("amount_cents") or 0)
            for key, row in refunds.items()
            if key != REFUND_FLOOR_KEY and predicate(row.get("status") or "")
        )

    done = _refunds_done_cents(refunds)
    in_flight = _sum(lambda st: st in REFUND_IN_FLIGHT)
    deposit_cents = _to_cents(appointment.deposit_amount)

    previous = appointment.deposit_status
    if deposit_cents > 0 and done >= deposit_cents:
        new_status = Appointment.DepositStatus.REFUNDED
    elif in_flight > 0:
        # Anche un rimborso PARZIALE in volo rende la caparra «in corso»: la
        # quota mostrata alla cassa è zero finché Stripe non conferma, e il
        # checkout restituisce da sé la parte che non ha detratto
        # (sales.services.deposit_retained). Lasciarla «pagata» avrebbe fatto
        # detrarre anche i soldi che stanno tornando alla cliente.
        new_status = Appointment.DepositStatus.REFUNDING
    elif previous in (Appointment.DepositStatus.REFUNDING, Appointment.DepositStatus.REFUNDED):
        # Il rimborso in volo è fallito o è stato annullato (o uno riuscito è
        # stato poi respinto): il denaro è ancora in cassa. Se l'appuntamento è
        # annullato resta da restituire, se è ancora in piedi la caparra torna
        # semplicemente pagata.
        new_status = (
            Appointment.DepositStatus.REFUND_DUE
            if appointment.status == Appointment.Status.CANCELLED
            else Appointment.DepositStatus.PAID
        )
    else:
        new_status = previous

    appointment.deposit_refunds = refunds
    appointment.deposit_refunded_amount = (Decimal(done) / 100).quantize(Decimal("0.01"))
    appointment.deposit_status = new_status
    appointment.save(
        update_fields=[
            "deposit_refunds",
            "deposit_refunded_amount",
            "deposit_status",
            "updated_at",
        ]
    )
    _sync_refund_moves(appointment)
    failed_meanwhile = (
        not ignored_update
        and refund_id
        and status in ("failed", "canceled")
        and new_status == previous == Appointment.DepositStatus.REFUNDED
    )
    if new_status != previous or failed_meanwhile:
        labels = {
            Appointment.DepositStatus.REFUNDED: "Caparra rimborsata",
            Appointment.DepositStatus.REFUNDING: "Rimborso caparra in corso",
            Appointment.DepositStatus.REFUND_DUE: "Rimborso caparra non riuscito, da rifare",
            Appointment.DepositStatus.PAID: "Rimborso caparra non riuscito",
        }
        label = labels.get(new_status, "Caparra aggiornata")
        if failed_meanwhile:
            # Stripe dichiara restituito il totale ma segnala un rimborso
            # fallito: lo stato resta, e qualcuno deve guardarci.
            label = "Stripe segnala un rimborso della caparra non riuscito: controlla il pagamento"
        log_activity(
            appointment.salon,
            "deposit.refunded" if new_status == Appointment.DepositStatus.REFUNDED and not failed_meanwhile
            else "deposit.refund_update",
            f"{label} — {appointment.client.full_name}",
            actor=actor,
            payload={
                "appointment_id": appointment.id,
                "refunded": str(appointment.deposit_refunded_amount),
                "amount": str(appointment.deposit_amount),
                "refund_id": refund_id,
                "status": status,
            },
        )
    return appointment


@transaction.atomic
def mark_deposit_refunded(appointment: Appointment, *, actor=None) -> Appointment:
    """Conferma manuale dello staff: la caparra «da rimborsare» è stata restituita.

    Scrive anche l'importo e una voce fra i rimborsi: `deposit_refunded_amount`
    è «la somma dei rimborsi riusciti», e dopo una conferma manuale restava a
    zero — il dettaglio diceva «rimborsata» senza importo e le riconciliazioni
    che sommano quel campo saltavano i rimborsi fatti in salone. Il rimborso
    esce anche dall'incasso del giorno (02-11): prima la caparra da 20 € resa in
    contanti restava in «Incassato oggi».

    Lock e rilettura prima di decidere, come per i rimborsi Stripe: la conferma
    arrivava su una copia letta all'inizio della richiesta e poteva cancellare
    un rimborso registrato un istante prima dal webhook.
    """
    lock_salon(appointment.salon)
    locked = list(
        Appointment.objects.select_for_update()
        .filter(pk=appointment.pk)
        .values_list("id", flat=True)
    )
    if not locked:
        raise HttpError(404, "Appuntamento non trovato")
    appointment.refresh_from_db()
    if appointment.deposit_status != Appointment.DepositStatus.REFUND_DUE:
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di rimborso")
    deposit_cents = _to_cents(appointment.deposit_amount)
    refunds = dict(appointment.deposit_refunds or {})
    # Quello che resta da coprire: se una parte era già tornata da Stripe, la
    # conferma manuale vale solo per la differenza.
    missing = max(deposit_cents - _refunds_done_cents(refunds), 0)
    if missing:
        refunds[f"manual-{appointment.id}-{int(timezone.now().timestamp())}"] = {
            "amount_cents": missing,
            "status": REFUND_DONE,
            "manual": True,
        }
    appointment.deposit_status = Appointment.DepositStatus.REFUNDED
    appointment.deposit_refunds = refunds
    appointment.deposit_refunded_amount = (Decimal(_refunds_done_cents(refunds)) / 100).quantize(
        Decimal("0.01")
    )
    appointment.save(
        update_fields=[
            "deposit_status",
            "deposit_refunds",
            "deposit_refunded_amount",
            "updated_at",
        ]
    )
    _sync_refund_moves(appointment)
    log_activity(
        appointment.salon,
        "deposit.refunded",
        f"Caparra rimborsata — {appointment.client.full_name}",
        actor=actor,
        payload={
            "appointment_id": appointment.id,
            "amount": str(appointment.deposit_amount),
            "refunded": str(appointment.deposit_refunded_amount),
            "manual": True,
        },
    )
    return appointment


# ---------------------------------------------------------------------------
# Caparra con scadenza: sollecito e rilascio automatico dello slot
# ---------------------------------------------------------------------------


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
        _event_payload(appointment),
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
    knowledge = _slot_knowledge(appointment, before_spans)
    emit_appointment_event(appointment, "appointment.released_unpaid")
    _sync_freed_slots(appointment, before_spans, {}, knowledge)
    _close_deposit_link_after_commit(appointment)
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
    pending = (
        Appointment.objects.filter(
            salon=salon,
            status=Appointment.Status.CONFIRMED,
            deposit_status=Appointment.DepositStatus.REQUIRED,
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


