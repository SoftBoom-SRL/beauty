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

from django.db.models import Count, DateField, Min, Q, Sum
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

# Giorni massimi di un intervallo personalizzato: due anni abbondanti, cioè
# molto più del confronto anno su anno che il titolare guarda davvero.
MAX_RANGE_DAYS = 732

ZERO = Decimal("0.00")

# Stati "prenotati" ai fini dell'occupazione e stati terminali usati dai KPI.
# Check-in e trattamento in corso occupano la poltrona esattamente come un
# confermato: escluderli faceva scendere l'occupazione al momento dell'arrivo.
_OCCUPIED_STATUSES = ("confirmed", "checked_in", "in_progress", "closed")
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


def custom_range(date_from: date_cls, date_to: date_cls) -> tuple[datetime, datetime]:
    """Intervallo esplicito [start, end) da due date INCLUSE (end = date_to + 1 giorno)."""
    if date_from > date_to:
        raise HttpError(400, "Intervallo non valido: la data iniziale è successiva a quella finale")
    # Tetto all'ampiezza: il selettore di date non ha un anno minimo, e un
    # "0202-01-01" produceva 666.000 giorni da scorrere uno per uno (turni,
    # bucket, occupazione) tenendo occupato un thread del server per minuti.
    if (date_to - date_from).days + 1 > MAX_RANGE_DAYS:
        raise HttpError(
            400, f"Intervallo troppo ampio: al massimo {MAX_RANGE_DAYS} giorni (circa due anni)"
        )
    tz = timezone.get_current_timezone()
    start = timezone.make_aware(datetime.combine(date_from, time.min), tz)
    end = timezone.make_aware(datetime.combine(date_to + timedelta(days=1), time.min), tz)
    return start, end


def resolve_range(period, date, date_from, date_to) -> tuple[datetime, datetime]:
    """Range personalizzato se `date_from` e `date_to` sono entrambi forniti,
    altrimenti il periodo standard month/quarter/year."""
    if date_from and date_to:
        return custom_range(date_from, date_to)
    return period_range(period, date)


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
    # Turni, assenze e impostazioni del salone caricati una volta sola: senza
    # prefetch ogni giorno di ogni operatrice tornava a interrogare il database,
    # e una sola operatrice su trenta giorni costava 63 query.
    operators = list(
        Operator.objects.filter(salon=salon, active=True)
        .select_related("salon__settings")
        .prefetch_related("shifts", "absences")
    )
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


def occupancy_by_weekday(salon, period: str, date: date_cls | None = None, date_from: date_cls | None = None, date_to: date_cls | None = None) -> list[dict]:
    start, end = resolve_range(period, date, date_from, date_to)
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
    salon, period: str, granularity: str = "day", date: date_cls | None = None,
    date_from: date_cls | None = None, date_to: date_cls | None = None,
) -> list[dict]:
    if granularity not in GRANULARITIES:
        raise HttpError(400, "Granularità non valida: usa day, week o month")
    start, end = resolve_range(period, date, date_from, date_to)
    trunc = _TRUNC[granularity]
    rows = (
        # Stessa base dei KPI: senza le vendite-caparra, che al checkout
        # verrebbero contate una seconda volta dentro il conto pieno.
        Sale.objects.filter(
            salon=salon,
            created_at__gte=start,
            created_at__lt=end,
            deposit_appointment__isnull=True,
        )
        .annotate(bucket=trunc("created_at", output_field=DateField()))
        .values("bucket")
        .annotate(revenue=Sum("total"))
    )
    by_bucket = {row["bucket"]: row["revenue"] or ZERO for row in rows}
    buckets = _buckets(_dates_in_range(start, end), granularity)
    return [{"date": b, "revenue": by_bucket.get(b, ZERO)} for b in buckets]


def revenue_by_category(salon, period: str, date: date_cls | None = None, date_from: date_cls | None = None, date_to: date_cls | None = None) -> list[dict]:
    """Ricavi per categoria servizio nel periodo; le righe prodotto confluiscono in "Prodotti"."""
    start, end = resolve_range(period, date, date_from, date_to)
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
# Clienti acquisite nel periodo
# ---------------------------------------------------------------------------


def _new_client_ids(salon, start: datetime, end: datetime) -> set:
    """Clienti acquisite nel periodo [start, end).

    `Client.since` è la data di acquisizione dichiarata, ma resta vuota su tutte
    le schede storiche (e finché ogni via di creazione non la valorizza): a
    contare solo quella, "Nuovi clienti" era strutturalmente 0 e il grafico
    "Nuovi vs di ritorno" mostrava sempre 0% / 100%. Per le schede senza `since`
    l'acquisizione si ricava dal primo contatto reale con il salone: la prima
    visita in agenda o il primo scontrino.
    """
    ids = set(
        Client.objects.filter(
            salon=salon, since__gte=start.date(), since__lt=end.date()
        ).values_list("id", flat=True)
    )
    # Chi è stata acquisita nel periodo ha per forza una visita o uno scontrino
    # NEL periodo: si parte da quelle e si guarda indietro. Così il conto non
    # scorre l'anagrafica intera a ogni apertura della dashboard.
    seen_in_period = set(
        Appointment.objects.filter(salon=salon, start__gte=start, start__lt=end).values_list(
            "client_id", flat=True
        )
    )
    seen_in_period.update(
        cid
        for cid in Sale.objects.filter(
            salon=salon, created_at__gte=start, created_at__lt=end
        ).values_list("client_id", flat=True)
        if cid
    )
    legacy = (
        Client.objects.filter(salon=salon, since__isnull=True, id__in=seen_in_period)
        .annotate(first_visit=Min("appointments__start"), first_sale=Min("sales__created_at"))
        .values_list("id", "first_visit", "first_sale")
    )
    for client_id, first_visit, first_sale in legacy:
        seen = [d for d in (first_visit, first_sale) if d is not None]
        if seen and start <= min(seen) < end:
            ids.add(client_id)
    return ids


# ---------------------------------------------------------------------------
# KPI principali
# ---------------------------------------------------------------------------


def kpis(salon, period: str, date: date_cls | None = None, date_from: date_cls | None = None, date_to: date_cls | None = None) -> dict:
    start, end = resolve_range(period, date, date_from, date_to)
    days = _dates_in_range(start, end)

    # --- vendite -------------------------------------------------------
    sales_qs = Sale.objects.filter(salon=salon, created_at__gte=start, created_at__lt=end)
    # La caparra è un anticipo, non un conto: entra in cassa il giorno in cui
    # arriva con una vendita sua (`record_deposit_cashed`), e al checkout il
    # servizio viene fatturato PER INTERO con l'anticipo detratto da quanto
    # resta da pagare. Sommandole entrambe, un servizio da 100 con 30 di caparra
    # risultava un fatturato di 130 e due scontrini invece di uno. Il fatturato
    # è quindi il venduto (senza le caparre); la caparra torna in `cash_in`, che
    # è il denaro davvero entrato nel periodo.
    billed_qs = sales_qs.filter(deposit_appointment__isnull=True)
    revenue = billed_qs.aggregate(total=Sum("total"))["total"] or ZERO
    deposit_cashed = (
        sales_qs.filter(deposit_appointment__isnull=False).aggregate(total=Sum("total"))["total"]
        or ZERO
    )
    sales_count = billed_qs.count()
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
    # Gift card: vendute (già nel ricavo) e riscattate (pagamenti con gift card,
    # denaro incassato quando la carta fu venduta). cash_in = ricavo − riscatti,
    # così un trattamento regalato non conta due volte.
    gift_card_sold = (
        SaleLine.objects.filter(
            sale__salon=salon, sale__created_at__gte=start, sale__created_at__lt=end, line_type="gift_card"
        ).aggregate(total=Sum("amount"))["total"]
        or ZERO
    )
    from apps.sales.models import Payment  # lazy: evita import inutili a modulo

    gift_card_redeemed = (
        Payment.objects.filter(
            sale__salon=salon, sale__created_at__gte=start, sale__created_at__lt=end, method="gift_card"
        ).aggregate(total=Sum("amount"))["total"]
        or ZERO
    )
    # Caparre versate prima e detratte al checkout: denaro incassato in un altro
    # periodo, da non sommare di nuovo qui.
    deposit_used = billed_qs.aggregate(total=Sum("deposit_deducted"))["total"] or ZERO

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

    # Il riaggancio si misura dal PERIODO, non da oggi: con "oggi" un mese
    # passato veniva confrontato con la rubrica di adesso e la freccia di
    # variazione mostrava sempre un miglioramento inventato a parità di
    # comportamento. Per il periodo in corso il riferimento è adesso, così una
    # visita già chiusa stamattina non conta come appuntamento futuro.
    reference = min(end, timezone.now())
    future_client_ids: set = set()
    if closed_client_ids:
        future_client_ids = set(
            Appointment.objects.filter(
                salon=salon, client_id__in=closed_client_ids, start__gte=reference
            )
            .exclude(status__in=[_CANCELLED, _NO_SHOW, _CLOSED])
            .values_list("client_id", flat=True)
        )
    rebooking_rate = _safe_div(len(future_client_ids), clients_1plus)

    new_client_ids = _new_client_ids(salon, start, end)
    new_clients = len(new_client_ids)
    returning_clients = len(closed_client_ids - new_client_ids)

    avg_frequency = _safe_div(appointments_count, clients_1plus)

    # Le clienti del periodo: chi ha chiuso una visita e chi ha comprato al
    # banco. Prima era una COUNT per categoria sull'anagrafica intera, quindi la
    # torta "Clienti per categoria" restava identica qualunque periodo si
    # scegliesse, accanto a KPI che invece cambiavano.
    period_client_ids = closed_client_ids | {
        cid for cid in sales_qs.values_list("client_id", flat=True) if cid
    }
    clients_by_category = [
        {"category": row.name, "count": row.period_clients}
        for row in ClientCategory.objects.filter(salon=salon)
        .annotate(
            period_clients=Count(
                "clients", filter=Q(clients__id__in=period_client_ids), distinct=True
            )
        )
        .order_by("order", "id")
    ]

    return {
        "revenue": revenue,
        "gift_card_sold": gift_card_sold,
        "gift_card_redeemed": gift_card_redeemed,
        "deposit_used": deposit_used,
        "deposit_cashed": deposit_cashed,
        "cash_in": revenue + deposit_cashed - gift_card_redeemed - deposit_used,
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
