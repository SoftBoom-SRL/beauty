"""Endpoint KPI e analisi: al titolare e a chi ha il permesso «Analisi dati».

Lo scope `insights` si poteva assegnare dall'editor dei ruoli ma nessun
endpoint lo leggeva (require_owner ovunque): la Manager a cui la titolare dava
«Analisi dati» trovava «Funzione riservata al titolare».
"""

from django.utils.dateparse import parse_date
from ninja import Router
from ninja.errors import HttpError

from common.auth import staff_auth
from common.permissions import require_scope

from .schemas import AskIn, CategoryRevenueOut, KpisOut, RevenuePointOut, WeekdayOccupancyOut
from .services import kpis, occupancy_by_weekday, revenue_by_category, revenue_series

router = Router(tags=["insights"])


def _parse_date(raw: str | None):
    if not raw:
        return None
    try:
        # Una data ben scritta ma inesistente («2026-02-30») fa sollevare
        # ValueError a parse_date: era un 500.
        parsed = parse_date(raw)
    except ValueError:
        parsed = None
    if parsed is None:
        raise HttpError(400, "Data non valida: usa il formato YYYY-MM-DD")
    return parsed


def _period_dates(date, date_from, date_to):
    """Le tre date facoltative di ogni endpoint (giorno del periodo, inizio e fine
    dell'intervallo), lette in quest'ordine: la prima non valida risponde 400."""
    return _parse_date(date), _parse_date(date_from), _parse_date(date_to)


@router.get("/kpis", auth=staff_auth, response=KpisOut)
def get_kpis(request, period: str = "month", date: str | None = None, date_from: str | None = None, date_to: str | None = None):
    ctx = request.auth
    require_scope(ctx, "insights")
    return kpis(ctx.salon, period, *_period_dates(date, date_from, date_to))


@router.get("/revenue-series", auth=staff_auth, response=list[RevenuePointOut])
def get_revenue_series(
    request, period: str = "month", granularity: str = "day", date: str | None = None,
    date_from: str | None = None, date_to: str | None = None,
):
    ctx = request.auth
    require_scope(ctx, "insights")
    return revenue_series(ctx.salon, period, granularity, *_period_dates(date, date_from, date_to))


@router.get("/revenue-by-category", auth=staff_auth, response=list[CategoryRevenueOut])
def get_revenue_by_category(request, period: str = "month", date: str | None = None, date_from: str | None = None, date_to: str | None = None):
    ctx = request.auth
    require_scope(ctx, "insights")
    return revenue_by_category(ctx.salon, period, *_period_dates(date, date_from, date_to))


@router.get("/occupancy-by-weekday", auth=staff_auth, response=list[WeekdayOccupancyOut])
def get_occupancy_by_weekday(request, period: str = "month", date: str | None = None, date_from: str | None = None, date_to: str | None = None):
    ctx = request.auth
    require_scope(ctx, "insights")
    return occupancy_by_weekday(ctx.salon, period, *_period_dates(date, date_from, date_to))


@router.post("/ask", auth=staff_auth)
def ask_youty(request, data: AskIn):
    require_scope(request.auth, "insights")
    raise HttpError(501, "Chiedi a Youty sarà disponibile nella fase 2")
