"""Conferma di una prenotazione o di una modifica: chi fa cosa, e se ci sta.

A differenza della ricerca qui si decide per UN orario, e si rifiuta dicendo
perché: idoneità prima della libertà (404 servizio, 400 operatrice non idonea,
poi 409 orario occupato o fuori apertura), perché il banco riprova forzando
solo i 409.
"""

import datetime as dt
from typing import NamedTuple

from django.utils import timezone
from ninja.errors import HttpError

from ..models import Appointment
from .occupancy import (
    _bookable_service,
    _busy_map,
    _busy_maps,
    _ensure_within_opening,
    _operators_qs,
    _shift_windows_memo,
)
from .timegrid import _is_free, _overlaps


NO_ELIGIBLE_OPERATOR_MESSAGE = "Nessuna operatrice abilitata al servizio selezionato"


class ChainStep(NamedTuple):
    """Una voce della catena da assegnare (vedi `_assign_chain`).

    `requested` è l'operatrice indicata, None = la prima libera fra `eligible`;
    la voce impegna `duration_min` di lavoro attivo, poi `soak_min` di posa prima
    della voce successiva.
    """

    requested: object
    eligible: list
    duration_min: int
    soak_min: int


def _pick_operator(
    requested,
    eligible,
    windows_of,
    busy,
    same_client_busy,
    start: int,
    end: int,
    *,
    force: bool,
    allow_soak: bool,
):
    """Chi fa la voce [start, end): la regola unica di creazione e modifica.

    - operatrice indicata: lei, se libera (o forzando). Lì la stessa cliente non
      occupa (`same_client_busy`) e, se `allow_soak`, si entra nella posa altrui:
      è una scelta dello staff;
    - «prima disponibile»: la prima idonea libera con la mappa COMPLETA, come la
      ricerca. Con `ignore_client_id` la mappa senza la stessa cliente
      rendeva «libera» l'operatrice già impegnata con lei, e la visita nasceva
      sovrapposta su Giulia mentre la bozza diceva «farà Marta». La stessa
      cliente si ignora solo in seconda battuta; e forzando, solo se nessuna è
      libera si ripiega sulla prima idonea: prima si andava sempre sulla prima
      in ordine, occupata o no, con la collega libera accanto.
    None = nessuna libera (409 per il chiamante).
    """
    if requested is not None:
        if force or _is_free(
            windows_of(requested), same_client_busy.get(requested.id, ()), start, end,
            allow_soak=allow_soak,
        ):
            return requested
        return None
    maps = [busy] if same_client_busy is busy else [busy, same_client_busy]
    for current in maps:
        chosen = next(
            (
                op
                for op in eligible
                if _is_free(windows_of(op), current.get(op.id, ()), start, end, allow_soak=False)
            ),
            None,
        )
        if chosen is not None:
            return chosen
    return eligible[0] if force and eligible else None


def _chain_step(
    service, requested, operators, operator_by_id, duration_min: int, soak_min: int, *, previous=None
) -> ChainStep:
    """La voce di `service` con l'operatrice indicata (`requested`) o le idonee; 400 se non si può.

    `previous` (modifica) è la riga già sulla visita: chi ce l'ha la tiene
    anche se nel frattempo non è più prenotabile o non ha più quel servizio fra
    le competenze. Il controllo vale per chi riceve una voce nuova o cambia mano.
    """
    eligible_ids = set(service.operators.values_list("id", flat=True))
    if requested:
        operator = operator_by_id.get(requested)
        if previous is not None and requested == previous.operator_id:
            # Chi ha già la riga la tiene, anche fuori organico o senza più
            # quel servizio: non è una nuova assegnazione.
            operator = operator or previous.operator
        elif operator is None or operator.id not in eligible_ids:
            # L'idoneità non si forza MAI: nessuno può fare un servizio che
            # non sa fare, per quanto il banco insista.
            raise HttpError(400, "Operatrice non idonea per il servizio selezionato")
        return ChainStep(operator, [], duration_min, soak_min)
    eligible = [op for op in operators if op.id in eligible_ids]
    if not eligible:
        raise HttpError(400, NO_ELIGIBLE_OPERATOR_MESSAGE)
    return ChainStep(None, eligible, duration_min, soak_min)


def _assign_chain(
    salon,
    day: dt.date,
    first_min: int,
    steps: list[ChainStep],
    *,
    exclude_appointment_id: int | None,
    ignore_client_id: int | None,
    force: bool,
    allow_soak: bool,
) -> list:
    """Chi fa ogni voce della catena che parte al minuto `first_min`: le operatrici, in ordine.

    La parte comune di creazione e modifica. Per ogni voce `_pick_operator`
    sceglie sulla sola finestra ATTIVA; la catena avanza di attivo + posa. 409
    «Orario non più disponibile» se una voce non trova nessuna libera; senza
    `force`, anche se la catena (posa compresa) finisce oltre l'apertura del
    centro (`_ensure_within_opening`). Va chiamata a voci già validate: i 404 e
    i 400 dell'idoneità vengono prima di ogni 409, perché il banco riprova
    forzando solo quelli.
    """
    busy, same_client_busy = _busy_maps(
        salon, day, exclude_appointment_id=exclude_appointment_id, ignore_client_id=ignore_client_id
    )
    windows_of = _shift_windows_memo(day)
    chosen_operators = []
    cursor = first_min
    for step in steps:
        end = cursor + step.duration_min
        chosen = _pick_operator(
            step.requested, step.eligible, windows_of, busy, same_client_busy, cursor, end,
            force=force, allow_soak=allow_soak,
        )
        if chosen is None:
            raise HttpError(409, "Orario non più disponibile")
        chosen_operators.append(chosen)
        cursor = end + step.soak_min
    if not force:
        _ensure_within_opening(
            salon, day, cursor, force=False, start_min=first_min,
            windows=[w for op in set(chosen_operators) for w in windows_of(op)],
        )
    return chosen_operators


def resolve_items(
    salon,
    items: list[dict],
    start: dt.datetime,
    *,
    exclude_appointment_id: int | None = None,
    location=None,
    force: bool = False,
    ignore_client_id: int | None = None,
    allow_soak: bool = True,
) -> list[tuple]:
    """Risolve e valida la sequenza richiesta a partire da `start`.

    force=True (solo staff): salta turno, orari del centro e sovrapposizioni —
    resta solo l'idoneità dell'operatrice al servizio. È la via per lo
    straordinario o per "incastrare" una cliente sopra un'altra.

    Per ogni item individua il servizio e l'operatrice (quella indicata, se
    idonea e libera, altrimenti la prima idonea libera: vedi `_pick_operator`).
    La libertà è verificata sulla sola finestra ATTIVA del servizio; la catena
    avanza di attivo + posa. Con operatrice indicata a mano è ammessa la
    sovrapposizione alla posa altrui solo se `allow_soak` (i gesti dello staff):
    dall'app la conferma era più larga della ricerca, e la cliente che aveva
    scelto la stilista finiva nella posa di un'altra. In auto-assegnazione mai.
    Solleva, idoneità PRIMA della libertà (il banco riprova forzando solo i 409):
    - 404 servizio inesistente, 400 operatrice non idonea o nessuna abilitata,
    - 409 "Orario non più disponibile" se lo slot non è libero.

    Ritorna [(service, operator), ...] nell'ordine richiesto.
    """
    if not items:
        raise HttpError(400, "Nessun servizio selezionato")

    local = timezone.localtime(start)
    day = local.date()
    first_min = local.hour * 60 + local.minute

    operators = list(_operators_qs(salon, location))
    operator_by_id = {op.id: op for op in operators}
    services, steps = [], []
    for raw in items:
        service = _bookable_service(salon, raw.get("service_id"))
        steps.append(_chain_step(
            service, raw.get("operator_id"), operators, operator_by_id,
            service.duration_min, service.soak_min or 0,
        ))
        services.append(service)
    chosen = _assign_chain(
        salon, day, first_min, steps,
        exclude_appointment_id=exclude_appointment_id, ignore_client_id=ignore_client_id,
        force=force, allow_soak=allow_soak,
    )
    return list(zip(services, chosen))


def resolve_items_edit(
    salon,
    items: list[dict],
    start: dt.datetime,
    *,
    exclude_appointment_id: int | None = None,
    location=None,
    keep_service_ids=(),
    existing_items=None,
    force: bool = False,
    ignore_client_id: int | None = None,
) -> list[tuple]:
    """Come resolve_items ma con durata per-item sovrascrivibile manualmente.

    Per ogni item la durata EFFETTIVA è raw["duration_min"] quando è un int
    positivo, altrimenti la durata già scritta sulla visita (se l'item esisteva)
    o quella di listino. La catena avanza sulla durata effettiva e la libertà
    viene validata su quell'intervallo. Regole di scelta operatrice identiche a
    resolve_items (`_pick_operator`), idoneità prima della libertà:
    - 404 servizio inesistente, 400 operatrice non idonea o nessuna abilitata
      (un servizio nuovo che nessuna sa fare rispondeva 409 anche forzando, e il
      banco cercava invano un buco libero),
    - 409 "Orario non più disponibile" se lo slot non è libero.

    Sulle righe ESISTENTI l'operatrice già assegnata resta ammessa anche se nel
    frattempo è stata disattivata, lavora in un'altra sede o non ha più quel
    servizio fra le competenze: si controlla solo chi riceve una voce nuova o
    cambia mano. Prima bastava una riga della collega uscita per rispondere
    «Operatrice non idonea» — anche forzando — a ogni allungamento o servizio
    aggiunto sul resto della visita.

    `ignore_client_id` (gesti dello staff): la stessa cliente non occupa, come
    in creazione. Allungare un servizio accanto a un altro della stessa seduta
    rispondeva 409 e, ritentato forzando, marcava la visita «forzata».

    `keep_service_ids` sono i servizi GIÀ presenti sull'appuntamento: restano
    ammessi anche se nel frattempo sono stati tolti dal listino, altrimenti una
    visita vecchia non sarebbe più modificabile. Un servizio disattivato che non
    c'era prima non si può invece aggiungere.

    `force=True` (solo gesti dello staff): l'operatrice richiesta si tiene anche
    se in quella fascia è occupata, e la catena può sforare la chiusura. Serve
    per allungare un trattamento accanto a un incastro già forzato, che con la
    sola verifica di libertà rispondeva «Orario non più disponibile» a un
    trascinamento che deve solo scrivere.

    `existing_items` è {AppointmentService.id: riga} della visita: quando l'item
    arriva con `id`, prezzo e posa restano quelli CONCORDATI con la cliente. Un
    AppointmentService è uno snapshot del listino del giorno della prenotazione:
    ricrearlo dal listino di oggi significava che allungare di dieci minuti un
    taglio prenotato a 35 lo faceva costare 40, senza che nessuno l'avesse
    deciso. Solo le voci nuove (senza `id`) prendono prezzo e posa dal listino.

    Ritorna [(service, operator, duration_min, soak_min, price), ...].
    """
    keep = set(keep_service_ids or ())

    if not items:
        raise HttpError(400, "Nessun servizio selezionato")

    local = timezone.localtime(start)
    day = local.date()
    first_min = local.hour * 60 + local.minute

    operators = list(_operators_qs(salon, location))
    operator_by_id = {op.id: op for op in operators}

    known = existing_items or {}
    agreed, steps = [], []
    for raw in items:
        service = _bookable_service(salon, raw.get("service_id"), keep_ids=keep)
        # la voce è quella già sulla visita solo se l'id combacia E il servizio è
        # lo stesso: altrimenti è un servizio nuovo che ha riciclato un id.
        previous = known.get(raw.get("id"))
        if previous is not None and previous.service_id != service.id:
            previous = None
        raw_duration = raw.get("duration_min")
        # durata ATTIVA effettiva: override solo se int positivo, altrimenti lo
        # snapshot della visita e, per le voci nuove, il listino
        default_duration = previous.duration_min if previous is not None else service.duration_min
        duration_min = (
            raw_duration
            if isinstance(raw_duration, int) and not isinstance(raw_duration, bool) and raw_duration > 0
            else default_duration
        )
        # Posa/attesa: si può scrivere (`soak_min`), perché è il buco fra un
        # servizio e il successivo e lo decide il salone. Se non arriva vale lo
        # snapshot della visita, o il listino per le voci nuove. Il prezzo no:
        # quello resta sempre quello concordato con la cliente.
        raw_soak = raw.get("soak_min")
        default_soak = previous.soak_min if previous is not None else (service.soak_min or 0)
        soak = (
            raw_soak
            if isinstance(raw_soak, int) and not isinstance(raw_soak, bool) and raw_soak >= 0
            else default_soak
        )
        price = previous.price if previous is not None else service.price
        steps.append(_chain_step(
            service, raw.get("operator_id"), operators, operator_by_id, duration_min, soak,
            previous=previous,
        ))
        agreed.append((service, duration_min, soak, price))

    # Operatrice indicata a mano: può sovrapporsi alla posa altrui (è un gesto
    # dello staff); in auto-assegnazione mai. Anche in modifica la cliente
    # resta in salone fino alla fine della posa (il controllo di chiusura di
    # `_assign_chain`): il vincolo esisteva solo in creazione, e allungando un
    # colore dall'app la visita finiva dopo la serranda abbassata.
    chosen = _assign_chain(
        salon, day, first_min, steps,
        exclude_appointment_id=exclude_appointment_id, ignore_client_id=ignore_client_id,
        force=force, allow_soak=True,
    )
    return [
        (service, operator, duration_min, soak, price)
        for (service, duration_min, soak, price), operator in zip(agreed, chosen)
    ]


def _validate_segments(
    salon,
    start: dt.datetime,
    segments: list[tuple],
    *,
    exclude_appointment_id: int | None = None,
    ignore_client_id: int | None = None,
) -> None:
    """Valida una sequenza già assegnata: segments = [(active_min, soak_min, operator)].

    Usata per lo spostamento (durate = snapshot attivo/posa degli item). Essendo
    un'azione MANUALE dello staff, ogni finestra attiva è validata con
    allow_soak=True: può sovrapporsi alla posa altrui, mai al lavoro attivo/pausa.
    Solleva 409 se un segmento non è dentro turno o collide con un intervallo
    bloccante. La catena avanza di attivo + posa.

    In chiusura si verifica anche che la catena, posa compresa, stia dentro gli
    orari del centro — la fascia in cui comincia, o il turno se il salone non ha
    orari (vedi `_chain_deadline`): il vincolo viveva solo nella creazione, e
    spostando la stessa visita dall'app cliente la posa finiva a serranda
    abbassata.
    """
    local = timezone.localtime(start)
    day = local.date()
    first_min = cursor = local.hour * 60 + local.minute
    busy = _busy_map(
        salon,
        day,
        exclude_appointment_id=exclude_appointment_id,
        ignore_client_id=ignore_client_id,
    )
    windows_of = _shift_windows_memo(day)
    for active_min, soak_min, operator in segments:
        end = cursor + active_min
        if not _is_free(
            windows_of(operator), busy.get(operator.id, ()), cursor, end,
            allow_soak=True,
        ):
            raise HttpError(409, "Orario non più disponibile")
        cursor = end + (soak_min or 0)
    _ensure_within_opening(
        salon, day, cursor, force=False, start_min=first_min,
        windows=[w for op in {op for _, _, op in segments} for w in windows_of(op)],
    )


def _reject_soak_overlap(appointment: Appointment, start: dt.datetime, segments: list[tuple]) -> None:
    """409 se un lavoro attivo della catena cade nella posa di un'altra cliente.

    Complemento di `_validate_segments` (che per lo staff la ammette) per le
    richieste dell'app: segments = [(active_min, soak_min, operator)].
    """
    local = timezone.localtime(start)
    cursor = local.hour * 60 + local.minute
    busy = _busy_map(appointment.salon, local.date(), exclude_appointment_id=appointment.id)
    for active_min, soak_min, operator in segments:
        end = cursor + active_min
        soaks = [(s, e) for s, e, hard in busy.get(operator.id, ()) if not hard]
        if _overlaps(soaks, cursor, end):
            raise HttpError(409, "Orario non più disponibile")
        cursor = end + (soak_min or 0)
