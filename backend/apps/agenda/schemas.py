import datetime as dt
from decimal import Decimal
from typing import Optional

from ninja import Schema


# ---- Input -----------------------------------------------------------------


class ItemIn(Schema):
    service_id: int
    operator_id: Optional[int] = None  # None = qualsiasi operatrice idonea


class ItemEditIn(Schema):
    id: Optional[int] = None            # existing AppointmentService id (None = new item)
    service_id: int
    operator_id: Optional[int] = None   # None = first eligible free operator
    duration_min: Optional[int] = None  # None = use the service's catalog duration


class AppointmentCreateIn(Schema):
    client_id: int
    items: list[ItemIn]
    start: dt.datetime
    flexible: bool = False
    note: str = ""
    location_id: Optional[int] = None


class ClientAppointmentCreateIn(Schema):
    items: list[ItemIn]
    start: dt.datetime


class MoveIn(Schema):
    start: dt.datetime
    operator_id: Optional[int] = None


class ClientMoveIn(Schema):
    start: dt.datetime


class ReasonIn(Schema):
    reason: str = ""


class AppointmentUpdateIn(Schema):
    items: Optional[list[ItemEditIn]] = None
    note: Optional[str] = None


class PauseIn(Schema):
    operator_id: int
    start: dt.datetime
    duration_min: int
    note: str = ""


class WaitlistIn(Schema):
    service_id: int
    operator_id: Optional[int] = None
    preference: str = "any"
    exact_days: list[int] = []
    exact_time: Optional[dt.time] = None


# ---- Output ----------------------------------------------------------------


class ClientMiniOut(Schema):
    id: int
    full_name: str
    phone: str


class ItemOut(Schema):
    id: int
    service_id: int
    service_name: str
    operator_id: int
    operator_name: str
    duration_min: int
    price: Decimal
    order: int


class AppointmentOut(Schema):
    id: int
    client: ClientMiniOut
    operator_id: int
    location_id: Optional[int] = None
    start: dt.datetime
    end: dt.datetime
    status: str
    deposit_status: str
    deposit_amount: Decimal
    total_duration_min: int
    total_price: Decimal
    note: str
    flexible: bool
    created_via: str
    cancel_reason: str
    cancelled_late: bool
    items: list[ItemOut]


class AssignmentOut(Schema):
    service_id: int
    operator_id: int


class SlotOut(Schema):
    start: str  # ISO 8601
    assignment: list[AssignmentOut]


class PauseOut(Schema):
    id: int
    operator_id: int
    operator_name: str
    start: dt.datetime
    duration_min: int
    note: str


class WaitlistOut(Schema):
    id: int
    client_id: int
    client_name: str
    service_id: int
    service_name: str
    operator_id: Optional[int] = None
    operator_name: Optional[str] = None
    preference: str
    exact_days: list[int]
    exact_time: Optional[dt.time] = None
    status: str
    created_at: dt.datetime


class MarginOut(Schema):
    revenue: Decimal
    supplier_cost: Decimal
    product_cost: Decimal
    labor_cost: Decimal
    margin: Decimal
    margin_pct: Decimal


class OkOut(Schema):
    ok: bool = True
