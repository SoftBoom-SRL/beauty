"""I gesti sugli appuntamenti: creazione, modifica, spostamento, stacco di un servizio.

Ognuno lavora sotto lock (salone, poi riga), rivalida l'orario con le regole
della conferma (`resolution`), emette il messaggio per Yourang (`messages`),
allinea gli annunci alla lista d'attesa (`freed_slots`) e si registra per
«torna indietro» (`undo`).
"""

import datetime as dt
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity

from .. import undo as undo_log
from ..models import Appointment, AppointmentService, UndoEntry
from .deposit_holds import schedule_deposit_hold
from .deposits import compute_deposit, gift_covered_amount, shrink_deposit_to_total
from .freed_slots import _appointment_spans, _chain_spans, emit_with_freed_slots
from .locking import _lock_and_reload, lock_salon
from .messages import _event_payload, emit_appointment_event
from .resolution import (
    ResolvedItem,
    _reject_soak_overlap,
    _validate_segments,
    resolve_items,
    resolve_items_edit,
)


def _write_items(appointment: Appointment, rows: list[ResolvedItem]) -> None:
    """Crea gli AppointmentService della visita: uno snapshot per voce, `order` = posizione.

    Durata, posa e prezzo arrivano già decisi (`ResolvedItem`): il listino per
    una prenotazione nuova, e in modifica lo snapshot concordato con la cliente
    per le voci esistenti e il listino per quelle nuove (`resolve_items_edit`).
    """
    for index, row in enumerate(rows):
        AppointmentService.objects.create(
            appointment=appointment,
            service=row.service,
            operator=row.operator,
            duration_min=row.duration_min,
            soak_min=row.soak_min,
            price=row.price,
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

    total_price = sum((row.price for row in resolved), start=Decimal("0"))
    if start <= now:
        deposit = Decimal("0.00")
    else:
        covered = gift_covered_amount(
            salon, client, [(row.service, row.price) for row in resolved]
        )
        deposit = compute_deposit(salon, client, max(total_price - covered, Decimal("0")))

    appointment = Appointment.objects.create(
        salon=salon,
        location=location,
        client=client,
        operator=resolved[0].operator,  # operatrice principale = quella del primo servizio
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
    _write_items(appointment, resolved)
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
        _write_items(appointment, resolved)
        appointment.operator = resolved[0].operator
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
    # Alla lista d'attesa va solo ciò che si è liberato: prima si annunciava
    # l'intera visita al vecchio orario, con l'operatrice principale, anche per
    # un ritocco di un quarto d'ora (ancora occupato) o per un cambio di
    # colonna, dove a liberarsi era la collega di partenza.
    emit_with_freed_slots(
        appointment,
        "appointment.moved",
        {**_event_payload(appointment), "old_start": old_start.isoformat()},
        before=before_spans,
        after=_appointment_spans(appointment),
    )
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
    _write_items(created, [ResolvedItem(service, target, duration_min, soak_min, price)])

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
