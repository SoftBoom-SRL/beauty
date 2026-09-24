"""KPI e analisi per il titolare del salone.

apps.insights non ha modelli propri: aggrega dati di agenda, sales, clients,
catalog e staff. Ogni funzione qui dentro DEVE degradare a 0 (o lista vuota)
quando i dati mancano — mai sollevare eccezioni per un dataset vuoto.

Import cross-app: i modelli sono importati a livello di modulo (a runtime le
altre app esisteranno, vedi SPEC.md §0). `staff.services.shift_windows` viene
invece importato dentro la funzione che lo usa, a ogni chiamata: così chi lo
sostituisce in apps.staff.services (i test dell'agenda lo fanno) lo sostituisce
anche qui. Un ciclo di import da evitare non c'è più.
"""

from datetime import date as date_cls
from datetime import datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Count, DateField, OuterRef, Q, Subquery, Sum
from django.db.models.functions import TruncDate, TruncMonth, TruncWeek
from django.utils import timezone
from ninja.errors import HttpError

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import ServiceCategory
from apps.clients.models import Client, ClientCategory
from apps.sales.models import DepositRefund, Payment, Sale, SaleLine
from apps.staff.models import Operator
from common.money import CENT

PERIODS = {"month", "quarter", "year"}
GRANULARITIES = {"day", "week", "month"}

# Giorni massimi di un intervallo personalizzato: due anni abbondanti, cioè
# molto più del confronto anno su anno che il titolare guarda davvero.
MAX_RANGE_DAYS = 732

# Date accettate come periodo. Fuori da qui l'anno 1 andava in overflow nella
# conversione in UTC e il 9999 in `date(anno + 1, …)`: la richiesta finiva in un
# 500 invece di dire che la data non ha senso.
MIN_DATE = date_cls(1900, 1, 1)
MAX_DATE = date_cls(2999, 12, 31)

ZERO = Decimal("0.00")

# Stati "prenotati" ai fini dell'occupazione e stati terminali usati dai KPI.
# Check-in e trattamento in corso occupano la poltrona esattamente come un
# confermato: escluderli faceva scendere l'occupazione al momento dell'arrivo.
_OCCUPIED_STATUSES = (
    Appointment.Status.CONFIRMED,
    Appointment.Status.CHECKED_IN,
    Appointment.Status.IN_PROGRESS,
    Appointment.Status.CLOSED,
)
_CLOSED = Appointment.Status.CLOSED
_NO_SHOW = Appointment.Status.NO_SHOW
_CANCELLED = Appointment.Status.CANCELLED


# ---------------------------------------------------------------------------
# Periodi
# ---------------------------------------------------------------------------


def _check_date(d: date_cls | None) -> None:
    if d is not None and not MIN_DATE <= d <= MAX_DATE:
        raise HttpError(
            400, f"Data fuori scala: usa una data fra il {MIN_DATE.year} e il {MAX_DATE.year}"
        )


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
    _check_date(date)
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
    _check_date(date_from)
    _check_date(date_to)
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
    return (Decimal(total) / count).quantize(CENT, rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------------------
# Occupazione (turni da staff.shift_windows)
# ---------------------------------------------------------------------------


def _operator_shift_minutes(operator, d: date_cls) -> int:
    from apps.staff.services import shift_windows  # lazy: si risolve a ogni chiamata (vedi in testa)

    windows = shift_windows(operator, d) or []
    return sum(max(0, end - start) for start, end in windows)


def _daily_shift_minutes(
    salon, days: list[date_cls], extra_operator_ids=()
) -> dict[date_cls, int]:
    """Minuti di turno del salone per ciascun giorno.

    `extra_operator_ids` aggiunge operatrici non più attive che nel periodo
    hanno però lavorato: la capacità e i minuti prenotati devono riguardare le
    stesse persone. Contando solo le attive, disattivare un'operatrice
    riscriveva l'occupazione di giornate già chiuse — i suoi appuntamenti
    restavano al numeratore e il suo turno usciva dal denominatore, e il mese
    scorso passava da 33 % a 67 % da solo.
    """
    if not days:
        return {}
    # Turni, assenze e impostazioni del salone caricati una volta sola: senza
    # prefetch ogni giorno di ogni operatrice tornava a interrogare il database,
    # e una sola operatrice su trenta giorni costava 63 query.
    operators = list(
        Operator.objects.filter(salon=salon)
        .filter(Q(active=True) | Q(id__in=set(extra_operator_ids or ())))
        .select_related("salon__settings")
        .prefetch_related("shifts", "absences")
    )
    if not operators:
        return {d: 0 for d in days}
    return {d: sum(_operator_shift_minutes(op, d) for op in operators) for d in days}


def _worked_operator_ids(salon, start: datetime, end: datetime, statuses) -> set[int]:
    """Operatrici con almeno un servizio nel periodo (attive o no)."""
    return set(
        AppointmentService.objects.filter(
            appointment__salon=salon,
            appointment__status__in=statuses,
            appointment__start__gte=start,
            appointment__start__lt=end,
        )
        .values_list("operator_id", flat=True)
        .distinct()
    )


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
    shift_by_day = _daily_shift_minutes(
        salon, days, _worked_operator_ids(salon, start, end, _OCCUPIED_STATUSES)
    )
    result = []
    for weekday in range(7):
        weekday_days = [d for d in days if d.weekday() == weekday]
        capacity = sum(shift_by_day.get(d, 0) for d in weekday_days)
        result.append(
            {
                "weekday": weekday,
                # Giorno senza capacità (chiuso, nessun turno): nessun dato, non
                # uno 0 % indistinguibile da «aperto e vuoto» — il grafico lo
                # coloriva di rosso e lo proponeva come il giorno più scarico.
                "occupancy_pct": (
                    _occupancy_for_days(booked_by_day, shift_by_day, weekday_days)
                    if capacity
                    else None
                ),
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


# Un «cliente dal» che precede di più di tanto la prima visita registrata è la
# data di una cliente storica (scheda importata con la sua data, o scritta a
# mano): la sua prima visita in youty non è la prima al salone. Una data vicina
# alla prima visita è invece l'iscrizione (app, form, reception), che precede di
# qualche giorno la prima prenotazione.
HISTORIC_SINCE_DAYS = 90


def _new_client_ids(salon, start: datetime, end: datetime) -> set:
    """Clienti acquisite nel periodo [start, end): la PRIMA visita (non annullata
    né no-show) o il primo acquisto della cliente cade nel periodo.

    Prima bastava `Client.since` nel periodo, senza guardare l'attività: l'import
    CSV e il primo sync Yourang lo impostano al giorno dell'operazione, quindi
    nel mese dell'avvio l'intera rubrica risultava «nuova» e la cliente storica
    tornata quel giorno non era «di ritorno». Ora conta il primo contatto reale;
    `since` può solo dire che una cliente è più vecchia (vedi
    HISTORIC_SINCE_DAYS), mai renderla nuova da sola.
    """
    visits = Appointment.objects.filter(status__in=_OCCUPIED_STATUSES)
    # Le vendite-caparra no: sono l'anticipo di una visita, che conta da sé.
    sales = Sale.objects.filter(deposit_appointment__isnull=True, client__isnull=False)
    # Chi è stata acquisita nel periodo ha per forza una visita o uno scontrino
    # NEL periodo: si parte da quelle e si guarda indietro. Così il conto non
    # scorre l'anagrafica intera a ogni apertura della dashboard.
    seen_in_period = set(
        visits.filter(salon=salon, start__gte=start, start__lt=end).values_list(
            "client_id", flat=True
        )
    )
    seen_in_period.update(
        sales.filter(salon=salon, created_at__gte=start, created_at__lt=end).values_list(
            "client_id", flat=True
        )
    )
    if not seen_in_period:
        return set()
    rows = (
        Client.objects.filter(salon=salon, id__in=seen_in_period)
        .annotate(
            # Sottoquery e non Min() sulle due relazioni: il doppio JOIN
            # moltiplicava visite per scontrini di ogni cliente.
            first_visit=Subquery(
                visits.filter(client=OuterRef("pk")).order_by("start").values("start")[:1]
            ),
            first_sale=Subquery(
                sales.filter(client=OuterRef("pk")).order_by("created_at").values("created_at")[:1]
            ),
        )
        .values_list("id", "since", "first_visit", "first_sale")
    )
    ids = set()
    for client_id, since, first_visit, first_sale in rows:
        seen = [d for d in (first_visit, first_sale) if d is not None]
        if not seen:
            continue
        first = min(seen)
        if not start <= first < end:
            continue
        if since and since < timezone.localdate(first) - timedelta(days=HISTORIC_SINCE_DAYS):
            continue
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
    # Al netto delle caparre restituite nel periodo (annullamento in tempo,
    # eccedenza al conto, restituzione a mano): prima una caparra rimborsata
    # restava per sempre in `deposit_cashed` e in `cash_in` (08-17). Il
    # rimborso conta nel periodo in cui avviene, come l'incasso.
    deposit_refunded = (
        DepositRefund.objects.filter(salon=salon, created_at__gte=start, created_at__lt=end).aggregate(
            total=Sum("amount")
        )["total"]
        or ZERO
    )
    deposit_cashed = (
        sales_qs.filter(deposit_appointment__isnull=False).aggregate(total=Sum("total"))["total"]
        or ZERO
    ) - deposit_refunded
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
    closed_qs = appts_qs.filter(status=_CLOSED)
    appointments_count = closed_qs.count()
    # Per il periodo in corso il riferimento è adesso, per quelli passati la fine.
    reference = min(end, timezone.now())
    # No-show e annullamenti sugli appuntamenti già passati: un confermato di
    # domani non può ancora essere un no-show, e contandolo al denominatore il
    # periodo in corso risultava sempre migliore del precedente (5 no-show su
    # 10 visite passate davano 25 % con dieci prenotazioni future).
    elapsed_qs = appts_qs.filter(start__lt=reference)
    elapsed_appointments = elapsed_qs.count()
    noshow_count = elapsed_qs.filter(status=_NO_SHOW).count()
    cancel_count = elapsed_qs.filter(status=_CANCELLED).count()
    noshow_rate = _safe_div(noshow_count, elapsed_appointments)
    cancel_rate = _safe_div(cancel_count, elapsed_appointments)

    booked_by_day = _daily_booked_minutes(salon, start, end, _OCCUPIED_STATUSES)
    shift_by_day = _daily_shift_minutes(
        salon, days, _worked_operator_ids(salon, start, end, _OCCUPIED_STATUSES)
    )
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
    # comportamento. Conta chi al riferimento (adesso, o la fine di un periodo
    # passato) aveva già in agenda una visita successiva: la visita chiusa di
    # stamattina non è futura, ma quella del 10/9 di chi era passata ad agosto
    # sì, anche se nel frattempo è stata fatta e chiusa — escludere le chiuse
    # azzerava il riaggancio di ogni periodo passato. Le prenotazioni fatte dopo
    # il riferimento non contano, come non possono contare per il periodo in
    # corso.
    future_client_ids: set = set()
    if closed_client_ids:
        future_client_ids = set(
            Appointment.objects.filter(
                salon=salon,
                client_id__in=closed_client_ids,
                start__gte=reference,
                created_at__lt=reference,
            )
            .exclude(status__in=[_CANCELLED, _NO_SHOW])
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
