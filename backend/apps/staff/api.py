"""Endpoint /api/staff — operatrici, turni, assenze, performance, clienti serviti."""

from decimal import Decimal

from django.db.models import Q
from django.utils import timezone
from ninja import Router

from apps.core.services import default_location, get_salon_by_slug, log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import has_scope, require_scope
from common.schemas import OkOut
from common.utils import salon_get
from common.validation import require_hex_color

from .models import Absence, Operator
from .operators import (
    absence_or_404,
    replace_operator_shifts,
    save_operator,
    validate_absence,
)
from .schemas import (
    AbsenceIn,
    AbsenceOut,
    OperatorColorIn,
    OperatorDetailOut,
    OperatorIn,
    OperatorOut,
    OperatorPatchIn,
    OperatorStatusOut,
    PerformanceOut,
    PublicOperatorOut,
    ServedClientOut,
    ShiftsReplaceIn,
    WeeklyShiftOut,
)
from .services import min_to_hm, today_status
from .stats import (
    month_revenue_by_operator,
    performance_series,
    served_clients,
    today_clients_by_operator,
)

router = Router(tags=["staff"])

PUBLIC_OPERATORS_MAX_PER_WINDOW = 120
PUBLIC_OPERATORS_WINDOW_SECONDS = 300


# ---- Helpers -----------------------------------------------------------------


def _operators_qs(ctx):
    # `today_status` legge turni, assenze e orari di apertura del salone: senza
    # questi precaricamenti la lista operatrici faceva una manciata di query per
    # riga, su una pagina che sta aperta tutto il giorno.
    return (
        Operator.objects.filter(salon=ctx.salon)
        .select_related("salon", "salon__settings")
        .prefetch_related("services", "shifts", "absences")
    )


def _sees_cash(ctx) -> bool:
    """Incassi per operatrice e spesa delle clienti sono dati di cassa.

    La stessa regola della scheda cliente (`get_client`) e delle vendite
    (`list_sales` chiede `sales` anche col filtro operatrice): senza, il ruolo
    «Operatrice» — dato proprio perché non veda gli incassi — li leggeva tutti
    da /api/staff (09-01, 10-09).
    """
    return has_scope(ctx, "sales")


def _sees_hourly_cost(ctx) -> bool:
    """Il costo orario è un dato salariale: lo vede chi gestisce il personale."""
    return has_scope(ctx, "team")


def _operator_out(op: Operator, ctx) -> dict:
    hourly_cost_visible = _sees_hourly_cost(ctx)
    return {
        "id": op.id,
        "first_name": op.first_name,
        "last_name": op.last_name,
        "initials": op.initials,
        "color": op.color,
        "role_title": op.role_title,
        "location_id": op.location_id,
        "user_id": op.user_id,
        "service_ids": [s.id for s in op.services.all()],
        # null e non 0: «0 €/h» sarebbe un dato falso, non un dato nascosto (C6).
        "hourly_cost": op.hourly_cost if hourly_cost_visible else None,
        "cycle_weeks": op.cycle_weeks,
        "active": op.active,
        "order": op.order,
        "cash_hidden": not hourly_cost_visible,
    }


# ---- Lista operatrici con stato di oggi ----------------------------------------


@router.get("/", auth=staff_auth, response=list[OperatorStatusOut])
def list_operators(request, include_inactive: bool = False):
    """Operatrici con lo stato di oggi.

    `include_inactive=true` restituisce anche le disattivate (`active: false`,
    C8): la scheda si apriva solo da questa lista, quindi un'operatrice spenta
    per errore o rientrata dopo mesi non si ritrovava più per riattivarla
    (09-05, 15-05).
    """
    ctx = request.auth
    today = timezone.localdate()
    operators = _operators_qs(ctx)
    if not include_inactive:
        operators = operators.filter(active=True)
    operators = list(operators)
    sees_cash = _sees_cash(ctx)
    # Incasso del mese e clienti di oggi in due query per l'intera lista, non
    # due per operatrice (vedi `month_revenue_by_operator`).
    revenues = month_revenue_by_operator(operators, today) if sees_cash else {}
    clients = today_clients_by_operator(operators, today)
    result = []
    for op in operators:
        status = today_status(op, today)
        out = _operator_out(op, ctx)
        out.update(
            {
                "on_shift": status["on_shift"],
                "windows": [(min_to_hm(a), min_to_hm(b)) for a, b in status["windows"]],
                "absence_type": status["absence_type"],
                "month_revenue": revenues.get(op.id, Decimal("0")) if sees_cash else None,
                "today_clients": clients.get(op.id, 0),
                "cash_hidden": out["cash_hidden"] or not sees_cash,
            }
        )
        result.append(out)
    return result


# ---- CRUD operatrici -----------------------------------------------------------


@router.post("/", auth=staff_auth, response=OperatorOut)
def create_operator(request, data: OperatorIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = save_operator(Operator(), ctx, data.dict())
    log_activity(
        ctx.salon,
        "operator.created",
        f"Nuova operatrice: {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id},
    )
    return _operator_out(operator, ctx)


@router.get("/{int:operator_id}", auth=staff_auth, response=OperatorDetailOut)
def get_operator(request, operator_id: int):
    op = salon_get(Operator, request.auth, operator_id)
    out = _operator_out(op, request.auth)
    out["shifts"] = list(op.shifts.all())
    return out


@router.put("/{int:operator_id}", auth=staff_auth, response=OperatorOut)
def update_operator(request, operator_id: int, data: OperatorPatchIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    operator = save_operator(operator, ctx, data.dict(exclude_unset=True))
    log_activity(
        ctx.salon,
        "operator.updated",
        f"Operatrice aggiornata: {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id},
    )
    return _operator_out(operator, ctx)


@router.patch("/{int:operator_id}/color", auth=staff_auth, response=OperatorOut)
def set_operator_color(request, operator_id: int, data: OperatorColorIn):
    """Colore dell'operatrice in agenda: condiviso fra tutte le postazioni.

    Prima viveva solo nello stato locale della dashboard e ogni pc vedeva il
    suo. Basta il permesso agenda: è una preferenza di lavoro in sala, non
    un dato anagrafico. L'evento `operator.updated` fa ricaricare le altre.
    """
    ctx = request.auth
    require_scope(ctx, "agenda")
    operator = salon_get(Operator, ctx, operator_id)
    color = (data.color or "").strip()
    require_hex_color(color)
    operator.color = color.upper()
    operator.save(update_fields=["color"])
    log_activity(
        ctx.salon,
        "operator.updated",
        f"Colore in agenda di {operator.first_name} aggiornato",
        actor=ctx.user,
        payload={"operator_id": operator.id, "color": operator.color},
    )
    return _operator_out(operator, ctx)


@router.delete("/{int:operator_id}", auth=staff_auth, response=OkOut)
def delete_operator(request, operator_id: int):
    """Soft delete: l'operatrice resta in archivio (storico turni/vendite intatto)."""
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    operator.active = False
    operator.save(update_fields=["active"])
    log_activity(
        ctx.salon,
        "operator.deleted",
        f"Operatrice disattivata: {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id},
    )
    return OkOut()


# ---- Turni: sostituzione integrale del pattern ---------------------------------


@router.put("/{int:operator_id}/shifts", auth=staff_auth, response=list[WeeklyShiftOut])
def replace_shifts(request, operator_id: int, data: ShiftsReplaceIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    operator, shifts = replace_operator_shifts(operator, data.shifts)
    log_activity(
        ctx.salon,
        "operator.shifts_updated",
        f"Turni aggiornati per {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id, "shifts_count": len(shifts)},
    )
    return list(operator.shifts.all())


# ---- Assenze -----------------------------------------------------------------


@router.get("/{int:operator_id}/absences", auth=staff_auth, response=list[AbsenceOut])
def list_absences(request, operator_id: int):
    operator = salon_get(Operator, request.auth, operator_id)
    return operator.absences.all()


@router.post("/{int:operator_id}/absences", auth=staff_auth, response=AbsenceOut)
def create_absence(request, operator_id: int, data: AbsenceIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    validate_absence(data)
    absence = Absence.objects.create(operator=operator, **data.dict())
    log_activity(
        ctx.salon,
        "operator.absence_created",
        f"Assenza registrata per {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id, "absence_id": absence.id},
    )
    return absence


@router.put("/{int:operator_id}/absences/{int:absence_id}", auth=staff_auth, response=AbsenceOut)
def update_absence(request, operator_id: int, absence_id: int, data: AbsenceIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    absence = absence_or_404(operator, absence_id)
    validate_absence(data)
    for name, value in data.dict().items():
        setattr(absence, name, value)
    absence.save()
    log_activity(
        ctx.salon,
        "operator.absence_updated",
        f"Assenza aggiornata per {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id, "absence_id": absence.id},
    )
    return absence


@router.delete("/{int:operator_id}/absences/{int:absence_id}", auth=staff_auth, response=OkOut)
def delete_absence(request, operator_id: int, absence_id: int):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    absence = absence_or_404(operator, absence_id)
    absence.delete()
    log_activity(
        ctx.salon,
        "operator.absence_deleted",
        f"Assenza eliminata per {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id},
    )
    return OkOut()


# ---- Performance e clienti serviti ---------------------------------------------


@router.get("/{int:operator_id}/performance", auth=staff_auth, response=list[PerformanceOut])
def get_performance(request, operator_id: int, months: int = 6):
    ctx = request.auth
    operator = salon_get(Operator, ctx, operator_id)
    series = performance_series(operator, months=months)
    if not _sees_cash(ctx):
        # Il fatturato mese per mese dell'operatrice è un dato di cassa (C6).
        for row in series:
            row["revenue"] = None
            row["cash_hidden"] = True
    return series


@router.get("/{int:operator_id}/clients", auth=staff_auth, response=list[ServedClientOut])
def get_served_clients(request, operator_id: int, q: str = ""):
    ctx = request.auth
    operator = salon_get(Operator, ctx, operator_id)
    rows = served_clients(operator, q=q)
    if not _sees_cash(ctx):
        # Spesa, visite e ultima visita: gli stessi dati che la scheda cliente
        # nasconde a chi non ha il permesso vendite (`stats_hidden`), che qui
        # passavano comunque (09-01, C6).
        for row in rows:
            row.update(visits=None, last_visit=None, total_spent=None, cash_hidden=True)
    return rows


# ---- Endpoint pubblico (web app cliente, no auth) -------------------------------


@router.get("/public/operators", response=list[PublicOperatorOut])
def public_operators(request, salon: str):
    """Operatrici prenotabili dall'app, per la scelta dello stilista.

    Solo quelle della sede su cui l'app cerca e prenota (la predefinita) e
    quelle senza sede, lo stesso filtro di `agenda.services.occupancy._operators_qs`.
    Elencandole tutte, la cliente sceglieva una stilista di un'altra sede, la
    ricerca le mostrava orari di una collega e la conferma rispondeva 400
    «Operatrice non idonea»: con lei dall'app non si prenotava mai (09-03,
    16-04, 04-04).
    """
    s = get_salon_by_slug(salon)
    # Endpoint senza auth: come la disponibilità pubblica in agenda, va limitato
    # per IP, altrimenti chiunque può sfogliare il team di ogni salone a raffica.
    ratelimit.enforce_public(
        request, s, "operators", PUBLIC_OPERATORS_MAX_PER_WINDOW, PUBLIC_OPERATORS_WINDOW_SECONDS
    )
    operators = Operator.objects.filter(salon=s, active=True)
    location = default_location(s)
    if location is not None:
        operators = operators.filter(Q(location__isnull=True) | Q(location=location))
    operators = operators.order_by("order", "id").prefetch_related("services")
    return [
        {
            "id": op.id,
            "first_name": op.first_name,
            "last_name": op.last_name,
            "initials": op.initials,
            "color": op.color,
            # `values_list` avrebbe ignorato il prefetch e rifatto una query per riga.
            "service_ids": [service.id for service in op.services.all()],
        }
        for op in operators
    ]
