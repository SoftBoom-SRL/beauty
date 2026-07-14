"""KPI e analisi per il titolare del salone.

apps.insights non ha modelli propri: aggrega dati di agenda, sales, clients,
catalog e staff. Ogni funzione qui dentro DEVE degradare a 0 (o lista vuota)
quando i dati mancano — mai sollevare eccezioni per un dataset vuoto.

Import cross-app: i modelli sono importati a livello di modulo (a runtime le
altre app esisteranno, vedi SPEC.md §0). `staff.services.shift_windows` viene
invece importato lazy dentro le funzioni per evitare cicli, come richiesto.
"""

from datetime import date as date_cls
from datetime import datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Count, DateField, Sum
from django.db.models.functions import TruncDate, TruncMonth, TruncWeek
from django.utils import timezone
from ninja.errors import HttpError

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import ServiceCategory
from apps.clients.models import Client, ClientCategory
from apps.sales.models import Sale, SaleLine
from apps.staff.models import Operator

PERIODS = {"month", "quarter", "year"}
GRANULARITIES = {"day", "week", "month"}

ZERO = Decimal("0.00")

# Stati "prenotati" ai fini dell'occupazione e stati terminali usati dai KPI.
_OCCUPIED_STATUSES = ("closed", "confirmed")
_CLOSED = "closed"
_NO_SHOW = "no_show"
_CANCELLED = "cancelled"


# ---------------------------------------------------------------------------
# Periodi
# ---------------------------------------------------------------------------


def _add_months(d: date_cls, months: int) -> date_cls:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    return date_cls(year, month, 1)


def period_range(period: str, date: date_cls | None = None) -> tuple[datetime, datetime]:
    """Intervallo [start, end) del periodo che contiene `date` (default oggi).

    `period` è month/quarter/year. `end` è esclusivo. start/end sono datetime
    timezone-aware nel fuso applicativo corrente.
    """
    if period not in PERIODS:
        raise HttpError(400, "Periodo non valido: usa month, quarter o year")
    anchor = date or timezone.localdate()
    if period == "month":
        start_date = anchor.replace(day=1)
        end_date = _add_months(start_date, 1)
    elif period == "quarter":
        quarter_start_month = (anchor.month - 1) // 3 * 3 + 1
        start_date = date_cls(anchor.year, quarter_start_month, 1)
        end_date = _add_months(start_date, 3)
    else:  # year
        start_date = date_cls(anchor.year, 1, 1)
        end_date = date_cls(anchor.year + 1, 1, 1)
    tz = timezone.get_current_timezone()
    start = timezone.make_aware(datetime.combine(start_date, time.min), tz)
    end = timezone.make_aware(datetime.combine(end_date, time.min), tz)
    return start, end


def _dates_in_range(start: datetime, end: datetime) -> list[date_cls]:
    """Elenco dei giorni [start.date(), end.date())."""
    d, end_d = start.date(), end.date()
    days = []
    while d < end_d:
        days.append(d)
        d += timedelta(days=1)
    return days


# ---------------------------------------------------------------------------
# Helper numerici — degradano sempre a 0, mai eccezioni
# ---------------------------------------------------------------------------


def _safe_div(numerator, denominator, ndigits: int = 4) -> float:
    if not denominator:
        return 0.0
    return round(float(numerator) / float(denominator), ndigits)


def _safe_pct(numerator, denominator, ndigits: int = 1) -> float:
    """Percentuale 0-100, cap a 100."""
    if not denominator:
        return 0.0
    pct = float(numerator) / float(denominator) * 100
    return round(min(pct, 100.0), ndigits)


def _safe_avg_money(total: Decimal, count: int) -> Decimal:
    if not count:
        return ZERO
    return (Decimal(total) / count).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------------------
# Occupazione (turni da staff.shift_windows)
# ---------------------------------------------------------------------------


def _operator_shift_minutes(operator, d: date_cls) -> int:
    from apps.staff.services import shift_windows  # lazy: evita import circolare con staff

    windows = shift_windows(operator, d) or []
    return sum(max(0, end - start) for start, end in windows)


def _daily_shift_minutes(salon, days: list[date_cls]) -> dict[date_cls, int]:
    if not days:
        return {}
    operators = list(Operator.objects.filter(salon=salon, active=True))
    if not operators:
        return {d: 0 for d in days}
    return {d: sum(_operator_shift_minutes(op, d) for op in operators) for d in days}


def _daily_booked_minutes(salon, start: datetime, end: datetime, statuses) -> dict[date_cls, int]:
    rows = (
        AppointmentService.objects.filter(
            appointment__salon=salon,
            appointment__status__in=statuses,
            appointment__start__gte=start,
            appointment__start__lt=end,
        )
        .annotate(day=TruncDate("appointment__start", output_field=DateField()))
        .values("day")
        .annotate(total=Sum("duration_min"))
    )
    return {row["day"]: row["total"] or 0 for row in rows}


def _occupancy_for_days(
    booked_by_day: dict[date_cls, int], shift_by_day: dict[date_cls, int], days: list[date_cls]
) -> float:
    booked = sum(booked_by_day.get(d, 0) for d in days)
    available = sum(shift_by_day.get(d, 0) for d in days)
    return _safe_pct(booked, available)


def occupancy_by_weekday(salon, period: str, date: date_cls | None = None) -> list[dict]:
    start, end = period_range(period, date)
    days = _dates_in_range(start, end)
    booked_by_day = _daily_booked_minutes(salon, start, end, _OCCUPIED_STATUSES)
    shift_by_day = _daily_shift_minutes(salon, days)
    result = []
    for weekday in range(7):
        weekday_days = [d for d in days if d.weekday() == weekday]
        result.append(
            {
                "weekday": weekday,
                "occupancy_pct": _occupancy_for_days(booked_by_day, shift_by_day, weekday_days),
            }
        )
    return result


# ---------------------------------------------------------------------------
# Serie ricavi
# ---------------------------------------------------------------------------

_TRUNC = {"day": TruncDate, "week": TruncWeek, "month": TruncMonth}


def _buckets(days: list[date_cls], granularity: str) -> list[date_cls]:
    if granularity == "day":
        return days
    seen: list[date_cls] = []
    for d in days:
        bucket = d - timedelta(days=d.weekday()) if granularity == "week" else d.replace(day=1)
        if bucket not in seen:
            seen.append(bucket)
    return seen


def revenue_series(
    salon, period: str, granularity: str = "day", date: date_cls | None = None
) -> list[dict]:
    if granularity not in GRANULARITIES:
        raise HttpError(400, "Granularità non valida: usa day, week o month")
    start, end = period_range(period, date)
    trunc = _TRUNC[granularity]
    rows = (
        Sale.objects.filter(salon=salon, created_at__gte=start, created_at__lt=end)
        .annotate(bucket=trunc("created_at", output_field=DateField()))
        .values("bucket")
        .annotate(revenue=Sum("total"))
    )
    by_bucket = {row["bucket"]: row["revenue"] or ZERO for row in rows}
    buckets = _buckets(_dates_in_range(start, end), granularity)
    return [{"date": b, "revenue": by_bucket.get(b, ZERO)} for b in buckets]


def revenue_by_category(salon, period: str, date: date_cls | None = None) -> list[dict]:
    """Ricavi per categoria servizio nel periodo; le righe prodotto confluiscono in "Prodotti"."""
    start, end = period_range(period, date)
    service_rows = (
        SaleLine.objects.filter(
            sale__salon=salon,
            sale__created_at__gte=start,
            sale__created_at__lt=end,
            line_type="service",
        )
        .values("service__category_id")
        .annotate(revenue=Sum("amount"))
    )
    revenue_by_cat_id = {row["service__category_id"]: row["revenue"] or ZERO for row in service_rows}

    categories = ServiceCategory.objects.filter(salon=salon).order_by("order", "id")
    result = [
        {"category": c.name_it, "revenue": revenue_by_cat_id.get(c.id, ZERO)} for c in categories
    ]

    product_revenue = (
        SaleLine.objects.filter(
            sale__salon=salon,
            sale__created_at__gte=start,
            sale__created_at__lt=end,
            line_type="product",
        ).aggregate(total=Sum("amount"))["total"]
        or ZERO
    )
    result.append({"category": "Prodotti", "revenue": product_revenue})
    return result


# ---------------------------------------------------------------------------
# KPI principali
# ---------------------------------------------------------------------------


def kpis(salon, period: str, date: date_cls | None = None) -> dict:
    start, end = period_range(period, date)
    today = timezone.localdate()
    days = _dates_in_range(start, end)

    # --- vendite -------------------------------------------------------
    sales_qs = Sale.objects.filter(salon=salon, created_at__gte=start, created_at__lt=end)
    revenue = sales_qs.aggregate(total=Sum("total"))["total"] or ZERO
    sales_count = sales_qs.count()
    avg_ticket = _safe_avg_money(revenue, sales_count)
    retail_revenue = (
        SaleLine.objects.filter(
            sale__salon=salon,
            sale__created_at__gte=start,
            sale__created_at__lt=end,
            line_type="product",
        ).aggregate(total=Sum("amount"))["total"]
        or ZERO
    )

    # --- appuntamenti ----------------------------------------------------
    appts_qs = Appointment.objects.filter(salon=salon, start__gte=start, start__lt=end)
    total_appointments = appts_qs.count()
    closed_qs = appts_qs.filter(status=_CLOSED)
    appointments_count = closed_qs.count()
    noshow_count = appts_qs.filter(status=_NO_SHOW).count()
    cancel_count = appts_qs.filter(status=_CANCELLED).count()
    noshow_rate = _safe_div(noshow_count, total_appointments)
    cancel_rate = _safe_div(cancel_count, total_appointments)

    booked_by_day = _daily_booked_minutes(salon, start, end, _OCCUPIED_STATUSES)
    shift_by_day = _daily_shift_minutes(salon, days)
    occupancy_pct = _occupancy_for_days(booked_by_day, shift_by_day, days)

    # --- clienti -----------------------------------------------------------
    closed_client_ids = set(closed_qs.values_list("client_id", flat=True).distinct())
    clients_1plus = len(closed_client_ids)
    per_client_counts = closed_qs.values("client_id").annotate(cnt=Count("id"))
    clients_2plus = sum(1 for row in per_client_counts if row["cnt"] >= 2)
    return_rate = _safe_div(clients_2plus, clients_1plus)

    future_client_ids: set = set()
    if closed_client_ids:
        future_client_ids = set(
            Appointment.objects.filter(
                salon=salon, client_id__in=closed_client_ids, start__date__gte=today
            )
            .exclude(status__in=[_CANCELLED, _NO_SHOW])
            .values_list("client_id", flat=True)
        )
    rebooking_rate = _safe_div(len(future_client_ids), clients_1plus)

    new_client_ids = set(
        Client.objects.filter(
            salon=salon, since__gte=start.date(), since__lt=end.date()
        ).values_list("id", flat=True)
    )
    new_clients = len(new_client_ids)
    returning_clients = len(closed_client_ids - new_client_ids)

    avg_frequency = _safe_div(appointments_count, clients_1plus)

    clients_by_category = [
        {
            "category": cat.name,
            "count": Client.objects.filter(salon=salon, is_active=True, categories=cat).count(),
        }
        for cat in ClientCategory.objects.filter(salon=salon).order_by("order", "id")
    ]

    return {
        "revenue": revenue,
        "sales_count": sales_count,
        "avg_ticket": avg_ticket,
        "retail_revenue": retail_revenue,
        "appointments_count": appointments_count,
        "noshow_rate": noshow_rate,
        "cancel_rate": cancel_rate,
        "occupancy_pct": occupancy_pct,
        "return_rate": return_rate,
        "rebooking_rate": rebooking_rate,
        "new_clients": new_clients,
        "returning_clients": returning_clients,
        "avg_frequency": avg_frequency,
        "clients_by_category": clients_by_category,
    }
