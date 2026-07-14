"""Servizi staff: disponibilità (turni/assenze) + KPI operatrice (incasso, clienti).

`shift_windows` è LA funzione consumata dall'agenda (`apps.agenda.services.get_free_slots`)
per sapere quando un'operatrice è lavorabile in una data: la firma non va cambiata.

Import cross-app: `sales.SaleLine` e `agenda.Appointment` sono caricate dopo `staff`
in INSTALLED_APPS e sono implementate da altri agenti in parallelo, quindi ogni
accesso è lazy (`django.apps.apps.get_model`) con degradazione a 0/[] se il modello
non è (ancora) disponibile.
"""

from datetime import date as date_cls
from decimal import Decimal

from django.apps import apps
from django.db.models import Count, Max, Q, Sum
from django.utils import timezone


def _current_absence(operator, on_date: date_cls):
    return (
        operator.absences.filter(date_from__lte=on_date, date_to__gte=on_date)
        .order_by("date_from")
        .first()
    )


def shift_windows(operator, date: date_cls) -> list[tuple[int, int]]:
    """Finestre lavorabili (minuti da mezzanotte) per l'operatrice in quella data.

    week_index = numero di settimana ISO % `operator.cycle_weeks`; per ciascuna riga
    di turno del weekday corrispondente si ritaglia l'eventuale pausa (che può
    spezzare la finestra in due). Ritorna [] se la data è coperta da un'`Absence`
    o se l'operatrice non ha turno per quel weekday/week_index.
    """
    if _current_absence(operator, date) is not None:
        return []

    cycle_weeks = operator.cycle_weeks or 1
    week_index = date.isocalendar()[1] % cycle_weeks
    weekday = date.weekday()  # 0 = lunedì

    windows: list[tuple[int, int]] = []
    for shift in operator.shifts.filter(week_index=week_index, weekday=weekday):
        start, end = shift.start_min, shift.end_min
        if shift.break_start_min is not None and shift.break_end_min is not None:
            break_start = max(shift.break_start_min, start)
            break_end = min(shift.break_end_min, end)
            if break_start > start:
                windows.append((start, break_start))
            if break_end < end:
                windows.append((break_end, end))
        else:
            windows.append((start, end))
    return windows


def today_status(operator, on_date: date_cls | None = None) -> dict:
    """Stato dell'operatrice per la giornata: finestre di turno, on_shift, assenza."""
    on_date = on_date or timezone.localdate()
    absence = _current_absence(operator, on_date)
    windows = shift_windows(operator, on_date)
    return {
        "windows": windows,
        "on_shift": bool(windows),
        "absence_type": absence.type if absence else None,
    }


# ---- Import lazy da sales/agenda: degradazione a 0/[] se le app non sono pronte ----


def _sale_line_model():
    try:
        return apps.get_model("sales", "SaleLine")
    except LookupError:
        return None


def _appointment_model():
    try:
        return apps.get_model("agenda", "Appointment")
    except LookupError:
        return None


def month_revenue(operator, on_date: date_cls | None = None) -> Decimal:
    """Incasso del mese (di `on_date`, default oggi) per l'operatrice: somma SaleLine.amount."""
    SaleLine = _sale_line_model()
    if SaleLine is None:
        return Decimal("0")
    on_date = on_date or timezone.localdate()
    total = SaleLine.objects.filter(
        operator=operator,
        sale__created_at__year=on_date.year,
        sale__created_at__month=on_date.month,
    ).aggregate(total=Sum("amount"))["total"]
    return total or Decimal("0")


def today_clients_count(operator, on_date: date_cls | None = None) -> int:
    """Numero di appuntamenti di oggi per l'operatrice (esclusi annullati/no-show)."""
    Appointment = _appointment_model()
    if Appointment is None:
        return 0
    on_date = on_date or timezone.localdate()
    return (
        Appointment.objects.filter(operator=operator, start__date=on_date)
        .exclude(status__in=["cancelled", "no_show"])
        .count()
    )


def performance_series(operator, months: int = 6) -> list[dict]:
    """Serie mensile {month, revenue, sales_count} sugli ultimi `months` mesi (incluso quello corrente)."""
    months = max(1, int(months))
    today = timezone.localdate()
    month_starts: list[tuple[int, int]] = []
    y, m = today.year, today.month
    for _ in range(months):
        month_starts.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    month_starts.reverse()

    SaleLine = _sale_line_model()
    series = []
    for y, m in month_starts:
        revenue, sales_count = Decimal("0"), 0
        if SaleLine is not None:
            agg = SaleLine.objects.filter(
                operator=operator, sale__created_at__year=y, sale__created_at__month=m
            ).aggregate(revenue=Sum("amount"), sales_count=Count("sale", distinct=True))
            revenue = agg["revenue"] or Decimal("0")
            sales_count = agg["sales_count"] or 0
        series.append({"month": f"{y:04d}-{m:02d}", "revenue": revenue, "sales_count": sales_count})
    return series


def served_clients(operator, q: str = "") -> list[dict]:
    """Clienti serviti dall'operatrice (da appuntamenti passati) + storico vendite."""
    Appointment = _appointment_model()
    if Appointment is None:
        return []
    now = timezone.now()
    qs = Appointment.objects.filter(operator=operator, start__lt=now).exclude(
        status__in=["cancelled", "no_show"]
    )
    if q:
        qs = qs.filter(
            Q(client__first_name__icontains=q)
            | Q(client__last_name__icontains=q)
            | Q(client__phone__icontains=q)
        )
    rows = (
        qs.values("client_id", "client__first_name", "client__last_name", "client__phone")
        .annotate(visits=Count("id"), last_visit=Max("start"))
        .order_by("-last_visit")
    )

    SaleLine = _sale_line_model()
    result = []
    for row in rows:
        total_spent = Decimal("0")
        if SaleLine is not None:
            total_spent = (
                SaleLine.objects.filter(operator=operator, sale__client_id=row["client_id"]).aggregate(
                    total=Sum("amount")
                )["total"]
                or Decimal("0")
            )
        result.append(
            {
                "client_id": row["client_id"],
                "first_name": row["client__first_name"],
                "last_name": row["client__last_name"],
                "phone": row["client__phone"],
                "visits": row["visits"],
                "last_visit": row["last_visit"],
                "total_spent": total_spent,
            }
        )
    return result
