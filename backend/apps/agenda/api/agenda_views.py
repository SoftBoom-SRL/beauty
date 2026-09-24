"""Viste dell'agenda per lo staff: giorno, settimana, mese e la lista «da richiamare»."""

import datetime as dt
from collections import Counter, defaultdict
from decimal import Decimal

from django.db.models import Q
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from common.auth import staff_auth
from common.permissions import require_scope

from ..models import Appointment, Pause
from ..presenters import _appointment_out, _codes_hidden, _fmt_min, _gifts_out, _pause_out, gift_index
from ..schemas import AppointmentOut
from ..services import deposit_holds
from ..services.occupancy import _operators_qs
from .params import _parse_day

router = Router()


def _visible_appointments(salon, location_id, **dates):
    """Le visite non annullate del periodo (`dates`), con la cliente, in ordine d'inizio.

    Con `location_id`, come per le operatrici: la sede richiesta più gli
    appuntamenti senza sede (prenotazioni dall'app o importate), che altrimenti
    sparirebbero. Ogni vista aggiunge i suoi prefetch.
    """
    appointments = (
        Appointment.objects.filter(salon=salon, **dates)
        .exclude(status=Appointment.Status.CANCELLED)
        .select_related("client")
        .order_by("start")
    )
    if location_id:
        appointments = appointments.filter(Q(location_id=location_id) | Q(location__isnull=True))
    return appointments


def _by_local_day(appointments) -> dict:
    """{giorno: [visite]}, col giorno del salone (non quello UTC)."""
    by_day = defaultdict(list)
    for appointment in appointments:
        by_day[timezone.localtime(appointment.start).date()].append(appointment)
    return by_day


@router.get("/day", auth=staff_auth)
def agenda_day(request, date: str, location_id: int = None):
    """Agenda del giorno: per ogni operatrice attiva turno, appuntamenti e pause."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    day = _parse_day(date)
    deposit_holds.process_deposit_holds(ctx.salon)

    from apps.staff.models import Operator  # lazy
    from apps.staff.services import shift_windows  # lazy

    # Le operatrici su cui cercano disponibilità e conferma (attive, della sede o
    # senza sede), con turni, assenze e settings del salone già letti:
    # `shift_windows` li legge per ogni operatrice, e senza il prefetch la vista
    # giorno faceva tre query per colonna invece di tre in tutto.
    operators = _operators_qs(ctx.salon, location_id or None)

    appointments = _visible_appointments(ctx.salon, location_id, start__date=day).prefetch_related(
        "items__service", "items__operator"
    )
    pauses = (
        Pause.objects.filter(salon=ctx.salon, start__date=day)
        .select_related("operator")
        .order_by("start")
    )

    appointments = list(appointments)
    gifts = gift_index(ctx.salon, [a.client_id for a in appointments])
    appointments_by_operator = defaultdict(list)
    for appointment in appointments:
        appointments_by_operator[appointment.operator_id].append(appointment)
    pauses = list(pauses)
    pauses_by_operator = defaultdict(list)
    for pause in pauses:
        pauses_by_operator[pause.operator_id].append(pause)

    # Un'operatrice disattivata non compare più in elenco, ma i suoi appuntamenti
    # di oggi restano: senza questa riga le clienti si presentano a un orario che
    # in agenda non esiste. La colonna viene mostrata con `inactive: true` finché
    # ha qualcosa dentro, così si possono riassegnare.
    # «Qualcosa dentro» vuol dire anche un servizio SECONDARIO di una visita:
    # ogni visita sta nella riga della principale, ma la griglia disegna ogni
    # servizio nella colonna di chi lo esegue. Il colore di Laura (disattivata,
    # o di un'altra sede col filtro) dentro la visita di Giulia non aveva una
    # colonna e spariva dalla giornata.
    # Una pausa invece apre una colonna solo se è di un'operatrice della sede
    # richiesta (o senza sede): col filtro «Centro», la pausa di Lia della sede
    # Nord ne apriva la colonna, con le sue finestre libere in cui trascinare.
    operators = list(operators)
    known = {o.id for o in operators}
    wanted = set(appointments_by_operator)
    wanted.update(item.operator_id for a in appointments for item in a.items.all())
    wanted.update(
        pause.operator_id
        for pause in pauses
        if not location_id or pause.operator.location_id in (None, location_id)
    )
    orphan_ids = {op_id for op_id in wanted if op_id and op_id not in known}
    if orphan_ids:
        orphans = list(
            Operator.objects.filter(salon=ctx.salon, id__in=orphan_ids)
            .select_related("salon__settings")
            .prefetch_related("shifts", "absences")
            .order_by("order", "id")
        )
        operators = operators + orphans

    return [
        {
            "operator": {
                "id": operator.id,
                "name": operator.full_name,
                "color": operator.color,
                "role_title": operator.role_title,
                "inactive": not operator.active,
            },
            "windows": [
                [_fmt_min(start), _fmt_min(end)]
                for start, end in shift_windows(operator, day)
            ],
            "appointments": [
                _appointment_out(a, gifts, ctx)
                for a in appointments_by_operator.get(operator.id, [])
            ],
            "pauses": [_pause_out(p) for p in pauses_by_operator.get(operator.id, [])],
        }
        for operator in operators
    ]


@router.get("/week", auth=staff_auth)
def agenda_week(request, start: str, location_id: int = None):
    """Vista settimanale: per ogni giorno conteggi e appuntamenti compatti.

    `location_id` filtra come nella vista giorno: senza, cambiare sede dalla
    barra in alto non cambiava nulla in settimana e i conteggi mescolavano le
    sedi.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    first_day = _parse_day(start)
    deposit_holds.process_deposit_holds(ctx.salon)
    days = [first_day + dt.timedelta(days=offset) for offset in range(7)]

    appointments = list(
        _visible_appointments(
            ctx.salon, location_id, start__date__gte=days[0], start__date__lte=days[-1]
        ).prefetch_related("items__service")
    )
    gifts = gift_index(ctx.salon, [a.client_id for a in appointments])
    hide_codes = _codes_hidden(ctx)
    by_day = _by_local_day(appointments)

    result = []
    for day in days:
        day_appointments = by_day.get(day, [])
        result.append(
            {
                "date": day.isoformat(),
                "count": len(day_appointments),
                "by_status": dict(Counter(a.status for a in day_appointments)),
                "appointments": [
                    {
                        "id": a.id,
                        "start": a.start,
                        "client_name": a.client.full_name,
                        "client_phone": a.client.phone,
                        "operator_id": a.operator_id,
                        "status": a.status,
                        "duration_min": a.total_duration_min,
                        "total_price": a.total_price,
                        "forced": a.forced,
                        "deposit_status": a.deposit_status,
                        # L'anteprima al passaggio del mouse è la stessa della
                        # vista giorno: senza la nota il riquadro di avviso
                        # («allergia alla tinta») spariva in settimana.
                        "note": a.note,
                        "gifts": _gifts_out(a, gifts, hide_codes),
                        "items": [
                            {
                                # `service_id` serve al COLORE: in settimana ogni
                                # servizio è disegnato nella tinta della sua
                                # categoria, e senza l'id la dashboard non può
                                # risalire al listino — ripiegava sul colore
                                # dell'operatrice e i trattamenti diventavano
                                # tutti uguali.
                                "service_id": it.service_id,
                                "operator_id": it.operator_id,
                                "duration_min": it.duration_min,
                                "soak_min": it.soak_min,
                                # Il nome del servizio serve all'anteprima al
                                # passaggio del mouse e a far vedere che la visita
                                # è composta da più servizi.
                                "service_name": it.service.name_it,
                            }
                            for it in a.items.all()
                        ],
                    }
                    for a in day_appointments
                ],
            }
        )
    return result


@router.get("/range", auth=staff_auth)
def agenda_range(request, start: str, end: str, location_id: int = None):
    """Riepilogo per intervallo di giorni (vista mese): per ogni giorno capacità
    (minuti di turno), minuti prenotati, incasso atteso, stato per operatrice e
    appuntamenti compatti. Massimo 42 giorni (6 settimane)."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    first_day, last_day = _parse_day(start), _parse_day(end)
    # Estremi inclusi: la differenza fra i due giorni è uno in meno dei giorni
    # restituiti, e il tetto lasciava passare 43 giorni invece di 42.
    if last_day < first_day or (last_day - first_day).days + 1 > 42:
        raise HttpError(400, "Intervallo non valido (massimo 42 giorni)")
    deposit_holds.process_deposit_holds(ctx.salon)

    from apps.staff.models import Operator  # lazy
    from apps.staff.services import shift_windows  # lazy

    operators = list(
        Operator.objects.filter(salon=ctx.salon, active=True)
        .select_related("salon", "salon__settings")
        .prefetch_related("shifts", "absences")
        .order_by("order", "id")
    )
    if location_id:
        operators = [o for o in operators if o.location_id in (None, location_id)]
    appointments = list(
        _visible_appointments(
            ctx.salon, location_id, start__date__gte=first_day, start__date__lte=last_day
        ).prefetch_related("items__service")
    )
    gifts = gift_index(ctx.salon, [a.client_id for a in appointments])
    hide_codes = _codes_hidden(ctx)
    by_day = _by_local_day(appointments)

    result = []
    day = first_day
    while day <= last_day:
        day_appointments = by_day.get(day, [])
        per_operator = {
            o.id: {
                "operator_id": o.id,
                "capacity_min": sum(e - s for s, e in shift_windows(o, day)),
                "booked_min": 0,
            }
            for o in operators
        }
        revenue = Decimal("0")
        for a in day_appointments:
            if a.status == Appointment.Status.NO_SHOW:
                continue
            revenue += Decimal(a.total_price or 0)
            for item in a.items.all():
                if item.operator_id in per_operator:
                    per_operator[item.operator_id]["booked_min"] += item.duration_min
        result.append(
            {
                "date": day.isoformat(),
                "count": len(day_appointments),
                "by_status": dict(Counter(a.status for a in day_appointments)),
                "capacity_min": sum(o["capacity_min"] for o in per_operator.values()),
                "booked_min": sum(o["booked_min"] for o in per_operator.values()),
                "revenue": revenue,
                "operators": list(per_operator.values()),
                "appointments": [
                    {
                        "id": a.id,
                        "start": a.start,
                        "client_name": a.client.full_name,
                        "operator_id": a.operator_id,
                        "status": a.status,
                        "duration_min": a.total_duration_min,
                        "total_price": a.total_price,
                        "forced": a.forced,
                        "deposit_status": a.deposit_status,
                        "gifts": _gifts_out(a, gifts, hide_codes),
                        "services": [it.service.name_it for it in a.items.all()],
                    }
                    for a in day_appointments
                ],
            }
        )
        day += dt.timedelta(days=1)
    return result


@router.get("/released", auth=staff_auth, response=list[AppointmentOut])
def list_released(request, days: int = 30):
    """Appuntamenti liberati automaticamente per caparra non pagata: la lista «da richiamare».

    Come ogni altra vista dell'agenda richiede il permesso «agenda»: era l'unica
    rotta senza, e un ruolo «Magazzino» ci leggeva nomi e telefoni delle
    clienti (e faceva girare le scadenze delle caparre, che scrivono).
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    deposit_holds.process_deposit_holds(ctx.salon)
    released = list(deposit_holds.released_appointments(ctx.salon, days=max(1, min(days, 90))))
    gifts = gift_index(ctx.salon, [a.client_id for a in released])
    return [_appointment_out(a, gifts, ctx) for a in released]
