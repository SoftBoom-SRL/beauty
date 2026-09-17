import datetime as dt
from decimal import Decimal
from typing import Optional

from ninja import Field, Schema


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
    # Solo staff: inserisce anche fuori turno/orario o sopra un'altra prenotazione
    # (straordinario, "ci incastriamo"). L'appuntamento resta marcato `forced`.
    force: bool = False


class ClientAppointmentCreateIn(Schema):
    items: list[ItemIn]
    start: dt.datetime


class MoveIn(Schema):
    start: dt.datetime
    operator_id: Optional[int] = None
    force: bool = False


class SplitIn(Schema):
    """Stacca un servizio da un appuntamento multi-servizio e lo sposta altrove."""

    item_id: int
    start: dt.datetime
    operator_id: Optional[int] = None
    force: bool = False


class RestoreIn(Schema):
    force: bool = False


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
    # Una pausa di zero minuti (o negativa) arrivava fino al database e poi
    # occupava un intervallo vuoto che nessuna vista sapeva disegnare.
    duration_min: int = Field(..., ge=5, le=12 * 60)
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
    soak_min: int = 0
    price: Decimal
    order: int


class GiftOut(Schema):
    """Gift card «a trattamento» attiva e pagata che copre un servizio dell'appuntamento."""

    gift_card_id: int
    code: str
    service_id: int
    service_name: str
    balance: Decimal
    from_name: str = ""


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
    # Quanto è già tornato alla cliente e quanto resta detraibile al checkout:
    # con un rimborso parziale i due numeri non coincidono con deposit_amount.
    deposit_refunded_amount: Decimal = Decimal("0.00")
    deposit_credit: Decimal = Decimal("0.00")
    deposit_due_at: Optional[dt.datetime] = None
    deposit_payment_link: str = ""
    total_duration_min: int
    total_price: Decimal
    note: str
    flexible: bool
    created_via: str
    cancel_reason: str
    cancelled_late: bool
    auto_released: bool = False
    forced: bool = False
    items: list[ItemOut]
    gifts: list[GiftOut] = []


class SplitOut(Schema):
    original: AppointmentOut
    created: AppointmentOut


class AssignmentOut(Schema):
    service_id: int
    operator_id: int


class SlotOut(Schema):
    start: str  # ISO 8601
    assignment: list[AssignmentOut]
    # Vero se l'orario non lascia buchi invendibili prima/dopo (adiacente a una
    # prenotazione o a un bordo del turno, oppure lascia spazio per un altro
    # servizio). La disponibilità cliente in modalità ottimizzata mostra solo questi.
    recommended: bool = True


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
