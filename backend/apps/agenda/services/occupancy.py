"""Chi è occupato e quando: impegni per operatrice, chi si prenota, apertura del centro.

Le finestre lavorabili arrivano da `staff.services.shift_windows(operator, date)`
-> list[tuple[int, int]] (minuti), già al netto di pause pranzo e assenze; le
fasce di apertura da `staff.services.opening_windows(salon, date)`.
"""

import datetime as dt
from collections import defaultdict

from django.db.models import Q
from ninja.errors import HttpError

from common.intervals import merge_intervals

from ..models import Appointment, Pause
from .timegrid import day_and_minute


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
        start_day, offset = day_and_minute(appointment.start)
        if start_day != day:
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
        start_day, start = day_and_minute(pause.start)
        if start_day != day:
            start -= 1440  # iniziata ieri: oggi conta solo la coda dopo mezzanotte
        end = start + pause.duration_min
        if end > 0:
            busy[pause.operator_id].append((start, end, True))

    return busy


def _busy_maps(
    salon,
    day: dt.date,
    *,
    exclude_appointment_id: int | None = None,
    ignore_client_id: int | None = None,
) -> tuple[dict, dict]:
    """Le due mappe degli impegni della conferma: (tutti, senza la stessa cliente).

    Senza `ignore_client_id` la seconda È la prima, lo stesso oggetto:
    `resolution._pick_operator` lo riconosce e non riprova la stessa mappa.
    """
    busy = _busy_map(salon, day, exclude_appointment_id=exclude_appointment_id)
    same_client_busy = (
        _busy_map(
            salon, day,
            exclude_appointment_id=exclude_appointment_id,
            ignore_client_id=ignore_client_id,
        )
        if ignore_client_id
        else busy
    )
    return busy, same_client_busy


def _shift_windows_memo(day: dt.date):
    """`windows_of(operatrice)`: le sue finestre di turno del giorno, lette una volta sola.

    `shift_windows` si importa a ogni chiamata, come ovunque: i test la
    sostituiscono in `apps.staff.services`.
    """
    from apps.staff.services import shift_windows  # lazy

    cache: dict[int, list] = {}

    def windows_of(operator):
        if operator.id not in cache:
            cache[operator.id] = shift_windows(operator, day)
        return cache[operator.id]

    return windows_of


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


def bookable_operator_ids(salon, location=None) -> set[int]:
    """Id delle operatrici prenotabili su quella sede: attive, della sede o senza sede.

    È lo stesso insieme su cui cercano disponibilità e conferma: una riga di
    un'operatrice fuori da qui (disattivata, o che lavora in un'altra sede) va
    riassegnata per spostare la visita.
    """
    return set(_operators_qs(salon, location).values_list("id", flat=True))


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


def _opening_bands(salon, day: dt.date):
    """Fasce di apertura del giorno, fuse quando si toccano; None se non configurate.

    Due righe contigue (9–13 e 13–19) sono un'apertura sola: la cliente che
    comincia alle 12:30 non esce alle 13.
    """
    from apps.staff.services import opening_windows  # lazy

    bounds = opening_windows(salon, day)
    if bounds is None:
        return None
    return merge_intervals(bounds)


def _chain_deadline(bands, start_min: int | None, windows) -> tuple[int, str] | None:
    """Minuto entro cui la catena (posa compresa) deve finire, col messaggio del 409.

    - orari configurati: la fine della FASCIA in cui la catena comincia. Con
      orari spezzati (9–13 e 15–19) un colore delle 12:30 con un'ora di posa si
      prenotava, e la cliente restava col colore in testa a serranda abbassata
      fino alle 14. Senza `start_min` (o fuori da ogni fascia) vale l'ultima
      chiusura della giornata, come prima;
    - orari non configurati: decide il turno, e la posa non va oltre la fine
      dell'ultima finestra delle operatrici della catena (`windows`): prima
      finiva a turno chiuso, senza nessuno che la togliesse;
    - giorno di chiusura, o nessuna finestra nota: nessun limite (decide il
      turno, che quel giorno non c'è).
    """
    if bands is None:
        ends = [end for _start, end in windows or ()]
        if not ends:
            return None
        return max(ends), "Il servizio finirebbe dopo la fine del turno"
    if not bands:
        return None
    message = "Il servizio finirebbe dopo la chiusura del centro"
    if start_min is not None:
        band = next((b for b in bands if b[0] <= start_min < b[1]), None)
        if band is not None:
            return band[1], message
    return max(close for _open, close in bands), message


def _ensure_within_opening(
    salon,
    day: dt.date,
    end_min: int,
    *,
    force: bool,
    start_min: int | None = None,
    windows=None,
) -> None:
    """La catena, POSA COMPRESA, deve finire entro la chiusura del centro.

    La libertà dell'operatrice si verifica sulla sola finestra attiva, perché
    durante la posa è libera di lavorare su un'altra cliente. La CLIENTE però
    resta in salone: senza questo controllo si poteva prenotare un colore la cui
    posa finiva mezz'ora dopo la serranda abbassata. Lo staff può forzare.

    `start_min` (inizio della catena) e `windows` (finestre delle sue
    operatrici) stringono il limite come in `_chain_deadline`: la fascia in cui
    si comincia, o il turno se il salone non ha orari. Chi non li passa ottiene
    il controllo di prima, sull'ultima chiusura della giornata.
    """
    if force:
        return
    deadline = _chain_deadline(_opening_bands(salon, day), start_min, windows)
    if deadline is not None and end_min > deadline[0]:
        raise HttpError(409, deadline[1])
