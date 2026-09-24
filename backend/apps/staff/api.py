"""Endpoint /api/staff — operatrici, turni, assenze, performance, clienti serviti."""

import re
from decimal import Decimal
from typing import Optional

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.models import Location, Salon
from apps.core.services import log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import has_scope, require_scope
from common.schemas import OkOut
from common.utils import salon_get

from .models import Absence, Operator, WeeklyShift
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


# Colonne che accettano null nel corpo: nessuna sede, nessun utente collegato.
_NULLABLE_OPERATOR_FIELDS = {"location_id", "user_id"}


def _validate_operator_payload(payload: dict) -> None:
    """Colore, ciclo e ordine arrivano dal client e finiscono grezzi a database.

    Senza questi controlli un ciclo a zero o negativo, o un colore che non è un
    esadecimale, non erano un 400 ma un errore del database: 500, e chi compila
    la scheda non sapeva quale campo rifare. Si controllano i campi presenti:
    in modifica il corpo porta solo quelli cambiati.
    """
    for name, value in payload.items():
        if value is None and name not in _NULLABLE_OPERATOR_FIELDS:
            raise HttpError(400, f"Campo obbligatorio: {name}")
    if "color" in payload and not _HEX_COLOR_RE.match(payload["color"].strip()):
        raise HttpError(400, "Colore non valido (atteso #RRGGBB)")
    if "cycle_weeks" in payload and not (1 <= payload["cycle_weeks"] <= MAX_CYCLE_WEEKS):
        raise HttpError(400, f"Settimane di ciclo non valide (da 1 a {MAX_CYCLE_WEEKS})")
    if "order" in payload and not (0 <= payload["order"] <= MAX_OPERATOR_ORDER):
        raise HttpError(400, "Ordine dell'operatrice non valido")
    if "hourly_cost" in payload and payload["hourly_cost"] < 0:
        raise HttpError(400, "Il costo orario non può essere negativo")


def _apply_operator_payload(operator: Operator, ctx, payload: dict) -> Operator:
    """Applica `payload` (i soli campi da scrivere) e salva.

    In creazione arriva il corpo completo. In modifica solo i campi presenti
    nella richiesta (C19): la scheda costruiva la PUT dal modulo letto
    all'apertura e sostituiva tutto, quindi il colore cambiato dall'agenda o
    l'abilitazione a un servizio data dal listino nel frattempo tornavano
    indietro al primo «Salva» (09-09). Per lo stesso motivo in modifica si
    scrivono solo quelle colonne, e i servizi solo se `service_ids` c'è.
    """
    _validate_operator_payload(payload)
    payload = dict(payload)
    creating = operator.pk is None
    service_ids = payload.pop("service_ids", None)
    if "color" in payload:
        payload["color"] = payload["color"].strip().upper()
    fields = []
    if "location_id" in payload:
        location_id = payload.pop("location_id")
        operator.location = salon_get(Location, ctx, location_id) if location_id else None
        fields.append("location")
    if "user_id" in payload:
        user = _resolve_user(ctx, payload.pop("user_id"))
        if user is not None:
            # `Operator.user` è OneToOne: collegare a un'operatrice un utente già
            # legato a un'altra faceva saltare l'insert con un 500 anonimo.
            taken = Operator.objects.filter(user=user).exclude(pk=operator.pk).first()
            if taken is not None:
                raise HttpError(400, f"Utente già collegato a {taken.first_name} {taken.last_name}")
        operator.user = user
        fields.append("user")
    for name, value in payload.items():
        setattr(operator, name, value)
        fields.append(name)

    # Abbassare `cycle_weeks` lasciava a database i turni delle settimane
    # scomparse: `_week_index` non li seleziona più da nessuna data, quindi
    # l'operatrice risultava a riposo per metà delle settimane senza che nulla
    # lo mostrasse. Si cancellano nella stessa transazione del salvataggio.
    orphans = 0
    with transaction.atomic():
        if creating:
            operator.salon = ctx.salon
            operator.save()
        else:
            # Stesso lock di `replace_shifts`: la pulizia dei turni fuori ciclo
            # e una sostituzione dei turni in corsa non si incrociano.
            Operator.objects.select_for_update().filter(pk=operator.pk).first()
            if fields:
                operator.save(update_fields=fields)
            if "cycle_weeks" in payload:
                orphans = operator.shifts.filter(week_index__gte=operator.cycle_weeks).delete()[0]
        if service_ids is not None:
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
                "windows": [(_fmt_min(a), _fmt_min(b)) for a, b in status["windows"]],
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
    operator = _apply_operator_payload(Operator(), ctx, data.dict())
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
    operator = _apply_operator_payload(operator, ctx, data.dict(exclude_unset=True))
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
    with transaction.atomic():
        # Cancella-e-ricrea sotto lock sulla riga dell'operatrice: su PostgreSQL
        # il DELETE del secondo di due salvataggi simultanei non vedeva le righe
        # appena inserite dal primo, e restavano entrambe le serie sovrapposte —
        # proprio ciò che `_reject_overlapping_shifts` vieta (18-14). Le righe si
        # validano sull'operatrice riletta sotto lock: il ciclo ridotto nel
        # frattempo non lascia turni fuori ciclo.
        operator = Operator.objects.select_for_update().get(pk=operator.pk)
        for row in data.shifts:
            _validate_shift_row(operator, row)
        _reject_overlapping_shifts(data.shifts)
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
    quelle senza sede, lo stesso filtro di `agenda.services._operators_qs`.
    Elencandole tutte, la cliente sceglieva una stilista di un'altra sede, la
    ricerca le mostrava orari di una collega e la conferma rispondeva 400
    «Operatrice non idonea»: con lei dall'app non si prenotava mai (09-03,
    16-04, 04-04).
    """
    from apps.agenda.services import default_location  # lazy: agenda è caricata dopo staff

    s = _get_salon_by_slug(salon)
    # Endpoint senza auth: come la disponibilità pubblica in agenda, va limitato
    # per IP, altrimenti chiunque può sfogliare il team di ogni salone a raffica.
    if not ratelimit.hit(
        f"public-operators:{s.id}:{ratelimit.client_ip(request)}",
        PUBLIC_OPERATORS_MAX_PER_WINDOW,
        PUBLIC_OPERATORS_WINDOW_SECONDS,
    ):
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")
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
