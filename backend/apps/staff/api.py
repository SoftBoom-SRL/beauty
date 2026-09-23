"""Endpoint /api/staff — operatrici, turni, assenze, performance, clienti serviti."""

import re
from decimal import Decimal
from typing import Optional

from django.db import transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.models import Location, Salon
from apps.core.services import log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from .models import Absence, Operator, WeeklyShift
from .schemas import (
    AbsenceIn,
    AbsenceOut,
    OkOut,
    OperatorColorIn,
    OperatorDetailOut,
    OperatorIn,
    OperatorOut,
    OperatorStatusOut,
    PerformanceOut,
    PublicOperatorOut,
    ServedClientOut,
    ShiftsReplaceIn,
    WeeklyShiftOut,
)
from .services import (
    month_revenue_by_operator,
    performance_series,
    served_clients,
    today_clients_by_operator,
    today_status,
)

router = Router(tags=["staff"])

_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}\Z")
# Un ciclo di turni più lungo di un anno non esiste in un salone, e il campo a
# database è PositiveSmallIntegerField: senza tetto (e senza minimo) il valore
# diventava un errore del database (500) invece di un errore della richiesta.
MAX_CYCLE_WEEKS = 52
MAX_OPERATOR_ORDER = 2147483647  # limite di PositiveIntegerField

PUBLIC_OPERATORS_MAX_PER_WINDOW = 120
PUBLIC_OPERATORS_WINDOW_SECONDS = 300


# ---- Helpers -----------------------------------------------------------------


def _fmt_min(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _catalog_service_model():
    from apps.catalog.models import Service  # lazy: catalog è caricata dopo staff

    return Service


def _resolve_user(ctx, user_id: Optional[int]):
    """L'utente staff associato all'operatrice deve appartenere allo stesso team."""
    if not user_id:
        return None
    from apps.accounts.models import Membership  # lazy: accounts è caricata prima, ma per coerenza di stile

    membership = (
        Membership.objects.filter(salon=ctx.salon, user_id=user_id).select_related("user").first()
    )
    if membership is None:
        raise HttpError(404, "Utente non trovato nel team")
    return membership.user


def _operators_qs(ctx):
    # `today_status` legge turni, assenze e orari di apertura del salone: senza
    # questi precaricamenti la lista operatrici faceva una manciata di query per
    # riga, su una pagina che sta aperta tutto il giorno.
    return (
        Operator.objects.filter(salon=ctx.salon)
        .select_related("salon", "salon__settings")
        .prefetch_related("services", "shifts", "absences")
    )


def _get_salon_by_slug(slug: str) -> Salon:
    try:
        return Salon.objects.get(slug=slug)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")


def _operator_out(op: Operator) -> dict:
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
        "hourly_cost": op.hourly_cost,
        "cycle_weeks": op.cycle_weeks,
        "active": op.active,
        "order": op.order,
    }


def _validate_operator_payload(data: OperatorIn) -> None:
    """Colore, ciclo e ordine arrivano dal client e finiscono grezzi a database.

    Senza questi controlli un ciclo a zero o negativo, o un colore che non è un
    esadecimale, non erano un 400 ma un errore del database: 500, e chi compila
    la scheda non sapeva quale campo rifare.
    """
    if not _HEX_COLOR_RE.match((data.color or "").strip()):
        raise HttpError(400, "Colore non valido (atteso #RRGGBB)")
    if not (1 <= data.cycle_weeks <= MAX_CYCLE_WEEKS):
        raise HttpError(400, f"Settimane di ciclo non valide (da 1 a {MAX_CYCLE_WEEKS})")
    if not (0 <= data.order <= MAX_OPERATOR_ORDER):
        raise HttpError(400, "Ordine dell'operatrice non valido")
    if data.hourly_cost < 0:
        raise HttpError(400, "Il costo orario non può essere negativo")


def _apply_operator_payload(operator: Operator, ctx, data: OperatorIn) -> Operator:
    _validate_operator_payload(data)
    payload = data.dict()
    service_ids = payload.pop("service_ids")
    location_id = payload.pop("location_id")
    user_id = payload.pop("user_id")
    payload["color"] = payload["color"].strip().upper()

    location = salon_get(Location, ctx, location_id) if location_id else None
    user = _resolve_user(ctx, user_id)
    if user is not None:
        # `Operator.user` è OneToOne: collegare a un'operatrice un utente già
        # legato a un'altra faceva saltare l'insert con un 500 anonimo.
        taken = Operator.objects.filter(user=user).exclude(pk=operator.pk).first()
        if taken is not None:
            raise HttpError(400, f"Utente già collegato a {taken.first_name} {taken.last_name}")

    for name, value in payload.items():
        setattr(operator, name, value)
    operator.salon = ctx.salon
    operator.location = location
    operator.user = user

    # Abbassare `cycle_weeks` lasciava a database i turni delle settimane
    # scomparse: `_week_index` non li seleziona più da nessuna data, quindi
    # l'operatrice risultava a riposo per metà delle settimane senza che nulla
    # lo mostrasse. Si cancellano nella stessa transazione del salvataggio.
    with transaction.atomic():
        operator.save()
        orphans = operator.shifts.filter(week_index__gte=operator.cycle_weeks).delete()[0]
        Service = _catalog_service_model()
        operator.services.set(Service.objects.filter(salon=ctx.salon, id__in=service_ids))
    if orphans:
        log_activity(
            ctx.salon,
            "operator.shifts_updated",
            f"Ciclo turni ridotto a {operator.cycle_weeks} settimane: "
            f"{orphans} righe di turno fuori ciclo rimosse",
            actor=ctx.user,
            payload={"operator_id": operator.id, "removed_shifts": orphans},
        )
    return operator


def _validate_shift_row(operator: Operator, row) -> None:
    if row.weekday not in range(7):
        raise HttpError(400, "Giorno della settimana non valido")
    if not (0 <= row.week_index < (operator.cycle_weeks or 1)):
        raise HttpError(400, "Settimana del ciclo non valida per questa operatrice")
    if not (0 <= row.start_min < row.end_min <= 1440):
        raise HttpError(400, "Orario di turno non valido")
    if (row.break_start_min is None) != (row.break_end_min is None):
        raise HttpError(400, "La pausa richiede sia l'inizio sia la fine")
    if row.break_start_min is not None:
        if not (row.start_min <= row.break_start_min < row.break_end_min <= row.end_min):
            raise HttpError(400, "Orario di pausa non valido")


def _reject_overlapping_shifts(rows) -> None:
    """Due righe dello stesso giorno e della stessa settimana non si sovrappongono.

    Righe contigue (9–13 e 13–18) restano ammesse: sono lo stesso turno spezzato.
    Sovrapporle invece non significa nulla — quale delle due pause vale? — e
    faceva sparire la pausa pranzo dalle finestre lavorabili.
    """
    by_day: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for row in rows:
        by_day.setdefault((row.week_index, row.weekday), []).append((row.start_min, row.end_min))
    for spans in by_day.values():
        spans.sort()
        for (_, previous_end), (start, _) in zip(spans, spans[1:]):
            if start < previous_end:
                raise HttpError(400, "Due righe di turno si sovrappongono nello stesso giorno")


# ---- Lista operatrici con stato di oggi ----------------------------------------


@router.get("/", auth=staff_auth, response=list[OperatorStatusOut])
def list_operators(request):
    ctx = request.auth
    today = timezone.localdate()
    operators = list(_operators_qs(ctx).filter(active=True))
    # Incasso del mese e clienti di oggi in due query per l'intera lista, non
    # due per operatrice (vedi `month_revenue_by_operator`).
    revenues = month_revenue_by_operator(operators, today)
    clients = today_clients_by_operator(operators, today)
    result = []
    for op in operators:
        status = today_status(op, today)
        out = _operator_out(op)
        out.update(
            {
                "on_shift": status["on_shift"],
                "windows": [(_fmt_min(a), _fmt_min(b)) for a, b in status["windows"]],
                "absence_type": status["absence_type"],
                "month_revenue": revenues.get(op.id, Decimal("0")),
                "today_clients": clients.get(op.id, 0),
            }
        )
        result.append(out)
    return result


# ---- CRUD operatrici -----------------------------------------------------------


@router.post("/", auth=staff_auth, response=OperatorOut)
def create_operator(request, data: OperatorIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = _apply_operator_payload(Operator(), ctx, data)
    log_activity(
        ctx.salon,
        "operator.created",
        f"Nuova operatrice: {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id},
    )
    return _operator_out(operator)


@router.get("/{int:operator_id}", auth=staff_auth, response=OperatorDetailOut)
def get_operator(request, operator_id: int):
    op = salon_get(Operator, request.auth, operator_id)
    out = _operator_out(op)
    out["shifts"] = list(op.shifts.all())
    return out


@router.put("/{int:operator_id}", auth=staff_auth, response=OperatorOut)
def update_operator(request, operator_id: int, data: OperatorIn):
    ctx = request.auth
    require_scope(ctx, "team")
    operator = salon_get(Operator, ctx, operator_id)
    operator = _apply_operator_payload(operator, ctx, data)
    log_activity(
        ctx.salon,
        "operator.updated",
        f"Operatrice aggiornata: {operator.first_name} {operator.last_name}",
        actor=ctx.user,
        payload={"operator_id": operator.id},
    )
    return _operator_out(operator)


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
    if not _HEX_COLOR_RE.match(color):
        raise HttpError(400, "Colore non valido (atteso #RRGGBB)")
    operator.color = color.upper()
    operator.save(update_fields=["color"])
    log_activity(
        ctx.salon,
        "operator.updated",
        f"Colore in agenda di {operator.first_name} aggiornato",
        actor=ctx.user,
        payload={"operator_id": operator.id, "color": operator.color},
    )
    return _operator_out(operator)


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
    for row in data.shifts:
        _validate_shift_row(operator, row)
    _reject_overlapping_shifts(data.shifts)
    with transaction.atomic():
        operator.shifts.all().delete()
        shifts = WeeklyShift.objects.bulk_create(
            [
                WeeklyShift(
                    operator=operator,
                    week_index=row.week_index,
                    weekday=row.weekday,
                    start_min=row.start_min,
                    end_min=row.end_min,
                    break_start_min=row.break_start_min,
                    break_end_min=row.break_end_min,
                )
                for row in data.shifts
            ]
        )
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
    if data.type not in Absence.Type.values:
        raise HttpError(400, "Tipo di assenza non valido")
    if data.date_from > data.date_to:
        raise HttpError(400, "L'intervallo di assenza non è valido")
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
    absence = operator.absences.filter(pk=absence_id).first()
    if absence is None:
        raise HttpError(404, "Assenza non trovata")
    if data.type not in Absence.Type.values:
        raise HttpError(400, "Tipo di assenza non valido")
    if data.date_from > data.date_to:
        raise HttpError(400, "L'intervallo di assenza non è valido")
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
    absence = operator.absences.filter(pk=absence_id).first()
    if absence is None:
        raise HttpError(404, "Assenza non trovata")
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
    operator = salon_get(Operator, request.auth, operator_id)
    return performance_series(operator, months=months)


@router.get("/{int:operator_id}/clients", auth=staff_auth, response=list[ServedClientOut])
def get_served_clients(request, operator_id: int, q: str = ""):
    operator = salon_get(Operator, request.auth, operator_id)
    return served_clients(operator, q=q)


# ---- Endpoint pubblico (web app cliente, no auth) -------------------------------


@router.get("/public/operators", response=list[PublicOperatorOut])
def public_operators(request, salon: str):
    """Operatrici attive del salone, per la scelta dello stilista in prenotazione."""
    s = _get_salon_by_slug(salon)
    # Endpoint senza auth: come la disponibilità pubblica in agenda, va limitato
    # per IP, altrimenti chiunque può sfogliare il team di ogni salone a raffica.
    if not ratelimit.hit(
        f"public-operators:{s.id}:{ratelimit.client_ip(request)}",
        PUBLIC_OPERATORS_MAX_PER_WINDOW,
        PUBLIC_OPERATORS_WINDOW_SECONDS,
    ):
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")
    operators = (
        Operator.objects.filter(salon=s, active=True)
        .order_by("order", "id")
        .prefetch_related("services")
    )
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
