from datetime import datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema

# ---- Input -------------------------------------------------------------------


class SaleLineIn(Schema):
    line_type: str  # service | product | gift_card
    service_id: Optional[int] = None
    product_id: Optional[int] = None
    qty: int = 1
    unit_price: Optional[Decimal] = None
    discount_pct: int = 0
    is_gift: bool = False
    # vendita gift card (POS): valore della card + destinatario opzionale
    value: Optional[Decimal] = None
    recipient_name: str = ""


class BlockIn(Schema):
    operator_id: Optional[int] = None
    lines: list[SaleLineIn]


class PaymentIn(Schema):
    method: str  # cash | card | other | gift_card
    amount: Decimal
    gift_card_code: str = ""


class CheckoutIn(Schema):
    blocks: list[BlockIn]
    payments: list[PaymentIn]


class PosIn(CheckoutIn):
    client_id: Optional[int] = None


# ---- Output ------------------------------------------------------------------


class SaleLineOut(Schema):
    id: int
    line_type: str
    operator_id: Optional[int] = None
    operator_name: str = ""
    service_id: Optional[int] = None
    product_id: Optional[int] = None
    product_name: str = ""
    gift_card_code: Optional[str] = None
    qty: int
    unit_price: Decimal
    discount_pct: int
    is_gift: bool
    amount: Decimal


class PaymentOut(Schema):
    id: int
    method: str
    amount: Decimal
    gift_card_code: Optional[str] = None


class SaleOut(Schema):
    id: int
    kind: str
    appointment_id: Optional[int] = None
    client_id: Optional[int] = None
    client_name: str = ""
    location_id: Optional[int] = None
    total: Decimal
    deposit_deducted: Decimal
    created_at: datetime


class SaleDetailOut(SaleOut):
    lines: list[SaleLineOut]
    payments: list[PaymentOut]


class OperatorBreakdownOut(Schema):
    operator_id: Optional[int] = None
    operator_name: str
    amount: Decimal


class CheckoutOut(Schema):
    sale: SaleDetailOut
    breakdown: list[OperatorBreakdownOut]


class SalesKpiOut(Schema):
    revenue: Decimal
    count: int
    items_count: int


class SaleListOut(Schema):
    count: int
    kpi: SalesKpiOut
    items: list[SaleOut]


class TodaySummaryOut(Schema):
    total: Decimal
    count: int
    checkout_total: Decimal
    pos_total: Decimal


class ChargeNoShowOut(Schema):
    ok: bool = True
    payment_intent_id: str
    amount: Decimal


class SetupIntentOut(Schema):
    setup_intent_id: str
    client_secret: Optional[str] = None


class OkOut(Schema):
    ok: bool = True
