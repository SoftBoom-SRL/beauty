from datetime import datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema


class OkOut(Schema):
    ok: bool = True


# ---- Fornitori ---------------------------------------------------------------


class SupplierIn(Schema):
    name: str
    email: str = ""
    phone: str = ""
    order_method: str = "email"
    address: str = ""
    vat_number: str = ""
    sdi_pec: str = ""
    notes: str = ""


class SupplierOut(Schema):
    id: int
    name: str
    email: str
    phone: str
    order_method: str
    address: str
    vat_number: str
    sdi_pec: str
    notes: str


# ---- Categorie ---------------------------------------------------------------


class CategoryIn(Schema):
    name: str
    order: int = 0
    color: Optional[str] = None


class CategoryOut(Schema):
    id: int
    name: str
    order: int
    color: str


# ---- Prodotti ----------------------------------------------------------------


class ProductIn(Schema):
    name: str
    sku: str = ""
    brand: str = ""
    category_id: Optional[int] = None
    usage: str = "retail"
    package_unit: str = ""
    package_qty: Decimal = Decimal("1")
    supplier_id: int
    purchase_price: Decimal = Decimal("0")
    purchase_discount_pct: int = 0
    sale_price: Decimal = Decimal("0")
    vat_rate: int = 22
    min_threshold: Decimal = Decimal("0")
    reorder_qty: Decimal = Decimal("0")
    active: bool = True


class ProductOut(Schema):
    id: int
    name: str
    sku: str
    brand: str
    category_id: Optional[int] = None
    category_name: Optional[str] = None
    usage: str
    package_unit: str
    package_qty: Decimal
    supplier_id: int
    supplier_name: str
    purchase_price: Decimal
    purchase_discount_pct: int
    sale_price: Decimal
    vat_rate: int
    stock_qty: Decimal
    min_threshold: Decimal
    reorder_qty: Decimal
    stock_state: str
    active: bool

    @staticmethod
    def resolve_category_name(obj):
        return obj.category.name if obj.category_id else None

    @staticmethod
    def resolve_supplier_name(obj):
        return obj.supplier.name


class ProductLoadIn(Schema):
    """Body form-data del carico (l'eventuale fattura viaggia come file)."""

    qty: Decimal
    reason: str = ""


class ProductUnloadIn(Schema):
    qty: Decimal
    kind: str  # internal_use / adjustment / transfer
    reason: str = ""
    operator_id: Optional[int] = None


class CsvRowIn(Schema):
    name: str = ""
    sku: str = ""
    qty: Decimal
    supplier_id: Optional[int] = None


class LoadCsvIn(Schema):
    rows: list[CsvRowIn]
    supplier_id: Optional[int] = None


class CsvRowResultOut(Schema):
    row: int
    product_id: Optional[int] = None
    name: str = ""
    status: str  # loaded / created / error
    error: str = ""


class LoadCsvOut(Schema):
    results: list[CsvRowResultOut]
    loaded: int
    created: int
    errors: int


# ---- Movimenti ---------------------------------------------------------------


class MovementOut(Schema):
    id: int
    product_id: int
    product_name: str
    kind: str
    qty: Decimal
    reason: str
    sale_id: Optional[int] = None
    order_id: Optional[int] = None
    invoice_url: Optional[str] = None
    author_name: str = ""
    operator_name: str = ""
    created_at: datetime

    @staticmethod
    def resolve_product_name(obj):
        return obj.product.name

    @staticmethod
    def resolve_invoice_url(obj):
        return obj.invoice.url if obj.invoice else None

    @staticmethod
    def resolve_author_name(obj):
        if not obj.author:
            return ""
        return obj.author.get_full_name() or obj.author.email

    @staticmethod
    def resolve_operator_name(obj):
        op = obj.operator
        if not op:
            return ""
        return f"{op.first_name} {op.last_name}".strip()


# ---- Ordini ------------------------------------------------------------------


class OrderLineOut(Schema):
    id: int
    product_id: int
    product_name: str
    sku: str = ""
    qty_ordered: Decimal
    qty_received: Decimal

    @staticmethod
    def resolve_product_name(obj):
        return obj.product.name

    @staticmethod
    def resolve_sku(obj):
        return obj.product.sku


class OrderOut(Schema):
    id: int
    supplier_id: int
    supplier_name: str
    status: str
    sent_method: str
    sent_at: Optional[datetime] = None
    created_at: datetime
    lines: list[OrderLineOut]

    @staticmethod
    def resolve_supplier_name(obj):
        return obj.supplier.name

    @staticmethod
    def resolve_lines(obj):
        return list(obj.lines.all())


class OrderLineUpdateIn(Schema):
    id: int
    qty_ordered: Decimal


class OrderUpdateIn(Schema):
    lines: list[OrderLineUpdateIn]


class OrderSendIn(Schema):
    method: str = ""  # default: order_method del fornitore


class OrderReceiveLineIn(Schema):
    id: int
    qty_received: Decimal


class OrderReceiveIn(Schema):
    lines: list[OrderReceiveLineIn]


class DiscrepancyOut(Schema):
    line_id: int
    product_id: int
    product_name: str
    qty_ordered: Decimal
    qty_received: Decimal
    delta: Decimal


class OrderReceiveOut(Schema):
    order: OrderOut
    discrepancies: list[DiscrepancyOut]
