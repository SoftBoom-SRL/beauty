from datetime import datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema
from pydantic import Field

from common.media import signed_media_url
from common.permissions import has_scope


# ---- Fornitori ---------------------------------------------------------------


class SupplierIn(Schema):
    # Testi lunghi al massimo quanto la colonna che li accoglie. Senza limite una
    # partita IVA come «IT01234567890 sede di Milano» arrivava intatta a
    # PostgreSQL, che rifiutava la riga: 500 invece di un errore che dice quale
    # campo correggere (bug sospetti del 24/09, voce 21). `order_method` lo
    # controlla l'endpoint contro le scelte del modello (400).
    name: str = Field(max_length=120)
    email: str = Field("", max_length=254)
    phone: str = Field("", max_length=40)
    order_method: str = "email"
    address: str = Field("", max_length=255)
    vat_number: str = Field("", max_length=20)
    sdi_pec: str = Field("", max_length=120)
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
    # Come per i fornitori, testi lunghi quanto le colonne (voce 21). Sconto e
    # aliquota IVA sono percentuali in colonne senza segno: un -5 violava il
    # vincolo ≥ 0 anche su SQLite (500), un 40000 usciva dallo smallint di
    # PostgreSQL, un 150 finiva in archivio.
    name: str = Field(max_length=160)
    sku: str = Field("", max_length=60)
    brand: str = Field("", max_length=120)
    category_id: Optional[int] = None
    usage: str = "retail"
    package_unit: str = Field("", max_length=20)
    package_qty: Decimal = Decimal("1")
    supplier_id: int
    purchase_price: Decimal = Decimal("0")
    purchase_discount_pct: int = Field(0, ge=0, le=100)
    sale_price: Decimal = Decimal("0")
    vat_rate: int = Field(22, ge=0, le=100)
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
    # Prodotto scelto dall'elenco o abbinato dalla dashboard (C7): se c'è
    # identifica il prodotto (del salone) e vince su SKU e nome.
    product_id: Optional[int] = None
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
    def resolve_invoice_url(obj, context=None):
        if not obj.invoice:
            return None
        # La fattura del fornitore (prezzi d'acquisto, sconti, condizioni) è un
        # documento di cassa: il link firmato solo al titolare e a chi ha
        # «sales», come gli incassi. Prima bastava l'accesso al magazzino
        # (10-09). Senza un contesto di richiesta non si espone nulla.
        auth = getattr((context or {}).get("request"), "auth", None)
        if auth is None or not has_scope(auth, "sales"):
            return None
        # `inventory/invoices/` è un prefisso riservato in common/media.py: senza
        # token firmato la vista /media/ risponde 403 e il link della fattura
        # nello storico di magazzino non apriva mai nulla.
        return signed_media_url(obj.invoice)

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
        return op.full_name


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
