"""Disponibilità: gli orari liberi per una sequenza di servizi, e quelli consigliati.

La ricerca (`get_free_slots`) e la conferma di uno spostamento dall'app
(`slot_assignment`) usano lo stesso piano e la stessa scelta delle operatrici:
l'orario che la cliente vede è quello che la conferma applica.
"""

import datetime as dt
from collections import defaultdict
from typing import NamedTuple

from django.conf import settings
from django.utils import timezone
from ninja.errors import HttpError

from common.intervals import merge_intervals

from .occupancy import _bookable_service, _busy_map, _chain_deadline, _opening_bands, _operators_qs
from .timegrid import _is_free, _slot_datetime, day_and_minute


class PlanStep(NamedTuple):
    """Una voce del piano di ricerca (vedi `_slot_plan`).

    `candidates` sono le operatrici fra cui scegliere, `duration_min` e
    `soak_min` il lavoro attivo e la posa della voce; `group` (spostamento di
    una visita) è l'id dell'operatrice non più prenotabile le cui righe passano
    tutte a UNA sola collega, None altrimenti.
    """

    service: object
    candidates: list
    duration_min: int
    soak_min: int
    group: int | None


def _slot_plan(salon, items: list[dict], operators, *, moving: bool, keep_service_ids=()):
    """Piano della ricerca: per ogni voce un `PlanStep` (servizio, candidate, attivo, posa, gruppo).

    None se una voce non ha nessuna operatrice possibile: allora non c'è orario.

    `moving` = si cerca dove spostare una visita esistente, e `items` sono le sue
    righe. Solo allora:
    - la riga resta a chi ce l'ha anche se nel frattempo ha perso quel servizio
      fra le competenze: lo spostamento non la riassegna e non la ricontrolla, e
      pretendere l'idoneità di oggi lasciava le clienti senza un solo orario in
      nessun giorno (il titolare toglie «Colore» a una junior e le visite già
      fissate con lei non si spostano più);
    - una riga di un'operatrice non più prenotabile (disattivata, o che lavora
      in un'altra sede) si cerca fra le altre idonee, e TUTTE le righe di
      quell'operatrice formano un gruppo che passa a UNA sola collega: è quello
      che la conferma sa applicare (`move_appointment` riassegna una colonna).
    Per una prenotazione NUOVA l'operatrice indicata e non prenotabile non si
    sostituisce in silenzio: la ricerca proponeva orari di un'altra e la
    conferma rispondeva «Operatrice non idonea» a ogni tentativo (la stilista
    dell'altra sede scelta dall'app).
    """
    operator_by_id = {op.id: op for op in operators}
    keep = set(keep_service_ids or ())
    plan: list[PlanStep] = []
    for raw in items:
        service = _bookable_service(salon, raw.get("service_id"), keep_ids=keep)
        eligible_ids = set(service.operators.values_list("id", flat=True))
        requested = raw.get("operator_id")
        eligible = [op for op in operators if op.id in eligible_ids]
        group = None
        if requested and requested in operator_by_id:
            operator = operator_by_id[requested]
            candidates = [operator] if operator.id in eligible_ids or moving else []
        elif requested and moving:
            # L'operatrice della visita non è più in organico (o lavora in
            # un'altra sede): si cerca fra le altre idonee invece di non
            # proporre niente, altrimenti quando un'operatrice lasciava il
            # salone le sue clienti non trovavano più un orario per spostarsi.
            candidates = eligible
            group = requested
        elif requested:
            candidates = []
        else:
            candidates = eligible
        if not candidates:
            return None  # nessuna operatrice idonea: mai disponibile
        duration = int(raw.get("duration_min") or service.duration_min)
        soak = raw.get("soak_min")
        soak = int(service.soak_min or 0) if soak is None else int(soak)
        plan.append(PlanStep(service, candidates, duration, soak, group))
    return plan


def _chain_at(plan, windows, busy, tick: int, bands):
    """Assegnazione della catena che parte al minuto `tick`, o None se non ci sta.

    Ritorna (assignment, segments): `segments` sono (operatrice, inizio, fine)
    con la POSA della voce compresa, per il calcolo dei buchi.
    """
    # Le voci sono sequenziali: dove cade ciascuna dipende solo da `tick`.
    positions = []
    cursor = tick
    for _service, _candidates, duration_min, soak_min, _group in plan:
        positions.append((cursor, cursor + duration_min))
        # il prossimo servizio parte dopo lavoro attivo + posa di questo
        cursor += duration_min + soak_min

    def free(op, index):
        start, end = positions[index]
        # disponibilità automatica: la posa altrui conta come occupata
        # (allow_soak=False), quindi uno slot non viene MAI offerto se
        # cadrebbe nella finestra di posa di un altro appuntamento.
        return _is_free(windows.get(op.id, []), busy.get(op.id, ()), start, end, allow_soak=False)

    by_group: dict = {}
    assignment = []
    segments = []
    for index, (service, candidates, _duration, soak_min, group) in enumerate(plan):
        if group is None:
            chosen = next((op for op in candidates if free(op, index)), None)
        else:
            if group not in by_group:
                members = [i for i, step in enumerate(plan) if step.group == group]
                by_group[group] = next(
                    (
                        op
                        for op in candidates
                        if all(op in plan[i].candidates and free(op, i) for i in members)
                    ),
                    None,
                )
            chosen = by_group[group]
        if chosen is None:
            return None
        start, end = positions[index]
        assignment.append({"service_id": service.id, "operator_id": chosen.id})
        segments.append((chosen, start, end + soak_min))

    # La cliente resta in salone anche durante la posa finale: uno slot che la
    # porta oltre la chiusura veniva offerto e poi rifiutato alla conferma.
    chain_windows = [w for op in {s[0] for s in segments} for w in windows.get(op.id, [])]
    deadline = _chain_deadline(bands, tick, chain_windows)
    if deadline is not None and cursor > deadline[0]:
        return None
    return assignment, segments


def _search_context(
    salon, day: dt.date, items: list[dict], location, *, exclude_appointment_id, keep_service_ids
):
    """(piano, finestre di turno, impegni) per cercare in quel giorno; None se una voce non ha operatrici.

    È lo stesso per la ricerca (`get_free_slots`) e per un orario solo
    (`slot_assignment`): la conferma applica proprio quello che la ricerca ha
    proposto.
    """
    from apps.staff.services import shift_windows  # lazy

    operators = list(_operators_qs(salon, location))
    plan = _slot_plan(
        salon, items, operators,
        moving=exclude_appointment_id is not None, keep_service_ids=keep_service_ids,
    )
    if plan is None:
        return None
    windows = {op.id: shift_windows(op, day) for op in operators}
    busy = _busy_map(salon, day, exclude_appointment_id=exclude_appointment_id)
    return plan, windows, busy


def get_free_slots(
    salon,
    date: dt.date,
    items: list[dict],
    location=None,
    *,
    exclude_appointment_id: int | None = None,
    keep_service_ids=(),
) -> list[dict]:
    """Slot liberi per una sequenza di servizi.

    items = [{"service_id": int, "operator_id": int | None,
              "duration_min": int | None, "soak_min": int | None}]
    operator_id None = qualsiasi idonea. `duration_min`/`soak_min` servono per
    lo spostamento di un appuntamento già preso: valgono le durate scritte sulla
    visita, non quelle del listino di oggi. Cercando col listino aggiornato si
    proponevano orari che la conferma rifiutava — la visita dura ancora quello
    che durava quando è stata prenotata.
    exclude_appointment_id: la ricerca serve a SPOSTARE quell'appuntamento, e
    `items` sono le sue righe: non conta come occupato (altrimenti il suo
    stesso orario non verrebbe mai riproposto) e le operatrici delle righe si
    trattano come in `_slot_plan`.
    keep_service_ids: servizi già sulla visita, ammessi anche se disattivati.

    Griglia dall'intervallo fasce orarie del salone (SalonSettings.slot_interval_min,
    default settings.AGENDA_SLOT_STEP_MIN). Un orario t è valido se i servizi
    si concatenano in sequenza da t e per ciascuno esiste un'operatrice idonea
    (in `service.operators`) libera per l'intera finestra: dentro le proprie
    shift_windows, senza sovrapposizioni con appuntamenti attivi né pause.
    I servizi sono sequenziali (mai sovrapposti tra loro), quindi la scelta
    greedy per singolo servizio è completa: non serve backtracking.

    Ritorna [{"start": iso, "assignment": [{"service_id", "operator_id"}]}].
    """
    if not items:
        raise HttpError(400, "Nessun servizio selezionato")

    salon_settings = getattr(salon, "settings", None)
    step = getattr(salon_settings, "slot_interval_min", None) or settings.AGENDA_SLOT_STEP_MIN
    context = _search_context(
        salon, date, items, location,
        exclude_appointment_id=exclude_appointment_id, keep_service_ids=keep_service_ids,
    )
    if context is None:
        return []
    plan, windows, busy = context
    min_useful = _min_useful_minutes(salon, step)

    all_windows = [
        w for entry in plan for op in entry.candidates for w in windows.get(op.id, [])
    ]
    if not all_windows:
        return []
    grid_start = min(w[0] for w in all_windows)
    grid_end = max(w[1] for w in all_windows)
    first_tick = ((grid_start + step - 1) // step) * step  # allinea alla griglia

    now = timezone.now()
    bands = _opening_bands(salon, date)
    slots = []
    for tick in range(first_tick, grid_end, step):
        chain = _chain_at(plan, windows, busy, tick, bands)
        if chain is None:
            continue
        assignment, segments = chain
        start_dt = _slot_datetime(date, tick)
        if start_dt is None:  # ora inesistente (passaggio all'ora legale)
            continue
        if start_dt < now:  # niente slot nel passato
            continue
        slots.append({
            "start": start_dt.isoformat(),
            "assignment": assignment,
            "recommended": _slot_is_recommended(segments, windows, busy, min_useful),
        })
    return slots


def slot_assignment(
    salon,
    start: dt.datetime,
    items: list[dict],
    location=None,
    *,
    exclude_appointment_id: int | None = None,
    keep_service_ids=(),
) -> list[dict] | None:
    """L'assegnazione che `get_free_slots` propone per quell'orario, o None.

    Stesso piano e stessa scelta della ricerca, calcolati per un solo orario: è
    ciò che permette alla conferma di applicare esattamente quello che la
    cliente ha visto (lo spostamento di una visita la cui operatrice non c'è
    più). Il passato non si scarta qui: lo rifiuta chi scrive.
    """
    if not items:
        raise HttpError(400, "Nessun servizio selezionato")
    day, minute = day_and_minute(start)
    context = _search_context(
        salon, day, items, location,
        exclude_appointment_id=exclude_appointment_id, keep_service_ids=keep_service_ids,
    )
    if context is None:
        return None
    plan, windows, busy = context
    chain = _chain_at(plan, windows, busy, minute, _opening_bands(salon, day))
    return chain[0] if chain else None


def _min_useful_minutes(salon, step: int) -> int:
    """Il buco più piccolo ancora vendibile: la durata del servizio attivo più corto."""
    from django.db.models import Min

    from apps.catalog.models import Service  # lazy

    shortest = Service.objects.filter(salon=salon, active=True).aggregate(m=Min("duration_min"))["m"]
    return max(int(shortest or 0), step)


def _gap_edges(windows, busy, start: int, end: int) -> tuple[int, int]:
    """Minuti liberi fra [start, end) e il blocco (o bordo turno) più vicino, prima e dopo.

    Conta come blocco anche la POSA (intervalli soft): la disponibilità
    automatica non la vende mai, quindi per chi prenota è tempo occupato. Contata
    come spazio libero, l'orario attaccato alla fine della posa di un'altra
    cliente risultava lasciare un buco e spariva dai consigliati, mentre quello
    che lasciava davvero un quarto d'ora morto veniva consigliato.
    La finestra è quella in cui [start, end) comincia: la posa finale può
    uscire dal turno (l'operatrice non serve), e allora dopo non c'è buco.
    """
    window = next(((ws, we) for ws, we in windows if ws <= start < we), None)
    if window is None:
        return 0, 0
    blocks = [(s, e) for s, e, _hard in busy]
    prev_end = max([window[0]] + [e for s, e in blocks if e <= start])
    next_start = min([window[1]] + [s for s, e in blocks if s >= end])
    return start - prev_end, next_start - end


def _slot_is_recommended(segments, windows, busy, min_useful: int) -> bool:
    """Uno slot è consigliato se non crea buchi invendibili in NESSUNA agenda.

    Un buco è invendibile quando è più corto del servizio più breve a listino:
    nessuna cliente lo prenoterà. Gli orari adiacenti a una prenotazione o al
    bordo del turno (buco = 0), o che lasciano spazio per almeno un altro
    servizio, sono quelli che tengono l'agenda compatta. È il criterio che
    l'app cliente usa in modalità ottimizzata; la dashboard li evidenzia.

    Si guardano i bordi di OGNI operatrice coinvolta, non solo il primo e
    l'ultimo servizio della catena: con una visita divisa fra due operatrici,
    il ritaglio che il primo servizio lasciava nella giornata di chi lo esegue
    non veniva mai contato, e proprio gli orari che spezzettano l'agenda
    finivano fra i consigliati. I segmenti della catena stessa contano come
    occupati, altrimenti l'uno sembrerebbe lasciare un buco dove c'è l'altro.
    Ogni segmento arriva con la SUA posa compresa: la posa di un colore seguita
    dalla piega della stessa operatrice non è un buco (con la posa esclusa
    colore+piega non aveva mai un orario consigliato), e un colore la cui posa
    finisce esattamente quando arriva la cliente dopo non lascia niente.
    """
    if not segments:
        return True

    def wasted(gap):
        return 0 < gap < min_useful

    spans_by_op: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for operator, start, end in segments:
        spans_by_op[operator.id].append((start, end))

    for op_id, spans in spans_by_op.items():
        runs = merge_intervals(spans)
        occupied = list(busy.get(op_id, ())) + [(s, e, True) for s, e in runs]
        op_windows = windows.get(op_id, [])
        for start, end in runs:
            others = [b for b in occupied if not (b[0] == start and b[1] == end and b[2])]
            gap_before, gap_after = _gap_edges(op_windows, others, start, end)
            if wasted(gap_before) or wasted(gap_after):
                return False
    return True


def smart_slots(salon, slots: list[dict]) -> list[dict]:
    """Slot da proporre alle clienti: solo i consigliati se il salone è in modalità
    ottimizzata (SalonSettings.agenda_fill = max_revenue); tutti se nessuno lo è."""
    salon_settings = getattr(salon, "settings", None)
    fill = getattr(salon_settings, "agenda_fill", "max_revenue") or "max_revenue"
    if fill != "max_revenue":
        return slots
    recommended = [s for s in slots if s.get("recommended", True)]
    return recommended or slots
