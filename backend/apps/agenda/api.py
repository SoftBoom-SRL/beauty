"""Endpoint agenda: viste giorno/settimana, appuntamenti, pause, waitlist,
disponibilità — sia per la dashboard staff sia per la web app cliente (/client/...).
"""

import datetime as dt
import json
from collections import Counter, defaultdict
from decimal import Decimal

from django.conf import settings
from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date
from ninja import Router
from ninja.errors import HttpError

from apps.core.models import Location, Salon
from apps.core.services import default_location, emit_event, log_activity
from common import ratelimit
from common.auth import client_auth, staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from . import undo as undo_log
from .models import Appointment, Pause, UndoEntry, WaitlistEntry
from .presenters import (
    _appointment_out,
    _client_appointment_out,
    _codes_hidden,
    _fmt_min,
    _gifts_out,
    _item_out,  # noqa: F401 — compat refactoring: rimuovere dopo l'integrazione (i test lo cercano qui)
    _operator_name,
    _pause_label,
    _pause_out,
    _undo_out,
    _waitlist_out,
    gift_index,
)
from .schemas import (
    MAX_ITEMS_PER_REQUEST,
    MAX_YEAR,
    MIN_YEAR,
    AppointmentCreateIn,
    AppointmentOut,
    AppointmentUpdateIn,
    CancelIn,
    ClientAppointmentCreateIn,
    ClientAppointmentOut,
    ClientMoveIn,
    DepositCashedIn,
    MarginOut,
    MoveIn,
    OkOut,
    PauseIn,
    PauseOut,
    ReasonIn,
    RestoreIn,
    SlotOut,
    SplitIn,
    SplitOut,
    UndoIn,
    UndoOut,
    UndoResultOut,
    WaitlistIn,
    WaitlistOut,
)
# `appointments` e `availability` sono anche nomi di queryset e di una vista: i
# due moduli dei servizi si importano col suffisso.
from .services import appointments as appointment_services
from .services import availability as availability_services
from .services import deposit_holds, deposits, locking, occupancy, refunds, transitions

router = Router(tags=["agenda"])


# ---- Helper ------------------------------------------------------------------


def _parse_day(value: str) -> dt.date:
    """Giorno da un parametro di query: 400 per ogni data che non sta in piedi.

    `parse_date` restituisce None solo per il formato sbagliato: una data ben
    scritta ma inesistente («2026-02-30») solleva ValueError, e un anno al
    limite (9999-12-30) faceva traboccare l'aritmetica dei giorni. Entrambi
    arrivavano all'utente come 500, anche sull'endpoint pubblico.
    """
    try:
        day = parse_date(value or "")
    except ValueError:
        day = None
    if day is None or not (MIN_YEAR <= day.year <= MAX_YEAR):
        raise HttpError(400, "Data non valida (atteso YYYY-MM-DD)")
    return day


def _as_optional_id(value):
    """int positivo, None se assente. Rifiuta tutto il resto con 400.

    `True` è un int per Python ma non è un id: senza il controllo su bool
    passerebbe come service_id=1.
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise HttpError(400, "Parametro items non valido")
    return value


def _parse_items_param(raw: str) -> list[dict]:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        raise HttpError(400, "Parametro items non valido")
    if not isinstance(data, list) or not data:
        raise HttpError(400, "Parametro items non valido")
    if len(data) > MAX_ITEMS_PER_REQUEST:
        raise HttpError(400, f"Troppi servizi nella richiesta (massimo {MAX_ITEMS_PER_REQUEST})")
    items = []
    for entry in data:
        if not isinstance(entry, dict) or "service_id" not in entry:
            raise HttpError(400, "Parametro items non valido")
        service_id = _as_optional_id(entry["service_id"])
        if service_id is None:
            raise HttpError(400, "Parametro items non valido")
        items.append(
            {"service_id": service_id, "operator_id": _as_optional_id(entry.get("operator_id"))}
        )
    return items


def _get_location(ctx, location_id) -> Location | None:
    return salon_get(Location, ctx, location_id) if location_id else None


# ---- Viste agenda (staff) ----------------------------------------------------


@router.get("/day", auth=staff_auth)
def agenda_day(request, date: str, location_id: int = None):
    """Agenda del giorno: per ogni operatrice attiva turno, appuntamenti e pause."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    day = _parse_day(date)
    deposit_holds.process_deposit_holds(ctx.salon)

    from apps.staff.models import Operator  # lazy
    from apps.staff.services import shift_windows  # lazy

    # prefetch di turni e assenze + settings del salone: `shift_windows` li legge
    # per ogni operatrice, e senza questo la vista giorno faceva tre query per
    # colonna invece di tre in tutto.
    operators = (
        Operator.objects.filter(salon=ctx.salon, active=True)
        .select_related("salon__settings")
        .prefetch_related("shifts", "absences")
        .order_by("order", "id")
    )
    if location_id:
        operators = operators.filter(Q(location__isnull=True) | Q(location_id=location_id))

    appointments = (
        Appointment.objects.filter(salon=ctx.salon, start__date=day)
        .exclude(status=Appointment.Status.CANCELLED)
        .select_related("client")
        .prefetch_related("items__service", "items__operator")
        .order_by("start")
    )
    if location_id:
        # Come per le operatrici: la sede richiesta + gli appuntamenti senza sede
        # (es. prenotazioni dall'app o importate), che altrimenti sparirebbero.
        appointments = appointments.filter(Q(location_id=location_id) | Q(location__isnull=True))
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
                "name": _operator_name(operator),
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

    appointments = (
        Appointment.objects.filter(
            salon=ctx.salon, start__date__gte=days[0], start__date__lte=days[-1]
        )
        .exclude(status=Appointment.Status.CANCELLED)
        .select_related("client")
        .prefetch_related("items__service")
        .order_by("start")
    )
    if location_id:
        # Come nella vista giorno: la sede richiesta più gli appuntamenti senza
        # sede (prenotazioni dall'app o importate), che altrimenti sparirebbero.
        appointments = appointments.filter(
            Q(location_id=location_id) | Q(location__isnull=True)
        )
    appointments = list(appointments)
    gifts = gift_index(ctx.salon, [a.client_id for a in appointments])
    hide_codes = _codes_hidden(ctx)
    by_day = defaultdict(list)
    for appointment in appointments:
        by_day[timezone.localtime(appointment.start).date()].append(appointment)

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
    appointments = (
        Appointment.objects.filter(
            salon=ctx.salon, start__date__gte=first_day, start__date__lte=last_day
        )
        .exclude(status=Appointment.Status.CANCELLED)
        .select_related("client")
        .prefetch_related("items__service")
        .order_by("start")
    )
    if location_id:
        appointments = appointments.filter(Q(location_id=location_id) | Q(location__isnull=True))
    appointments = list(appointments)
    gifts = gift_index(ctx.salon, [a.client_id for a in appointments])
    hide_codes = _codes_hidden(ctx)
    by_day = defaultdict(list)
    for appointment in appointments:
        by_day[timezone.localtime(appointment.start).date()].append(appointment)

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


# ---- Appuntamenti (staff) ------------------------------------------------------


@router.post("/appointments", auth=staff_auth, response=AppointmentOut)
def create_appointment(request, data: AppointmentCreateIn):
    ctx = request.auth
    require_scope(ctx, "agenda")

    from apps.clients.models import Client  # lazy

    client = salon_get(Client, ctx, data.client_id, is_active=True)
    appointment = appointment_services.create_appointment(
        ctx.salon,
        client,
        [item.dict() for item in data.items],
        data.start,
        via=Appointment.CreatedVia.DASHBOARD,
        actor=ctx.user,
        flexible=data.flexible,
        note=data.note,
        location=_get_location(ctx, data.location_id),
        force=data.force,
        client_overlap_ok=True,
    )
    deposits.send_deposit_link(appointment)
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/move", auth=staff_auth, response=AppointmentOut)
def move_appointment(request, appointment_id: int, data: MoveIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)

    operator = None
    from_operator = None
    # `active=True` vale solo per la NUOVA assegnazione. La colonna di partenza
    # può essere di un'operatrice disattivata — l'agenda la mostra apposta, in
    # una colonna a parte, per poterne riassegnare gli appuntamenti — e
    # pretenderla attiva faceva rispondere 404 a ogni riassegnazione da lì.
    # Quando l'operatrice indicata è già quella di partenza non c'è niente da
    # riassegnare.
    source_id = data.from_operator_id or appointment.operator_id
    if data.operator_id and data.operator_id != source_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
        if data.from_operator_id:
            from_operator = salon_get(Operator, ctx, data.from_operator_id)
    appointment = appointment_services.move_appointment(
        appointment, data.start, operator=operator, from_operator=from_operator,
        actor=ctx.user, force=data.force, client_overlap_ok=True,
    )
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/split", auth=staff_auth, response=SplitOut)
def split_appointment(request, appointment_id: int, data: SplitIn):
    """Stacca un servizio da un appuntamento multi-servizio e lo sposta (anche in un altro giorno)."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    operator = None
    if data.operator_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
    original, created = appointment_services.split_appointment(
        appointment, data.item_id, data.start, operator=operator, actor=ctx.user, force=data.force,
        client_overlap_ok=True,
    )
    return {
        "original": _appointment_out(original, viewer=ctx),
        "created": _appointment_out(created, viewer=ctx),
    }


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


@router.post("/appointments/{int:appointment_id}/restore", auth=staff_auth, response=AppointmentOut)
def restore_appointment(request, appointment_id: int, data: RestoreIn):
    """Rimette in agenda un appuntamento liberato per caparra non pagata."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    appointment = deposit_holds.restore_released(appointment, actor=ctx.user, force=data.force)
    deposits.send_deposit_link(appointment)
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/check-in", auth=staff_auth, response=AppointmentOut)
def check_in_appointment(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(transitions.check_in(appointment, actor=ctx.user), viewer=ctx)


@router.post("/appointments/{int:appointment_id}/start", auth=staff_auth, response=AppointmentOut)
def start_appointment(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(transitions.start_appointment(appointment, actor=ctx.user), viewer=ctx)


@router.post("/appointments/{int:appointment_id}/no-show", auth=staff_auth, response=AppointmentOut)
def no_show_appointment(request, appointment_id: int, data: ReasonIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(
        transitions.mark_no_show(appointment, reason=data.reason, actor=ctx.user), viewer=ctx
    )


@router.post("/appointments/{int:appointment_id}/cancel", auth=staff_auth, response=AppointmentOut)
def cancel_appointment(request, appointment_id: int, data: CancelIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    # Di norma annulla il salone: nessuna penale, la caparra torna indietro.
    # Con `by_client` la reception registra la disdetta della cliente, con le
    # regole dell'app; resta un gesto della postazione, quindi si può disfare.
    return _appointment_out(
        transitions.cancel_appointment(
            appointment,
            reason=data.reason,
            actor=ctx.user,
            by_client=data.by_client,
            undoable=True,
        ),
        viewer=ctx,
    )


@router.put("/appointments/{int:appointment_id}", auth=staff_auth, response=AppointmentOut)
def update_appointment(request, appointment_id: int, data: AppointmentUpdateIn):
    """Modifica trattamenti e/o nota dell'appuntamento.

    `items` (se presente) è la lista COMPLETA dei servizi desiderati a partire
    da `appointment.start`: aggiungere un servizio = includere una voce senza
    `id`, rimuoverne uno = ometterlo. Ogni voce può forzare `duration_min`
    (da 1 a 720 minuti); se assente vale la durata già sulla visita (o quella
    di listino per le voci nuove). Prezzo e posa delle voci esistenti restano
    quelli concordati con la cliente. Il deposito non si ricalcola: si riduce
    soltanto se la visita è scesa sotto la caparra.

    `force=True`: si prova comunque a scrivere anche se in quella fascia
    l'operatrice risulta occupata o la visita sfora la chiusura (allungare un
    trattamento accanto a un incastro già forzato). L'idoneità al servizio
    resta un limite invalicabile.

    `expected_updated_at` (l'`updated_at` della copia da cui si parte) e gli
    `id` delle voci proteggono dalle copie vecchie: se la visita è cambiata nel
    frattempo, o un id non è più una sua riga, 412 «ricarica e riprova» — mai
    superato da `force`.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    appointment = appointment_services.edit_appointment(
        appointment,
        items=[item.dict() for item in data.items] if data.items is not None else None,
        note=data.note,
        force=data.force,
        actor=ctx.user,
        expected_updated_at=data.expected_updated_at,
        client_overlap_ok=True,
    )
    return _appointment_out(appointment, viewer=ctx)


@router.post("/appointments/{int:appointment_id}/deposit-cashed", auth=staff_auth, response=AppointmentOut)
def deposit_cashed(request, appointment_id: int, data: DepositCashedIn):
    """La caparra è stata incassata in salone (contanti o POS al banco).

    Senza questa via l'unico modo di registrarla era il pagamento online: dove
    Stripe non è configurato — o quando la cliente paga al banco — il termine
    scadeva lo stesso e il posto si liberava da solo.
    """
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(
        deposit_holds.mark_deposit_cashed(appointment, method=data.method, actor=ctx.user),
        viewer=ctx,
    )


@router.post("/appointments/{int:appointment_id}/deposit-refunded", auth=staff_auth, response=AppointmentOut)
def deposit_refunded(request, appointment_id: int):
    """Lo staff conferma di aver restituito una caparra «da rimborsare» (rimborso manuale)."""
    ctx = request.auth
    require_scope(ctx, "sales")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(refunds.mark_deposit_refunded(appointment, actor=ctx.user), viewer=ctx)


@router.get("/appointments/{int:appointment_id}/margin", auth=staff_auth, response=MarginOut)
def appointment_margin(request, appointment_id: int):
    """Stima margine: ricavi meno costi fornitore/prodotto (listino corrente) e manodopera."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)

    revenue = supplier_cost = product_cost = labor_cost = Decimal("0")
    for item in appointment.items.select_related("service", "operator"):
        revenue += item.price
        supplier_cost += item.service.supplier_cost
        product_cost += item.service.product_cost
        labor_cost += Decimal(item.duration_min) / Decimal("60") * item.operator.hourly_cost
    labor_cost = labor_cost.quantize(Decimal("0.01"))
    margin = revenue - supplier_cost - product_cost - labor_cost
    margin_pct = (
        (margin / revenue * Decimal("100")).quantize(Decimal("0.1"))
        if revenue
        else Decimal("0")
    )
    return {
        "revenue": revenue,
        "supplier_cost": supplier_cost,
        "product_cost": product_cost,
        "labor_cost": labor_cost,
        "margin": margin,
        "margin_pct": margin_pct,
    }


# Registrato DOPO le rotte con suffisso letterale (/move, /check-in, .../margin)
# così non le oscura: tutte usano il converter {int:...} e Ninja matcha per
# ordine di registrazione.
@router.get("/appointments/{int:appointment_id}", auth=staff_auth, response=AppointmentOut)
def get_appointment(request, appointment_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    appointment = salon_get(Appointment, ctx, appointment_id)
    return _appointment_out(appointment, viewer=ctx)


# ---- Torna indietro ------------------------------------------------------------


@router.get("/undo", auth=staff_auth, response=list[UndoOut])
def list_undo(request):
    """Cosa può ancora annullare CHI CHIEDE, dal gesto più recente."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    return [_undo_out(entry) for entry in undo_log.stack(ctx.salon, ctx.user)]


@router.post("/undo", auth=staff_auth, response=UndoResultOut)
def undo_last(request, data: UndoIn):
    """Rimette le cose com'erano prima dell'ultimo gesto (o di quello indicato).

    Il 409 qui non è un errore da nascondere: dice che nel frattempo è cambiato
    qualcosa — una collega ha spostato lo stesso appuntamento, il conto è andato
    in cassa — e va mostrato così com'è a chi ha premuto il tasto.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    entries = undo_log.stack(ctx.salon, ctx.user)
    entry = (
        next((e for e in entries if e.id == data.entry_id), None)
        if data.entry_id
        else (entries[0] if entries else None)
    )
    if entry is None:
        raise HttpError(404, "Non c'è niente da annullare")
    return undo_log.perform(entry, actor=ctx.user)


# ---- Pause (staff) -------------------------------------------------------------


@router.get("/pauses", auth=staff_auth, response=list[PauseOut])
def list_pauses(request, date: str = "", operator_id: int = None):
    """Pause di una giornata. Senza `date` vale oggi: la vista è quella di un
    giorno, e senza filtro l'endpoint restituiva ogni pausa mai creata dal
    salone, senza paginazione."""
    ctx = request.auth
    require_scope(ctx, "agenda")
    day = _parse_day(date) if date else timezone.localdate()
    pauses = Pause.objects.filter(salon=ctx.salon, start__date=day).select_related("operator")
    if operator_id:
        pauses = pauses.filter(operator_id=operator_id)
    return [_pause_out(p) for p in pauses.order_by("start")]


@router.post("/pauses", auth=staff_auth, response=PauseOut)
def create_pause(request, data: PauseIn):
    ctx = request.auth
    require_scope(ctx, "agenda")

    from apps.staff.models import Operator  # lazy

    operator = salon_get(Operator, ctx, data.operator_id)
    # Una pausa blocca l'agenda esattamente come un appuntamento: si crea sotto
    # lo stesso lock, altrimenti una prenotazione in corso su quello slot non la
    # vede e le due scritture finiscono sovrapposte.
    with transaction.atomic():
        locking.lock_salon(ctx.salon)
        pause = Pause.objects.create(
            salon=ctx.salon,
            operator=operator,
            start=data.start,
            duration_min=data.duration_min,
            note=data.note,
        )
    log_activity(
        ctx.salon,
        "pause.created",
        f"Pausa per {_operator_name(operator)}",
        actor=ctx.user,
        payload={"pause_id": pause.id, "start": pause.start.isoformat()},
    )
    undo_log.record(
        ctx.salon,
        kind=UndoEntry.Kind.PAUSE_CREATE,
        label=_pause_label("Pausa aggiunta", pause),
        actor=ctx.user,
        after={"pauses": [undo_log.pause_snapshot(pause)]},
        created={"pauses": [pause.id]},
    )
    return _pause_out(pause)


@router.put("/pauses/{int:pause_id}", auth=staff_auth, response=PauseOut)
def update_pause(request, pause_id: int, data: PauseIn):
    ctx = request.auth
    require_scope(ctx, "agenda")
    pause = salon_get(Pause, ctx, pause_id)

    from apps.staff.models import Operator  # lazy

    operator = salon_get(Operator, ctx, data.operator_id)
    before = undo_log.pause_snapshot(pause)
    with transaction.atomic():
        locking.lock_salon(ctx.salon)  # stesso lock delle prenotazioni
        pause.operator = operator
        pause.start = data.start
        pause.duration_min = data.duration_min
        pause.note = data.note
        pause.save(update_fields=["operator", "start", "duration_min", "note", "updated_at"])
    log_activity(
        ctx.salon,
        "pause.updated",
        f"Pausa di {_operator_name(pause.operator)} aggiornata",
        actor=ctx.user,
        payload={"pause_id": pause.id, "start": pause.start.isoformat()},
    )
    undo_log.record(
        ctx.salon,
        kind=UndoEntry.Kind.PAUSE_UPDATE,
        label=_pause_label("Pausa spostata", pause),
        actor=ctx.user,
        before={"pauses": [before]},
        after={"pauses": [undo_log.pause_snapshot(pause)]},
    )
    return _pause_out(pause)


@router.delete("/pauses/{int:pause_id}", auth=staff_auth, response=OkOut)
def delete_pause(request, pause_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    pause = salon_get(Pause, ctx, pause_id)
    operator_name = _operator_name(pause.operator)
    start = pause.start.isoformat()
    label = _pause_label("Pausa rimossa", pause)
    before = undo_log.pause_snapshot(pause)
    pause.delete()
    log_activity(
        ctx.salon,
        "pause.deleted",
        f"Pausa di {operator_name} rimossa",
        actor=ctx.user,
        payload={"pause_id": pause_id, "start": start},
    )
    undo_log.record(
        ctx.salon,
        kind=UndoEntry.Kind.PAUSE_DELETE,
        label=label,
        actor=ctx.user,
        before={"pauses": [before]},
    )
    return OkOut()


# ---- Lista d'attesa (staff) ------------------------------------------------------


@router.get("/waitlist", auth=staff_auth, response=list[WaitlistOut])
def list_waitlist(request):
    ctx = request.auth
    require_scope(ctx, "agenda")
    entries = (
        WaitlistEntry.objects.filter(salon=ctx.salon, status=WaitlistEntry.Status.ACTIVE)
        .select_related("client", "service", "operator")
        .order_by("created_at")
    )
    return [_waitlist_out(e) for e in entries]


@router.post("/waitlist/{int:entry_id}/contacted", auth=staff_auth, response=WaitlistOut)
def waitlist_contacted(request, entry_id: int):
    ctx = request.auth
    require_scope(ctx, "agenda")
    entry = salon_get(WaitlistEntry, ctx, entry_id)
    entry.status = WaitlistEntry.Status.CONTACTED
    entry.save(update_fields=["status"])
    log_activity(
        ctx.salon,
        "waitlist.contacted",
        f"{entry.client.full_name} contattata dalla lista d'attesa",
        actor=ctx.user,
        payload={"entry_id": entry.id},
    )
    return _waitlist_out(entry)


# ---- Disponibilità (staff) -------------------------------------------------------


def _visit_plan(appointment) -> tuple[list[dict], list[int]]:
    """Le righe della visita come piano di ricerca, e i servizi da ammettere comunque.

    Lo spostamento parte dalla visita com'è: operatrici, durate e pose sono
    quelle scritte sull'appuntamento, non quelle del listino di oggi. Con le
    durate del listino si proponevano orari che la conferma rifiutava — la
    visita dura ancora quello che durava quando è stata prenotata — e con altre
    operatrici succedeva lo stesso. I servizi già sulla visita restano validi
    anche se nel frattempo sono usciti dal listino.
    """
    parsed = [
        {
            "service_id": item.service_id,
            "operator_id": item.operator_id,
            "duration_min": item.duration_min,
            "soak_min": item.soak_min,
        }
        for item in appointment.items.all().order_by("order", "id")
    ]
    return parsed, [item["service_id"] for item in parsed]


@router.get("/availability", auth=staff_auth, response=list[SlotOut])
def availability(
    request, date: str, items: str = "", location_id: int = None,
    exclude_appointment_id: int = None,
):
    """Orari liberi per una nuova prenotazione o, con `exclude_appointment_id`,
    per spostare quella visita («Riprogramma»).

    Nel secondo caso la visita non conta come occupata e il piano viene da lei
    (righe in ordine, durate e pose scritte, operatrici, servizi usciti dal
    listino compresi): `items` si ignora. Cercando col listino di oggi e con la
    visita stessa in agenda, spostarla di mezz'ora non era mai possibile e gli
    orari proposti a una visita allungata finivano in un 409 da forzare.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    day = _parse_day(date)
    if exclude_appointment_id:
        moving = salon_get(Appointment, ctx, exclude_appointment_id)
        parsed, keep_service_ids = _visit_plan(moving)
        location = _get_location(ctx, location_id) if location_id else moving.location
        return availability_services.get_free_slots(
            ctx.salon,
            day,
            parsed,
            location,
            exclude_appointment_id=moving.id,
            keep_service_ids=keep_service_ids,
        )
    return availability_services.get_free_slots(
        ctx.salon,
        day,
        _parse_items_param(items),
        location=_get_location(ctx, location_id),
    )


# ---- Endpoint app cliente --------------------------------------------------------


@router.get("/client/appointments", auth=client_auth)
def client_appointments(request):
    """Appuntamenti del cliente: futuri (attivi) e passati, in forma compatta."""
    ctx = request.auth
    now = timezone.now()
    deposit_holds.process_deposit_holds(ctx.salon)
    appointments = list(
        Appointment.objects.filter(salon=ctx.salon, client=ctx.client)
        .select_related("operator")
        .prefetch_related("items__service")
        .order_by("start")
    )
    gifts = gift_index(ctx.salon, [ctx.client.id])
    upcoming = [
        _client_appointment_out(a, gifts)
        for a in appointments
        if a.start >= now and a.status in Appointment.OPEN_STATUSES
    ]
    past = [
        _client_appointment_out(a, gifts)
        for a in reversed(appointments)
        if a.start < now or a.status not in Appointment.OPEN_STATUSES
    ]
    return {"upcoming": upcoming, "past": past}


def _client_move_location(salon, appointment):
    """Sede su cui si cerca e si conferma lo spostamento dall'app: quella della visita."""
    return appointment.location or default_location(salon)


def _unbookable_operator_ids(salon, parsed: list[dict], location) -> list[int]:
    """Operatrici delle righe che su quella sede non si prenotano più, in ordine di catena."""
    bookable = occupancy.bookable_operator_ids(salon, location)
    missing: list[int] = []
    for item in parsed:
        op_id = item["operator_id"]
        if op_id not in bookable and op_id not in missing:
            missing.append(op_id)
    return missing


# La ricerca riassegna le righe di un'operatrice non più prenotabile a una
# collega, e la conferma sa riassegnare UNA colonna per spostamento: con due
# operatrici uscite nella stessa visita l'app non può spostarla da sola.
CLIENT_MOVE_NEEDS_SALON_MESSAGE = "Per spostare questa visita contatta il salone"


@router.get("/client/availability", auth=client_auth, response=list[SlotOut])
def client_availability(request, date: str, items: str = "", exclude_appointment_id: int = None):
    """Disponibilità per il cliente. `exclude_appointment_id` (solo un proprio
    appuntamento) serve allo spostamento: l'appuntamento che si sta spostando
    non deve contare come occupato, e il piano viene dalla visita stessa
    (`items` si ignora)."""
    ctx = request.auth
    exclude = None
    keep_service_ids = ()
    location = default_location(ctx.salon)
    if exclude_appointment_id:
        moving = salon_get(Appointment, ctx, exclude_appointment_id, client=ctx.client)
        exclude = moving.id
        parsed, keep_service_ids = _visit_plan(moving)
        # Si cerca sulla sede dove la visita è già fissata.
        location = _client_move_location(ctx.salon, moving)
        if len(_unbookable_operator_ids(ctx.salon, parsed, location)) > 1:
            raise HttpError(400, CLIENT_MOVE_NEEDS_SALON_MESSAGE)
    else:
        parsed = _parse_items_param(items)
    slots = availability_services.get_free_slots(
        ctx.salon,
        _parse_day(date),
        parsed,
        location,
        exclude_appointment_id=exclude,
        keep_service_ids=keep_service_ids,
    )
    return availability_services.smart_slots(ctx.salon, slots)


# Richieste di disponibilità pubbliche per IP e per ora: una ricerca costa
# decine di interrogazioni al database, e l'endpoint è senza autenticazione.
PUBLIC_AVAILABILITY_MAX_PER_WINDOW = 120
PUBLIC_AVAILABILITY_WINDOW_SECONDS = 3600


@router.get("/public/availability", response=list[SlotOut])
def public_availability(request, salon: str, date: str, items: str):
    """Disponibilità pubblica (no auth): solo orari liberi, salone per slug."""
    parsed = _parse_items_param(items)
    try:
        s = Salon.objects.get(slug=salon)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")
    if not ratelimit.hit(
        f"public-avail:{s.id}:{ratelimit.client_ip(request)}",
        PUBLIC_AVAILABILITY_MAX_PER_WINDOW,
        PUBLIC_AVAILABILITY_WINDOW_SECONDS,
    ):
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")
    # Stessa sede della prenotazione: cercando su tutte e prenotando sulla
    # predefinita, l'app mostrava orari che poi rifiutava con un 409.
    return availability_services.smart_slots(
        s,
        availability_services.get_free_slots(s, _parse_day(date), parsed, default_location(s)),
    )


# Le rotte dell'app rispondono con la scheda della CLIENTE (`_client_appointment_out`):
# con quella dello staff le arrivavano la nota interna scritta su di lei
# («cliente morosa…»), `forced`, `created_via` e il motivo di annullamento.


@router.post("/client/appointments", auth=client_auth, response=ClientAppointmentOut)
def client_create_appointment(request, data: ClientAppointmentCreateIn):
    """Prenotazione dall'app: mai nel passato, solo servizi attivi, sulla sede
    predefinita del salone (l'app non sceglie la sede), mai nella posa di
    un'altra cliente nemmeno con la stilista scelta."""
    ctx = request.auth
    location = default_location(ctx.salon)
    appointment = appointment_services.create_appointment(
        ctx.salon,
        ctx.client,
        [item.dict() for item in data.items],
        data.start,
        via=Appointment.CreatedVia.APP,
        location=location,
        allow_past=False,
        allow_soak=False,
    )
    deposits.send_deposit_link(appointment)
    return _client_appointment_out(appointment, gift_index(ctx.salon, [ctx.client.id]))


def _client_move_reassignment(salon, appointment, start):
    """(operatrice, colonna di partenza) da passare allo spostamento dall'app.

    Se tutte le operatrici della visita si prenotano ancora, nessuna: lo
    spostamento le tiene. Se una non si prenota più (disattivata, o di un'altra
    sede), la ricerca ha proposto per quell'orario una collega al suo posto, e
    la conferma deve applicare esattamente quella: prima teneva l'operatrice
    uscita e validava sui SUOI turni — 409 «orario appena preso» a ripetizione
    sugli orari della collega, o la visita spostata ma ancora a chi non lavora
    più lì, senza nessuno che l'avesse in colonna.
    """
    if appointment.status not in Appointment.OPEN_STATUSES or start < timezone.now():
        # visita chiusa o annullata, orario passato: li rifiuta lo spostamento
        # stesso, con il suo 400
        return None, None
    parsed, keep_service_ids = _visit_plan(appointment)
    location = _client_move_location(salon, appointment)
    missing = _unbookable_operator_ids(salon, parsed, location)
    if not missing:
        return None, None
    if len(missing) > 1:
        raise HttpError(400, CLIENT_MOVE_NEEDS_SALON_MESSAGE)
    assignment = availability_services.slot_assignment(
        salon, start, parsed, location,
        exclude_appointment_id=appointment.id, keep_service_ids=keep_service_ids,
    )
    if assignment is None:
        raise HttpError(409, "Orario non più disponibile")
    replacement_id = next(
        chosen["operator_id"]
        for item, chosen in zip(parsed, assignment)
        if item["operator_id"] == missing[0]
    )
    from apps.staff.models import Operator  # lazy

    by_id = Operator.objects.in_bulk([replacement_id, missing[0]])
    return by_id[replacement_id], by_id[missing[0]]


@router.post(
    "/client/appointments/{int:appointment_id}/move", auth=client_auth, response=ClientAppointmentOut
)
def client_move_appointment(request, appointment_id: int, data: ClientMoveIn):
    ctx = request.auth
    appointment = salon_get(Appointment, ctx, appointment_id, client=ctx.client)
    if not transitions.client_notice_ok(appointment):
        raise HttpError(
            400,
            "Spostamento non consentito a meno di "
            f"{settings.CLIENT_MOVE_CANCEL_MIN_HOURS} ore dall'appuntamento: "
            "contatta il salone",
        )
    operator, from_operator = _client_move_reassignment(ctx.salon, appointment, data.start)
    appointment = appointment_services.move_appointment(
        appointment, data.start, operator=operator, from_operator=from_operator, allow_past=False,
    )
    return _client_appointment_out(appointment, gift_index(ctx.salon, [ctx.client.id]))


@router.post(
    "/client/appointments/{int:appointment_id}/cancel", auth=client_auth, response=ClientAppointmentOut
)
def client_cancel_appointment(request, appointment_id: int):
    ctx = request.auth
    appointment = salon_get(Appointment, ctx, appointment_id, client=ctx.client)
    if not transitions.client_notice_ok(appointment):
        raise HttpError(400, "Annullamento non consentito: contatta il salone")
    appointment = transitions.cancel_appointment(appointment, by_client=True)
    return _client_appointment_out(appointment, gift_index(ctx.salon, [ctx.client.id]))


@router.get("/client/waitlist", auth=client_auth, response=list[WaitlistOut])
def client_list_waitlist(request):
    ctx = request.auth
    entries = (
        WaitlistEntry.objects.filter(
            salon=ctx.salon,
            client=ctx.client,
            status__in=[WaitlistEntry.Status.ACTIVE, WaitlistEntry.Status.CONTACTED],
        )
        .select_related("client", "service", "operator")
        .order_by("created_at")
    )
    return [_waitlist_out(e) for e in entries]


@router.post("/client/waitlist", auth=client_auth, response=WaitlistOut)
def client_create_waitlist(request, data: WaitlistIn):
    ctx = request.auth

    from apps.catalog.models import Service  # lazy

    service = salon_get(Service, ctx, data.service_id, active=True)
    operator = None
    if data.operator_id:
        from apps.staff.models import Operator  # lazy

        operator = salon_get(Operator, ctx, data.operator_id, active=True)
    if data.preference not in WaitlistEntry.Preference.values:
        raise HttpError(400, "Preferenza non valida")
    if any(not isinstance(d, int) or d < 0 or d > 6 for d in data.exact_days):
        raise HttpError(400, "Giorni non validi (attesi 0=lunedì … 6=domenica)")

    entry = WaitlistEntry.objects.create(
        salon=ctx.salon,
        client=ctx.client,
        service=service,
        operator=operator,
        preference=data.preference,
        exact_days=data.exact_days,
        exact_time=data.exact_time,
    )
    log_activity(
        ctx.salon,
        "waitlist.created",
        f"{ctx.client.full_name} in lista d'attesa per {service.name_it}",
        payload={"entry_id": entry.id},
    )
    return _waitlist_out(entry)


@router.delete("/client/waitlist/{int:entry_id}", auth=client_auth, response=OkOut)
def client_delete_waitlist(request, entry_id: int):
    ctx = request.auth
    entry = salon_get(WaitlistEntry, ctx, entry_id, client=ctx.client)
    service_name = entry.service.name_it
    entry.delete()
    # L'iscrizione spariva senza lasciare traccia: l'operatrice che aveva appena
    # visto la cliente in lista non capiva più perché non ci fosse.
    log_activity(
        ctx.salon,
        "waitlist.deleted",
        f"{ctx.client.full_name} si è tolta dalla lista d'attesa per {service_name}",
        payload={"entry_id": entry_id, "client_id": ctx.client.id},
    )
    emit_event(
        ctx.salon,
        "waitlist.deleted",
        {"entry_id": entry_id, "client_id": ctx.client.id, "service_name": service_name},
    )
    return OkOut()
