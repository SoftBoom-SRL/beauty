"""Logica dell'agenda: disponibilità, depositi, creazione/spostamento/annullamento.

Convenzioni interne:
- tutti i calcoli di disponibilità lavorano in MINUTI DA MEZZANOTTE del giorno
  richiesto, nel fuso del salone (settings.TIME_ZONE);
- gli import verso staff/clients/catalog sono lazy (le app sono sviluppate in
  parallelo e si evita ogni rischio di ciclo);
- le finestre lavorabili arrivano da `staff.services.shift_windows(operator, date)`
  -> list[tuple[int, int]] (minuti), già al netto di pause pranzo e assenze.
"""

import datetime as dt
import logging
from collections import defaultdict
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import DepositRule
from apps.core.services import emit_event, log_activity
from common.conditions import evaluate

from .models import Appointment, AppointmentService, Pause, WaitlistEntry

logger = logging.getLogger("youty.agenda")

# Stati in cui l'appuntamento è ancora "aperto" e quindi modificabile.
OPEN_STATUSES = (
    Appointment.Status.CONFIRMED,
    Appointment.Status.CHECKED_IN,
    Appointment.Status.IN_PROGRESS,
)


# ---------------------------------------------------------------------------
# Primitive su intervalli (minuti da mezzanotte)
# ---------------------------------------------------------------------------


def _minutes_local(value: dt.datetime) -> int:
    local = timezone.localtime(value)
    return local.hour * 60 + local.minute


def _slot_datetime(day: dt.date, minutes: int) -> dt.datetime | None:
    """Istante del minuto `minutes` di quel giorno, None se quell'ora locale non esiste.

    La notte del passaggio all'ora legale un'ora sparisce dagli orologi (in Italia
    le 02:00-02:59 dell'ultima domenica di marzo): `make_aware` la converte
    comunque, e l'agenda proponeva un orario che nessuna cliente vedrà mai sul
    telefono. Se il giro di andata e ritorno non riporta lo stesso minuto locale,
    l'orario semplicemente non esiste e non va offerto.
    """
    naive = dt.datetime.combine(day, dt.time.min) + dt.timedelta(minutes=minutes)
    aware = timezone.make_aware(naive)
    # Il giro per UTC normalizza l'orologio da parete: se tornando indietro non
    # si riottiene lo stesso orario, quell'ora locale non è mai esistita. (Un
    # confronto diretto non basta: convertire un orario nel suo stesso fuso lo
    # lascia com'è, anche quando è impossibile.)
    if timezone.localtime(aware.astimezone(dt.timezone.utc)).replace(tzinfo=None) != naive:
        return None
    return aware


def _overlaps(intervals, start: int, end: int) -> bool:
    return any(b_start < end and b_end > start for b_start, b_end in intervals)


def _within_windows(windows, start: int, end: int) -> bool:
    # L'intervallo deve stare per intero DENTRO UNA sola finestra di turno
    # (un servizio non può scavalcare la pausa pranzo).
    return any(w_start <= start and end <= w_end for w_start, w_end in windows)


def _is_free(windows, busy, start: int, end: int, allow_soak: bool = False) -> bool:
    """Vero se [start, end) sta dentro una finestra di turno e non collide con
    alcun intervallo BLOCCANTE dell'operatrice.

    `busy` è una lista di tuple (start_min, end_min, hard):
    - hard=True  -> lavoro attivo o pausa: blocca SEMPRE (conflitto reale);
    - hard=False -> posa (soak): blocca solo se allow_soak è False.

    Con allow_soak=True gli intervalli di posa NON bloccano: una sovrapposizione
    manuale sulla posa altrui è ammessa (decisione dello staff), mai automatica.
    """
    if not _within_windows(windows, start, end):
        return False
    blocking = [(s, e) for s, e, hard in busy if hard or not allow_soak]
    return not _overlaps(blocking, start, end)


def _busy_map(
    salon,
    day: dt.date,
    exclude_appointment_id: int | None = None,
    ignore_client_id: int | None = None,
) -> dict:
    """Intervalli occupati per operatrice: {op_id: [(start_min, end_min, hard), ...]}.

    Due livelli per ogni AppointmentService concatenato da `start`:
    - ATTIVO  (offset .. offset+duration_min)          -> hard=True  (blocca sempre)
    - POSA    (fine attivo .. +soak_min), se soak_min>0 -> hard=False (soft)
    Le pause manuali sono sempre hard. Considera solo gli appuntamenti attivi
    (status non cancelled/no_show).

    `ignore_client_id`: gli appuntamenti di QUELLA cliente non occupano niente.
    Serve ai gesti dello staff, dove due trattamenti sulla stessa persona nella
    stessa seduta (nail art mentre asciuga la manicure) sono una cosa normale e
    non un conflitto da forzare. Non si passa mai dall'app cliente: là due
    prenotazioni sovrapposte sarebbero un errore, non una scelta.

    Si legge anche il giorno PRECEDENTE: un appuntamento serale lungo (o con
    posa) può finire dopo mezzanotte, e la coda occupa l'operatrice in questo
    giorno. Gli offset del giorno prima sono negativi rispetto a oggi, quindi
    restano solo gli intervalli che finiscono dopo le 00:00. Vale anche per le
    pause, che possono durare fino a dodici ore: una pausa dalle 23:00 lasciava
    libera tutta la mattina dopo.
    """
    busy: dict[int, list[tuple[int, int, bool]]] = defaultdict(list)

    previous = day - dt.timedelta(days=1)
    appointments = (
        Appointment.objects.filter(salon=salon, start__date__in=(previous, day))
        .exclude(status__in=Appointment.INACTIVE_STATUSES)
        .prefetch_related("items")
    )
    if exclude_appointment_id:
        appointments = appointments.exclude(id=exclude_appointment_id)
    if ignore_client_id:
        appointments = appointments.exclude(client_id=ignore_client_id)
    for appointment in appointments:
        offset = _minutes_local(appointment.start)
        if timezone.localtime(appointment.start).date() != day:
            offset -= 1440  # iniziato ieri: oggi conta solo la coda dopo mezzanotte
        for item in appointment.items.all():  # già ordinati per (order, id)
            active_end = offset + item.duration_min
            if active_end > 0:
                busy[item.operator_id].append((offset, active_end, True))
            if item.soak_min and active_end + item.soak_min > 0:
                busy[item.operator_id].append(
                    (active_end, active_end + item.soak_min, False)
                )
            offset = active_end + item.soak_min

    for pause in Pause.objects.filter(salon=salon, start__date__in=(previous, day)):
        start = _minutes_local(pause.start)
        if timezone.localtime(pause.start).date() != day:
            start -= 1440  # iniziata ieri: oggi conta solo la coda dopo mezzanotte
        end = start + pause.duration_min
        if end > 0:
            busy[pause.operator_id].append((start, end, True))

    return busy


def _operators_qs(salon, location=None):
    from apps.staff.models import Operator  # lazy

    qs = (
        Operator.objects.filter(salon=salon, active=True)
        .select_related("salon__settings")
        .prefetch_related("shifts", "absences")
    )
    if location is not None:
        # Operatrici della sede richiesta + quelle senza sede assegnata.
        qs = qs.filter(Q(location__isnull=True) | Q(location=location))
    return qs.order_by("order", "id")


def lock_salon(salon) -> None:
    """Serializza le scritture in agenda del salone dentro la transazione corrente.

    «Controllo che lo slot sia libero» e «inserisco» non sono atomici di per sé:
    su PostgreSQL due richieste simultanee potevano superare entrambe la
    verifica prima che una delle due fosse visibile all'altra, e finire
    sovrapposte. Il lock sulla riga del salone (SELECT … FOR UPDATE) fa
    attendere la seconda finché la prima non ha committato. Su SQLite è un
    no-op, ma lì le scritture sono già seriali. Va chiamata DENTRO atomic().
    """
    from apps.core.models import Salon  # lazy

    list(Salon.objects.select_for_update().filter(pk=salon.pk).values_list("id", flat=True))


def _bookable_service(salon, service_id, *, keep_ids=()):
    """Servizio del salone, attivo. 404 se non esiste o è stato disattivato.

    `keep_ids` elenca i servizi già presenti su una visita esistente: quelli
    restano validi anche se il listino li ha ritirati, altrimenti spostare un
    appuntamento diventerebbe impossibile il giorno in cui si toglie un servizio.
    """
    from apps.catalog.models import Service  # lazy

    service = Service.objects.filter(id=service_id, salon=salon).first()
    if service is None:
        raise HttpError(404, "Servizio non trovato")
    if not service.active and service.id not in set(keep_ids or ()):
        raise HttpError(404, "Servizio non più disponibile")
    return service


# ---------------------------------------------------------------------------
# Disponibilità
# ---------------------------------------------------------------------------


def default_location(salon):
    """La sede su cui lavora l'app cliente: la predefinita, altrimenti la prima.

    Ricerca e prenotazione devono guardare la stessa: cercando su tutte le sedi
    e prenotando su quella predefinita, l'app proponeva orari di un'operatrice
    che lavora altrove e poi rispondeva 409 alla conferma.
    """
    return salon.locations.filter(is_default=True).first() or salon.locations.first()


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
    exclude_appointment_id: l'appuntamento che si sta spostando non conta come
    occupato (altrimenti il suo stesso orario non verrebbe mai riproposto).
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
    from apps.staff.services import opening_windows, shift_windows  # lazy

    if not items:
        raise HttpError(400, "Nessun servizio selezionato")

    salon_settings = getattr(salon, "settings", None)
    step = getattr(salon_settings, "slot_interval_min", None) or settings.AGENDA_SLOT_STEP_MIN
    operators = list(_operators_qs(salon, location))
    operator_by_id = {op.id: op for op in operators}

    # (servizio, [operatrici candidate], durata attiva, posa) per ogni voce
    plan: list[tuple] = []
    keep = set(keep_service_ids or ())
    for raw in items:
        service = _bookable_service(salon, raw.get("service_id"), keep_ids=keep)
        eligible_ids = set(service.operators.values_list("id", flat=True))
        requested = raw.get("operator_id")
        eligible = [op for op in operators if op.id in eligible_ids]
        if requested and requested in operator_by_id:
            operator = operator_by_id[requested]
            candidates = [operator] if operator.id in eligible_ids else []
        elif requested:
            # L'operatrice indicata non è più in organico (o lavora in un'altra
            # sede): si cerca fra le altre idonee invece di non proporre niente.
            # Quando un'operatrice lasciava il salone, le clienti con una visita
            # fissata con lei non trovavano più un solo orario per spostarla.
            candidates = eligible
        else:
            candidates = eligible
        if not candidates:
            return []  # nessuna operatrice idonea: mai disponibile
        duration = int(raw.get("duration_min") or service.duration_min)
        soak = raw.get("soak_min")
        soak = int(service.soak_min or 0) if soak is None else int(soak)
        plan.append((service, candidates, duration, soak))

    windows = {op.id: shift_windows(op, date) for op in operators}
    busy = _busy_map(salon, date, exclude_appointment_id=exclude_appointment_id)
    min_useful = _min_useful_minutes(salon, step)

    all_windows = [
        w for _, candidates, _, _ in plan for op in candidates for w in windows.get(op.id, [])
    ]
    if not all_windows:
        return []
    grid_start = min(w[0] for w in all_windows)
    grid_end = max(w[1] for w in all_windows)
    first_tick = ((grid_start + step - 1) // step) * step  # allinea alla griglia

    now = timezone.now()
    # La cliente resta in salone anche durante la posa finale: uno slot che la
    # porta oltre la chiusura veniva offerto e poi rifiutato alla conferma.
    bounds = opening_windows(salon, date)
    closing = max((close for _, close in bounds), default=None) if bounds else None
    slots = []
    for tick in range(first_tick, grid_end, step):
        cursor = tick
        assignment = []
        segments = []  # (operatrice, inizio, fine attivo) per il punteggio dei buchi
        feasible = True
        for service, candidates, duration_min, soak_min in plan:
            end = cursor + duration_min
            # disponibilità automatica: la posa altrui conta come occupata
            # (allow_soak=False), quindi uno slot non viene MAI offerto se
            # cadrebbe nella finestra di posa di un altro appuntamento.
            chosen = next(
                (
                    op
                    for op in candidates
                    if _is_free(
                        windows.get(op.id, []), busy.get(op.id, ()), cursor, end,
                        allow_soak=False,
                    )
                ),
                None,
            )
            if chosen is None:
                feasible = False
                break
            assignment.append({"service_id": service.id, "operator_id": chosen.id})
            segments.append((chosen, cursor, end))
            # il prossimo servizio parte dopo lavoro attivo + posa di questo
            cursor = end + soak_min
        if not feasible:
            continue
        if closing is not None and cursor > closing:
            continue
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


def _min_useful_minutes(salon, step: int) -> int:
    """Il buco più piccolo ancora vendibile: la durata del servizio attivo più corto."""
    from django.db.models import Min

    from apps.catalog.models import Service  # lazy

    shortest = Service.objects.filter(salon=salon, active=True).aggregate(m=Min("duration_min"))["m"]
    return max(int(shortest or 0), step)


def _gap_edges(windows, busy, start: int, end: int) -> tuple[int, int]:
    """Minuti liberi fra [start, end) e il blocco (o bordo turno) più vicino, prima e dopo."""
    window = next(((ws, we) for ws, we in windows if ws <= start and end <= we), None)
    if window is None:
        return 0, 0
    hard = [(s, e) for s, e, is_hard in busy if is_hard]
    prev_end = max([window[0]] + [e for s, e in hard if e <= start])
    next_start = min([window[1]] + [s for s, e in hard if s >= end])
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
    """
    if not segments:
        return True

    def wasted(gap):
        return 0 < gap < min_useful

    spans_by_op: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for operator, start, end in segments:
        spans_by_op[operator.id].append((start, end))

    for op_id, spans in spans_by_op.items():
        runs: list[tuple[int, int]] = []
        for start, end in sorted(spans):
            if runs and start <= runs[-1][1]:
                runs[-1] = (runs[-1][0], max(runs[-1][1], end))
            else:
                runs.append((start, end))
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


# ---------------------------------------------------------------------------
# Deposito
# ---------------------------------------------------------------------------


def _rule_matches(rule, facts) -> bool:
    """Valuta le condizioni di una regola caparra senza poter far saltare la prenotazione.

    Le condizioni si scrivono dall'interfaccia: una regola malformata sollevava
    un'eccezione dentro `compute_deposit` e quindi bloccava OGNI prenotazione del
    salone finché qualcuno non la correggeva. Una regola che non si riesce a
    valutare semplicemente non si applica, e lascia una traccia nei log.
    """
    try:
        return bool(evaluate(rule.conditions, facts))
    except Exception:  # noqa: BLE001 - qualunque errore nella regola, non nel booking
        logger.warning(
            "Regola caparra #%s ignorata: condizioni non valutabili (%r)",
            rule.id, rule.conditions, exc_info=True,
        )
        return False


def compute_deposit(salon, client, total_price) -> Decimal:
    """Importo del deposito richiesto per il cliente sul totale indicato.

    - client.deposit_always -> prima regola attiva qualunque (per priority);
    - altrimenti prima DepositRule attiva le cui conditions matchano i facts
      del cliente (clients.services.client_facts);
    - pct -> percentuale del totale, fixed -> importo. 0 se nessuna regola.

    L'importo non supera mai il totale: una regola a importo fisso di 50 € su un
    servizio da 30 € rendeva il conto impossibile da chiudere (la cassa avrebbe
    dovuto incassare −20 €).
    """
    total_price = Decimal(str(total_price or 0))
    rules = list(DepositRule.objects.filter(salon=salon, active=True))  # ordering: priority
    if not rules:
        return Decimal("0.00")

    if getattr(client, "deposit_always", False):
        rule = rules[0]
    else:
        from apps.clients.services import client_facts  # lazy

        facts = client_facts(client)
        rule = next((r for r in rules if _rule_matches(r, facts)), None)

    if rule is None:
        return Decimal("0.00")
    if rule.amount_type == DepositRule.AmountType.PERCENT:
        amount = (total_price * rule.amount / Decimal("100")).quantize(Decimal("0.01"))
    else:
        amount = Decimal(rule.amount).quantize(Decimal("0.01"))
    return min(max(amount, Decimal("0.00")), total_price.quantize(Decimal("0.01")))


# ---------------------------------------------------------------------------
# Validazione slot per creazione / spostamento
# ---------------------------------------------------------------------------


def _ensure_within_opening(salon, day: dt.date, end_min: int, *, force: bool) -> None:
    """La catena, POSA COMPRESA, deve finire entro la chiusura del centro.

    La libertà dell'operatrice si verifica sulla sola finestra attiva, perché
    durante la posa è libera di lavorare su un'altra cliente. La CLIENTE però
    resta in salone: senza questo controllo si poteva prenotare un colore la cui
    posa finiva mezz'ora dopo la serranda abbassata. Lo staff può forzare.
    """
    if force:
        return
    from apps.staff.services import opening_windows  # lazy

    bounds = opening_windows(salon, day)
    if not bounds:
        return  # orari non configurati (None) o giorno di chiusura: decide il turno
    if end_min > max(close for _, close in bounds):
        raise HttpError(409, "Il servizio finirebbe dopo la chiusura del centro")


def resolve_items(
    salon,
    items: list[dict],
    start: dt.datetime,
    *,
    exclude_appointment_id: int | None = None,
    location=None,
    force: bool = False,
    ignore_client_id: int | None = None,
) -> list[tuple]:
    """Risolve e valida la sequenza richiesta a partire da `start`.

    force=True (solo staff): salta turno, orari del centro e sovrapposizioni —
    resta solo l'idoneità dell'operatrice al servizio. È la via per lo
    straordinario o per "incastrare" una cliente sopra un'altra.

    Per ogni item individua il servizio e l'operatrice (quella indicata, se
    idonea e libera, altrimenti la prima idonea libera). La libertà è verificata
    sulla sola finestra ATTIVA del servizio; la catena avanza di attivo + posa.
    Con operatrice indicata a mano è ammessa la sovrapposizione alla posa altrui
    (allow_soak=True); in auto-assegnazione mai (allow_soak=False). Solleva:
    - 404 servizio inesistente, 400 operatrice non idonea,
    - 409 "Orario non più disponibile" se lo slot non è libero.

    Ritorna [(service, operator), ...] nell'ordine richiesto.
    """
    from apps.staff.services import shift_windows  # lazy

    if not items:
        raise HttpError(400, "Nessun servizio selezionato")

    local = timezone.localtime(start)
    day = local.date()
    cursor = local.hour * 60 + local.minute

    busy = _busy_map(
        salon,
        day,
        exclude_appointment_id=exclude_appointment_id,
        ignore_client_id=ignore_client_id,
    )
    operators = list(_operators_qs(salon, location))
    operator_by_id = {op.id: op for op in operators}
    windows_cache: dict[int, list] = {}

    def _windows(op):
        if op.id not in windows_cache:
            windows_cache[op.id] = shift_windows(op, day)
        return windows_cache[op.id]

    resolved = []
    for raw in items:
        service = _bookable_service(salon, raw.get("service_id"))
        eligible_ids = set(service.operators.values_list("id", flat=True))
        active = service.duration_min
        end = cursor + active
        requested = raw.get("operator_id")
        # operatrice scelta a mano -> può sovrapporsi alla posa altrui;
        # assegnazione automatica (requested is None) -> mai nella posa altrui.
        allow_soak = requested is not None
        chosen = None
        if requested:
            operator = operator_by_id.get(requested)
            if operator is None or operator.id not in eligible_ids:
                raise HttpError(400, "Operatrice non idonea per il servizio selezionato")
            if force or _is_free(
                _windows(operator), busy.get(operator.id, ()), cursor, end,
                allow_soak=allow_soak,
            ):
                chosen = operator
        elif force:
            chosen = next((op for op in operators if op.id in eligible_ids), None)
            if chosen is None:
                raise HttpError(400, "Nessuna operatrice abilitata al servizio selezionato")
        else:
            chosen = next(
                (
                    op
                    for op in operators
                    if op.id in eligible_ids
                    and _is_free(
                        _windows(op), busy.get(op.id, ()), cursor, end,
                        allow_soak=False,
                    )
                ),
                None,
            )
        if chosen is None:
            raise HttpError(409, "Orario non più disponibile")
        resolved.append((service, chosen))
        cursor = end + (service.soak_min or 0)
    _ensure_within_opening(salon, day, cursor, force=force)
    return resolved


def resolve_items_edit(
    salon,
    items: list[dict],
    start: dt.datetime,
    *,
    exclude_appointment_id: int | None = None,
    location=None,
    keep_service_ids=(),
    existing_items=None,
) -> list[tuple]:
    """Come resolve_items ma con durata per-item sovrascrivibile manualmente.

    Per ogni item la durata EFFETTIVA è raw["duration_min"] quando è un int
    positivo, altrimenti la durata già scritta sulla visita (se l'item esisteva)
    o quella di listino. La catena avanza sulla durata effettiva e la libertà
    viene validata su quell'intervallo. Regole di scelta operatrice identiche a
    resolve_items:
    - 404 servizio inesistente, 400 operatrice non idonea,
    - 409 "Orario non più disponibile" se lo slot non è libero.

    `keep_service_ids` sono i servizi GIÀ presenti sull'appuntamento: restano
    ammessi anche se nel frattempo sono stati tolti dal listino, altrimenti una
    visita vecchia non sarebbe più modificabile. Un servizio disattivato che non
    c'era prima non si può invece aggiungere.

    `existing_items` è {AppointmentService.id: riga} della visita: quando l'item
    arriva con `id`, prezzo e posa restano quelli CONCORDATI con la cliente. Un
    AppointmentService è uno snapshot del listino del giorno della prenotazione:
    ricrearlo dal listino di oggi significava che allungare di dieci minuti un
    taglio prenotato a 35 lo faceva costare 40, senza che nessuno l'avesse
    deciso. Solo le voci nuove (senza `id`) prendono prezzo e posa dal listino.

    Ritorna [(service, operator, duration_min, soak_min, price), ...].
    """
    from apps.catalog.models import Service  # lazy
    from apps.staff.services import shift_windows  # lazy

    keep = set(keep_service_ids or ())

    if not items:
        raise HttpError(400, "Nessun servizio selezionato")

    local = timezone.localtime(start)
    day = local.date()
    cursor = local.hour * 60 + local.minute

    busy = _busy_map(salon, day, exclude_appointment_id=exclude_appointment_id)
    operators = list(_operators_qs(salon, location))
    operator_by_id = {op.id: op for op in operators}
    windows_cache: dict[int, list] = {}

    def _windows(op):
        if op.id not in windows_cache:
            windows_cache[op.id] = shift_windows(op, day)
        return windows_cache[op.id]

    known = existing_items or {}
    resolved = []
    for raw in items:
        service = Service.objects.filter(id=raw.get("service_id"), salon=salon).first()
        if service is None:
            raise HttpError(404, "Servizio non trovato")
        if not service.active and service.id not in keep:
            raise HttpError(404, "Servizio non più disponibile")
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
        # posa e prezzo: dallo snapshot se la voce esisteva, dal listino se è nuova
        soak = previous.soak_min if previous is not None else (service.soak_min or 0)
        price = previous.price if previous is not None else service.price
        eligible_ids = set(service.operators.values_list("id", flat=True))
        end = cursor + duration_min
        requested = raw.get("operator_id")
        allow_soak = requested is not None
        chosen = None
        if requested:
            operator = operator_by_id.get(requested)
            if operator is None or operator.id not in eligible_ids:
                raise HttpError(400, "Operatrice non idonea per il servizio selezionato")
            if _is_free(
                _windows(operator), busy.get(operator.id, ()), cursor, end,
                allow_soak=allow_soak,
            ):
                chosen = operator
        else:
            chosen = next(
                (
                    op
                    for op in operators
                    if op.id in eligible_ids
                    and _is_free(
                        _windows(op), busy.get(op.id, ()), cursor, end,
                        allow_soak=False,
                    )
                ),
                None,
            )
        if chosen is None:
            raise HttpError(409, "Orario non più disponibile")
        resolved.append((service, chosen, duration_min, soak, price))
        cursor = end + soak
    # Anche in modifica la cliente resta in salone fino alla fine della posa:
    # il vincolo esisteva solo in creazione, e allungando un colore dall'app la
    # visita finiva dopo la serranda abbassata.
    _ensure_within_opening(salon, day, cursor, force=False)
    return resolved


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
    orari del centro: il vincolo viveva solo nella creazione, e spostando la
    stessa visita dall'app cliente la posa finiva a serranda abbassata.
    """
    from apps.staff.services import shift_windows  # lazy

    local = timezone.localtime(start)
    day = local.date()
    cursor = local.hour * 60 + local.minute
    busy = _busy_map(
        salon,
        day,
        exclude_appointment_id=exclude_appointment_id,
        ignore_client_id=ignore_client_id,
    )
    windows_cache: dict[int, list] = {}
    for active_min, soak_min, operator in segments:
        end = cursor + active_min
        if operator.id not in windows_cache:
            windows_cache[operator.id] = shift_windows(operator, day)
        if not _is_free(
            windows_cache[operator.id], busy.get(operator.id, ()), cursor, end,
            allow_soak=True,
        ):
            raise HttpError(409, "Orario non più disponibile")
        cursor = end + (soak_min or 0)
    _ensure_within_opening(salon, day, cursor, force=False)


# ---------------------------------------------------------------------------
# Mutazioni
# ---------------------------------------------------------------------------


def _ensure_open(appointment: Appointment) -> None:
    if appointment.status not in OPEN_STATUSES:
        raise HttpError(400, "Appuntamento non modificabile nello stato attuale")


def _lock_and_reload(appointment: Appointment) -> None:
    """Prende il lock del salone e RILEGGE l'appuntamento dentro la transazione.

    L'istanza arriva qui caricata quando la richiesta è entrata: nel frattempo
    un'altra postazione può averla annullata. Decidendo sullo stato vecchio, lo
    spostamento passava il controllo e il save() successivo riscriveva anche
    `status`, riportando in agenda un appuntamento annullato. La rilettura
    avviene DOPO il lock, altrimenti si rileggerebbe di nuovo un dato che può
    cambiare un istante dopo.
    """
    lock_salon(appointment.salon)
    try:
        appointment.refresh_from_db()
    except Appointment.DoesNotExist:
        raise HttpError(404, "Appuntamento non trovato")
    _ensure_open(appointment)


def _event_payload(appointment: Appointment) -> dict:
    """Payload standard per Yourang: id + dati utili (nome, telefono, lingua, orari ISO)."""
    client = appointment.client
    return {
        "appointment_id": appointment.id,
        "client_id": client.id,
        "client_name": client.full_name,
        "phone": client.phone,
        "lang": client.lang,
        "start": appointment.start.isoformat(),
        "end": appointment.end.isoformat(),
        "operator_id": appointment.operator_id,
        "services": [
            {
                "id": item.service_id,
                "name": item.service.name_it,
                "duration_min": item.duration_min,
            }
            for item in appointment.items.select_related("service")
        ],
        "total_price": str(appointment.total_price),
        "deposit_amount": str(appointment.deposit_amount),
        "deposit_status": appointment.deposit_status,
        "deposit_due_at": appointment.deposit_due_at.isoformat() if appointment.deposit_due_at else None,
        "deposit_payment_link": appointment.deposit_payment_link or "",
    }


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
) -> Appointment:
    """Crea l'appuntamento rivalidando che lo slot sia libero (altrimenti 409).

    allow_past=False (app cliente): un orario già trascorso è rifiutato con 400.
    Lo staff può invece registrare a posteriori un appuntamento già avvenuto.
    force=True (solo staff): ignora turni, orari del centro e sovrapposizioni.
    `client_overlap_ok=True` (gesti dello staff in agenda): due trattamenti
    sulla stessa cliente possono stare nella stessa fascia — è una seduta sola,
    non un conflitto — e l'appuntamento NON viene marcato come forzato.
    """
    if not allow_past and start < timezone.now():
        raise HttpError(400, "Non è possibile prenotare un orario già passato")
    lock_salon(salon)
    resolved = resolve_items(
        salon, items, start, location=location, force=force,
        ignore_client_id=client.id if client_overlap_ok else None,
    )

    total_price = sum((service.price for service, _ in resolved), start=Decimal("0"))
    deposit = compute_deposit(salon, client, total_price)

    appointment = Appointment.objects.create(
        salon=salon,
        location=location,
        client=client,
        operator=resolved[0][1],  # operatrice principale = quella del primo servizio
        start=start,
        flexible=flexible,
        note=note,
        created_via=via,
        forced=force,
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
        f"Nuovo appuntamento per {client.full_name}" + (" (forzato)" if force else ""),
        actor=actor,
        location=location,
        payload={
            "appointment_id": appointment.id,
            "client_id": client.id,
            "start": appointment.start.isoformat(),
            "via": via,
            "forced": force,
        },
    )
    emit_event(salon, "appointment.created", _event_payload(appointment))
    return appointment


@transaction.atomic
def edit_appointment(
    appointment: Appointment,
    *,
    items: list[dict] | None = None,
    note: str | None = None,
    actor=None,
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
    """
    _lock_and_reload(appointment)
    changed = ["updated_at"]
    if note is not None:
        appointment.note = note
        changed.append("note")
    if items is not None:
        if not items:
            raise HttpError(400, "Nessun servizio selezionato")
        existing = {item.id: item for item in appointment.items.all()}
        resolved = resolve_items_edit(
            appointment.salon,
            items,
            appointment.start,
            exclude_appointment_id=appointment.id,
            location=appointment.location,
            # i servizi già sulla visita restano modificabili anche se nel
            # frattempo sono usciti dal listino
            keep_service_ids={item.service_id for item in existing.values()},
            existing_items=existing,
        )
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
    emit_event(appointment.salon, "appointment.updated", _event_payload(appointment))
    return appointment


def shrink_deposit_to_total(appointment: Appointment, *, actor=None) -> Decimal:
    """Riporta la caparra al totale della visita quando questa si accorcia.

    Staccando un servizio (o togliendolo dalla lista) il totale può scendere
    sotto la caparra già versata: il checkout avrebbe dovuto incassare un
    importo negativo e rispondeva 422 per sempre, senza più modo di chiudere il
    conto. La caparra scende al nuovo totale; l'eccedenza, se era già stata
    incassata, resta scritta nel registro come «da rimborsare». Il denaro non si
    muove da solo: lo restituisce lo staff, che decide come.

    Ritorna l'eccedenza (0 se non c'era).
    """
    total = sum(
        (item.price for item in AppointmentService.objects.filter(appointment=appointment)),
        start=Decimal("0"),
    ).quantize(Decimal("0.01"))
    amount = Decimal(str(appointment.deposit_amount or 0)).quantize(Decimal("0.01"))
    excess = amount - total
    if excess <= 0:
        return Decimal("0.00")

    appointment.deposit_amount = total
    appointment.save(update_fields=["deposit_amount", "updated_at"])
    if appointment.deposit_status == Appointment.DepositStatus.PAID:
        log_activity(
            appointment.salon,
            "deposit.refund_due",
            f"Caparra eccedente da rimborsare ({excess} €) — {appointment.client.full_name}",
            actor=actor,
            payload={
                "appointment_id": appointment.id,
                "amount": str(excess),
                "deposit_amount": str(total),
                "reason": "visita ridotta",
            },
        )
    return excess


@transaction.atomic
def move_appointment(
    appointment: Appointment,
    new_start: dt.datetime,
    *,
    operator=None,
    actor=None,
    force: bool = False,
    allow_past: bool = True,
    client_overlap_ok: bool = False,
) -> Appointment:
    """Sposta l'appuntamento (items con lo stesso delta, essendo sequenziali da start).

    Se `operator` è indicata, subentra all'operatrice principale sui suoi item
    (previa verifica di idoneità). Rivalida lo slot escludendo l'appuntamento
    stesso; emette appointment.moved e slot.freed sul vecchio orario.
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
    old_start = appointment.start
    old_operator_id = appointment.operator_id

    items = list(appointment.items.select_related("service", "operator"))
    if not items:
        raise HttpError(400, "Appuntamento senza servizi")

    target_operators = []
    for item in items:
        if operator is not None and item.operator_id == old_operator_id:
            if not item.service.operators.filter(id=operator.id).exists():
                raise HttpError(400, "Operatrice non idonea per il servizio selezionato")
            target_operators.append(operator)
        else:
            target_operators.append(item.operator)

    if not force:
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
    emit_event(
        appointment.salon,
        "appointment.moved",
        {**_event_payload(appointment), "old_start": old_start.isoformat()},
    )
    free_slot_event(appointment, start=old_start, operator_id=old_operator_id)
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

    Il servizio staccato mantiene durata, posa e prezzo dello snapshot; gli altri
    restano concatenati dall'orario originale. La caparra resta sull'appuntamento
    di partenza. Con force=True si salta la verifica di disponibilità.
    `client_overlap_ok=True` (gesti dello staff in agenda): due trattamenti
    sulla stessa cliente possono stare nella stessa fascia — è una seduta sola,
    non un conflitto — e l'appuntamento NON viene marcato come forzato.
    Ritorna (originale aggiornato, nuovo appuntamento).
    """
    _lock_and_reload(appointment)
    items = list(appointment.items.select_related("service", "operator").order_by("order", "id"))
    if len(items) < 2:
        raise HttpError(400, "L'appuntamento ha un solo servizio: usa «Sposta»")
    item = next((it for it in items if it.id == item_id), None)
    if item is None:
        raise HttpError(404, "Servizio non trovato nell'appuntamento")
    target = operator or item.operator
    if operator is not None and not item.service.operators.filter(id=operator.id).exists():
        raise HttpError(400, "Operatrice non idonea per il servizio selezionato")

    # Prima si stacca l'item e si ricompatta la visita, POI si valida: così il
    # controllo vede la situazione reale (i servizi rimasti da una parte, quello
    # spostato dall'altra) invece di escludere l'intera visita e lasciar passare
    # una sovrapposizione fra i due pezzi. Siamo in transazione: un conflitto
    # annulla tutto.
    service, duration_min, soak_min, price = item.service, item.duration_min, item.soak_min, item.price
    item.delete()
    remaining = list(appointment.items.select_related("operator").order_by("order", "id"))
    for index, rest in enumerate(remaining):
        if rest.order != index:
            rest.order = index
            rest.save(update_fields=["order"])
    appointment.operator = remaining[0].operator
    appointment.save(update_fields=["operator", "updated_at"])
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
        # togliendo il primo servizio la catena residua scala indietro: va
        # rivalidata, altrimenti si sovrappone a chi occupava quell'orario
        _validate_segments(
            appointment.salon,
            appointment.start,
            [(it.duration_min, it.soak_min, it.operator) for it in remaining],
            exclude_appointment_id=appointment.id,
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
    emit_event(appointment.salon, "appointment.updated", _event_payload(appointment))
    emit_event(appointment.salon, "appointment.created", _event_payload(created))
    return appointment, created


@transaction.atomic
def check_in(appointment: Appointment, *, actor=None) -> Appointment:
    _lock_and_reload(appointment)
    appointment.status = Appointment.Status.CHECKED_IN
    appointment.save(update_fields=["status", "updated_at"])
    log_activity(
        appointment.salon,
        "appointment.checked_in",
        f"Check-in di {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id},
    )
    emit_event(appointment.salon, "appointment.checked_in", _event_payload(appointment))
    return appointment


@transaction.atomic
def start_appointment(appointment: Appointment, *, actor=None) -> Appointment:
    _lock_and_reload(appointment)
    appointment.status = Appointment.Status.IN_PROGRESS
    appointment.save(update_fields=["status", "updated_at"])
    log_activity(
        appointment.salon,
        "appointment.started",
        f"Trattamento iniziato per {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id},
    )
    return appointment


@transaction.atomic
def mark_no_show(appointment: Appointment, *, reason: str = "", actor=None) -> Appointment:
    """No-show: stato + deposito paid->forfeited. L'addebito Stripe è di sales."""
    _lock_and_reload(appointment)
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
    emit_event(
        appointment.salon,
        "appointment.no_show",
        {**_event_payload(appointment), "reason": reason},
    )
    free_slot_event(appointment)
    return appointment


def cancel_appointment(
    appointment: Appointment, *, reason: str = "", actor=None, by_client: bool = False
) -> Appointment:
    """Annulla la visita. `by_client=True` quando è la cliente dall'app.

    La penale — caparra trattenuta e `cancelled_late`, che alimenta le regole
    caparra dei prossimi appuntamenti — si applica SOLO all'annullamento della
    cliente sotto le CLIENT_MOVE_CANCEL_MIN_HOURS ore. Prima si guardava
    soltanto l'orologio: ma l'app cliente rifiuta già l'annullamento tardivo
    (_client_policy_ok), quindi «tardivo» capitava solo quando era il SALONE ad
    annullare. Se l'operatrice si ammalava e la reception disdiceva due ore
    prima, la cliente perdeva la caparra e si ritrovava schedata come
    inaffidabile.

    Deposito pagato: forfeited se tardivo, altrimenti «da rimborsare»; subito
    dopo si tenta il rimborso su Stripe (fuori dalla transazione) e solo se
    riesce lo stato diventa «rimborsato». Prima lo stato veniva scritto
    «rimborsato» senza che nessun rimborso avvenisse.
    """
    with transaction.atomic():
        _lock_and_reload(appointment)
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
            + (" (tardivo)" if late else ""),
            actor=actor,
            payload={"appointment_id": appointment.id, "reason": reason, "late": late},
        )
        emit_event(
            appointment.salon,
            "appointment.cancelled",
            {**_event_payload(appointment), "reason": reason, "late": late},
        )
        free_slot_event(appointment)
    if appointment.deposit_status == Appointment.DepositStatus.REFUND_DUE:
        settle_deposit_refund(appointment, actor=actor)
    return appointment


def settle_deposit_refund(appointment: Appointment, *, actor=None) -> Appointment:
    """Prova il rimborso Stripe della caparra «da rimborsare»; se riesce → «rimborsata».

    Se non è possibile (Stripe assente, caparra incassata in salone, errore)
    lo stato resta «da rimborsare» e il registro attività lo segnala: il
    rimborso va fatto a mano e poi confermato con `mark_deposit_refunded`.
    """
    from apps.sales.stripe_service import refund_deposit  # lazy

    if appointment.deposit_status != Appointment.DepositStatus.REFUND_DUE:
        return appointment
    client_name = appointment.client.full_name
    refund = refund_deposit(appointment)
    if refund is not None:
        # Lo stato lo decide Stripe, non il fatto che la chiamata sia passata:
        # un rimborso «pending» non è denaro già tornato alla cliente.
        record_deposit_refund(
            appointment,
            refund_id=refund.get("id") or "",
            cents=int(refund.get("amount") or 0)
            or int((Decimal(str(appointment.deposit_amount or 0)) * 100).quantize(Decimal("1"))),
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


# Stati Stripe di un rimborso: solo «succeeded» è denaro tornato alla cliente.
REFUND_DONE = "succeeded"
REFUND_IN_FLIGHT = ("pending", "requires_action")


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
    → failed) corregge quello registrato prima. «Rimborsata» si scrive solo
    quando i rimborsi RIUSCITI coprono l'intera caparra; un rimborso parziale
    lascia la caparra pagata e riduce soltanto la quota detraibile al checkout.

    `floor_cents` è il totale già restituito dichiarato da `charge.refunded`:
    quell'evento non porta l'id del singolo rimborso, quindi vale come soglia
    minima e non come voce a sé.
    """
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
    if refund_id:
        refunds[refund_id] = {"amount_cents": int(cents or 0), "status": status}

    def _sum(predicate) -> int:
        return sum(
            int(row.get("amount_cents") or 0)
            for row in refunds.values()
            if predicate(row.get("status") or "")
        )

    done = max(_sum(lambda st: st == REFUND_DONE), int(floor_cents or 0))
    in_flight = _sum(lambda st: st in REFUND_IN_FLIGHT)
    deposit_cents = int((Decimal(str(appointment.deposit_amount or 0)) * 100).quantize(Decimal("1")))

    previous = appointment.deposit_status
    if deposit_cents > 0 and done >= deposit_cents:
        new_status = Appointment.DepositStatus.REFUNDED
    elif in_flight > 0:
        new_status = Appointment.DepositStatus.REFUNDING
    elif previous == Appointment.DepositStatus.REFUNDING:
        # Il rimborso in volo è fallito o è stato annullato: il denaro è ancora
        # in cassa. Se l'appuntamento è annullato resta da restituire, se è
        # ancora in piedi la caparra torna semplicemente pagata.
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
    if new_status != previous:
        labels = {
            Appointment.DepositStatus.REFUNDED: "Caparra rimborsata",
            Appointment.DepositStatus.REFUNDING: "Rimborso caparra in corso",
            Appointment.DepositStatus.REFUND_DUE: "Rimborso caparra non riuscito, da rifare",
            Appointment.DepositStatus.PAID: "Rimborso caparra non riuscito",
        }
        log_activity(
            appointment.salon,
            "deposit.refunded" if new_status == Appointment.DepositStatus.REFUNDED else "deposit.refund_update",
            f"{labels.get(new_status, 'Caparra aggiornata')} — {appointment.client.full_name}",
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
    """Conferma manuale dello staff: la caparra «da rimborsare» è stata restituita."""
    if appointment.deposit_status != Appointment.DepositStatus.REFUND_DUE:
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di rimborso")
    appointment.deposit_status = Appointment.DepositStatus.REFUNDED
    # Anche l'importo restituito va scritto, altrimenti la scheda diceva
    # «Caparra 30 · Rimborsato 0 · Stato: rimborsata».
    appointment.deposit_refunded_amount = appointment.deposit_amount
    appointment.save(
        update_fields=["deposit_status", "deposit_refunded_amount", "updated_at"]
    )
    log_activity(
        appointment.salon,
        "deposit.refunded",
        f"Caparra rimborsata — {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id, "amount": str(appointment.deposit_amount), "manual": True},
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
    appointment.deposit_due_at = min(now + dt.timedelta(minutes=hold), appointment.start)
    appointment.deposit_reminder_sent_at = None
    appointment.save(update_fields=["deposit_due_at", "deposit_reminder_sent_at", "updated_at"])


def clear_deposit_hold(appointment: Appointment) -> None:
    """La caparra è arrivata: niente più scadenza né rilascio."""
    if appointment.deposit_due_at is None:
        return
    appointment.deposit_due_at = None
    appointment.save(update_fields=["deposit_due_at", "updated_at"])


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

    from apps.sales import services as sales_services  # lazy

    record = getattr(sales_services, "record_deposit_cashed", None)
    if record is not None:
        record(appointment.salon, appointment, method=method, actor=actor)
    else:  # pragma: no cover - la registrazione in cassa vive in sales
        logger.warning(
            "Caparra dell'appuntamento %s segnata pagata senza registrazione in cassa",
            appointment.id,
        )

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
    emit_event(appointment.salon, "deposit.paid", _event_payload(appointment))
    return appointment


@transaction.atomic
def release_for_unpaid_deposit(appointment: Appointment, *, actor=None) -> Appointment:
    """Libera lo slot di un appuntamento la cui caparra non è arrivata in tempo.

    Lo stato diventa «annullato» ma resta la traccia (`auto_released`): compare
    fra i «da richiamare» in agenda, l'operatrice decide se telefonare o
    ripristinare. Emette `appointment.released_unpaid` (messaggio alla cliente)
    e `slot.freed` per la lista d'attesa.
    """
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
    emit_event(appointment.salon, "appointment.released_unpaid", _event_payload(appointment))
    free_slot_event(appointment)
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
        if appointment.deposit_due_at <= now:
            with transaction.atomic():
                locked = (
                    Appointment.objects.select_for_update()
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
            remind_at = appointment.deposit_due_at - dt.timedelta(minutes=max(hold - reminder, 0))
            if remind_at <= now:
                # UPDATE condizionale: chi lo vince manda il sollecito, gli altri
                # vedono 0 righe aggiornate e non mandano niente.
                claimed = Appointment.objects.filter(
                    pk=appointment.pk, deposit_reminder_sent_at__isnull=True
                ).update(deposit_reminder_sent_at=now, updated_at=now)
                if not claimed:
                    continue
                appointment.deposit_reminder_sent_at = now
                emit_event(salon, "deposit.reminder", _event_payload(appointment))
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
    lock_salon(appointment.salon)
    try:
        appointment.refresh_from_db()
    except Appointment.DoesNotExist:
        raise HttpError(404, "Appuntamento non trovato")
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
    emit_event(appointment.salon, "appointment.created", _event_payload(appointment))
    return appointment


def free_slot_event(appointment: Appointment, *, start=None, operator_id=None):
    """Emette slot.freed con le voci di lista d'attesa compatibili.

    Compatibilità: entry attiva, stesso servizio di uno degli item e operatrice
    non indicata oppure tra quelle coinvolte nell'appuntamento.
    """
    start = start or appointment.start
    operator_id = operator_id or appointment.operator_id
    items = list(appointment.items.all())
    service_ids = {item.service_id for item in items}
    operator_ids = {item.operator_id for item in items} | {operator_id}

    matching = (
        WaitlistEntry.objects.filter(
            salon=appointment.salon,
            status=WaitlistEntry.Status.ACTIVE,
            service_id__in=service_ids,
        )
        .filter(Q(operator__isnull=True) | Q(operator_id__in=operator_ids))
        .values_list("id", flat=True)
    )
    return emit_event(
        appointment.salon,
        "slot.freed",
        {
            "appointment_id": appointment.id,
            "start": start.isoformat(),
            "duration_min": sum(item.duration_min for item in items),
            "operator_id": operator_id,
            "matching_waitlist": list(matching),
        },
    )
