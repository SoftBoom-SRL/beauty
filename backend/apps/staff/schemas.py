from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema


class OkOut(Schema):
    ok: bool = True


# ---- Operatrici ----------------------------------------------------------------


class OperatorIn(Schema):
    first_name: str
    last_name: str
    color: str = "#A5B4FC"
    role_title: str = ""
    location_id: Optional[int] = None
    user_id: Optional[int] = None
    service_ids: list[int] = []
    hourly_cost: Decimal = Decimal("0")
    cycle_weeks: int = 1
    active: bool = True
    order: int = 0


class OperatorOut(Schema):
    id: int
    first_name: str
    last_name: str
    initials: str
    color: str
    role_title: str
    location_id: Optional[int] = None
    user_id: Optional[int] = None
    service_ids: list[int] = []
    hourly_cost: Decimal
    cycle_weeks: int
    active: bool
    order: int


class OperatorStatusOut(OperatorOut):
    """Riga della lista operatrici: anagrafica + stato di oggi + KPI rapide."""

    on_shift: bool
    windows: list[tuple[str, str]]
    absence_type: Optional[str] = None
    month_revenue: Decimal
    today_clients: int


class WeeklyShiftOut(Schema):
    id: int
    week_index: int
    weekday: int
    start_min: int
    end_min: int
    break_start_min: Optional[int] = None
    break_end_min: Optional[int] = None


class OperatorDetailOut(OperatorOut):
    """Dettaglio operatrice: anagrafica + pattern di turno corrente."""

    shifts: list[WeeklyShiftOut]


# ---- Turni -----------------------------------------------------------------


class WeeklyShiftIn(Schema):
    week_index: int = 0
    weekday: int
    start_min: int
    end_min: int
    break_start_min: Optional[int] = None
    break_end_min: Optional[int] = None


class ShiftsReplaceIn(Schema):
    shifts: list[WeeklyShiftIn]


# ---- Assenze -----------------------------------------------------------------


class AbsenceIn(Schema):
    date_from: date
    date_to: date
    type: str
    note: str = ""


class AbsenceOut(AbsenceIn):
    id: int


# ---- Performance e clienti serviti ---------------------------------------------


class PerformanceOut(Schema):
    month: str  # "YYYY-MM"
    revenue: Decimal
    sales_count: int


class ServedClientOut(Schema):
    client_id: int
    first_name: str
    last_name: str
    phone: str
    visits: int
    last_visit: Optional[datetime] = None
    total_spent: Decimal
