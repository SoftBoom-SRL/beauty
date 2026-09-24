"""KPI dell'operatrice: incasso del mese, clienti di oggi, rendimento, clienti servite.

Leggono `sales.SaleLine` e `agenda.Appointment`/`AppointmentService`, importati
in testa: i moduli dei modelli non importano altre app (solo core), quindi non
c'è ciclo. Prima si cercavano con `apps.get_model` e un ripiego a 0/[] per il
modello «non ancora disponibile», di quando le app si scrivevano in parallelo:
con tutte le app installate quel ramo non si prendeva mai. Chi può vedere gli
incassi lo decide api.py (`_sees_cash`), non queste funzioni.
"""

from datetime import date as date_cls
from decimal import Decimal

from django.db.models import Count, Max, Q, Sum
from django.db.models.functions import TruncMonth
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.sales.models import SaleLine

# Tetto ai mesi della serie di rendimento: il parametro arriva dalla query
# string di un GET senza scope richiesto, e senza limite superiore
# `?months=50000000` diventava una scansione di cinquant'anni di vendite.
MAX_PERFORMANCE_MONTHS = 36


def month_revenue(operator, on_date: date_cls | None = None) -> Decimal:
    """Incasso del mese (di `on_date`, default oggi) per l'operatrice: somma SaleLine.amount."""
    on_date = on_date or timezone.localdate()
    total = SaleLine.objects.filter(
        operator=operator,
        sale__created_at__year=on_date.year,
        sale__created_at__month=on_date.month,
    ).aggregate(total=Sum("amount"))["total"]
    return total or Decimal("0")


def month_revenue_by_operator(operators, on_date: date_cls | None = None) -> dict[int, Decimal]:
    """Incasso del mese per OGNI operatrice, in una sola query.

    La lista operatrici resta aperta tutto il giorno sul banco: chiamare
    `month_revenue` una volta per riga significava una query per operatrice a
    ogni ricarica (e altrettante per contarne le clienti di oggi).
    """
    ids = [op.pk for op in operators]
    if not ids:
        return {}
    on_date = on_date or timezone.localdate()
    rows = (
        SaleLine.objects.filter(
            operator_id__in=ids,
            sale__created_at__year=on_date.year,
            sale__created_at__month=on_date.month,
        )
        .values("operator_id")
        .annotate(total=Sum("amount"))
    )
    return {row["operator_id"]: row["total"] or Decimal("0") for row in rows}


def today_clients_by_operator(operators, on_date: date_cls | None = None) -> dict[int, int]:
    """Visite di giornata per OGNI operatrice, in due query per l'intera lista.

    Conta chi fa un servizio qualsiasi della visita, non solo l'operatrice
    principale (`Appointment.operator`, quella del PRIMO servizio): Bea che fa
    tutto il giorno i tagli dopo i colori di Anna risultava «Clienti oggi: 0»,
    mentre l'incasso di quei tagli le veniva contato (09-04). Una visita conta
    una volta per operatrice, anche se lei ne fa due servizi.
    """
    ids = [op.pk for op in operators]
    if not ids:
        return {}
    on_date = on_date or timezone.localdate()
    excluded = ["cancelled", "no_show"]
    pairs = set(
        Appointment.objects.filter(operator_id__in=ids, start__date=on_date)
        .exclude(status__in=excluded)
        .values_list("operator_id", "id")
    )
    pairs.update(
        AppointmentService.objects.filter(
            operator_id__in=ids, appointment__start__date=on_date
        )
        .exclude(appointment__status__in=excluded)
        .values_list("operator_id", "appointment_id")
    )
    counts: dict[int, int] = {}
    for operator_id, _appointment_id in pairs:
        counts[operator_id] = counts.get(operator_id, 0) + 1
    return counts


def performance_series(operator, months: int = 6) -> list[dict]:
    """Serie mensile {month, revenue, sales_count} sugli ultimi `months` mesi (incluso quello corrente).

    `months` è limitato a `MAX_PERFORMANCE_MONTHS`: prima accettava qualunque
    intero e faceva una query di aggregazione PER MESE, quindi bastava un GET
    con `?months=20000` per tenere occupato un worker. Ora i mesi si contano in
    una sola query raggruppata.
    """
    months = min(max(1, int(months)), MAX_PERFORMANCE_MONTHS)
    today = timezone.localdate()
    month_starts: list[tuple[int, int]] = []
    y, m = today.year, today.month
    for _ in range(months):
        month_starts.append((y, m))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    month_starts.reverse()

    totals: dict[str, tuple[Decimal, int]] = {}
    first_year, first_month = month_starts[0]
    rows = (
        SaleLine.objects.filter(
            operator=operator,
            sale__created_at__date__gte=date_cls(first_year, first_month, 1),
        )
        .annotate(month=TruncMonth("sale__created_at"))
        .values("month")
        .annotate(revenue=Sum("amount"), sales_count=Count("sale", distinct=True))
    )
    for row in rows:
        if row["month"] is None:
            continue
        totals[row["month"].strftime("%Y-%m")] = (
            row["revenue"] or Decimal("0"),
            row["sales_count"] or 0,
        )

    series = []
    for y, m in month_starts:
        key = f"{y:04d}-{m:02d}"
        revenue, sales_count = totals.get(key, (Decimal("0"), 0))
        series.append({"month": key, "revenue": revenue, "sales_count": sales_count})
    return series


def served_clients(operator, q: str = "") -> list[dict]:
    """Clienti serviti dall'operatrice (da appuntamenti passati) + storico vendite."""
    now = timezone.now()
    # Le visite in cui l'operatrice ha fatto almeno un servizio, non solo
    # quelle in cui è la principale: chi fa i servizi secondari perdeva le sue
    # clienti dall'elenco (09-04). Sottoquery e non join, così ogni visita
    # resta una riga sola e il conteggio delle visite non si gonfia.
    involved = Q(operator=operator) | Q(
        pk__in=AppointmentService.objects.filter(operator=operator).values("appointment_id")
    )
    qs = Appointment.objects.filter(involved, start__lt=now).exclude(
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

    rows = list(rows)

    # Speso per cliente in UNA query raggruppata: prima era un aggregate per
    # riga, quindi seicento clienti serviti volevano seicentouna query e la
    # scheda dell'operatrice diventava inservibile proprio per chi lavora di più.
    spent_by_client: dict[int, Decimal] = {}
    if rows:
        spent_by_client = {
            item["sale__client_id"]: item["total"] or Decimal("0")
            for item in SaleLine.objects.filter(
                operator=operator, sale__client_id__in=[r["client_id"] for r in rows]
            )
            .values("sale__client_id")
            .annotate(total=Sum("amount"))
        }

    result = []
    for row in rows:
        total_spent = spent_by_client.get(row["client_id"], Decimal("0"))
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
