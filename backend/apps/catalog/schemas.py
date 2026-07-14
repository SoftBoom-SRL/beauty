from decimal import Decimal

from ninja import Schema


# ---- Categorie --------------------------------------------------------------


class CategoryOut(Schema):
    id: int
    name_it: str
    name_en: str
    color: str
    order: int


class CategoryIn(Schema):
    name_it: str
    name_en: str = ""
    color: str = "#E0E7FF"
    order: int = 0


class ReorderIn(Schema):
    ids: list[int]


# ---- Servizi ------------------------------------------------------------------


class ServiceOut(Schema):
    id: int
    category_id: int
    name_it: str
    name_en: str
    duration_min: int
    price: Decimal
    product_cost: Decimal
    supplier_cost: Decimal
    active: bool
    order: int


class ServiceIn(Schema):
    category_id: int
    name_it: str
    name_en: str = ""
    duration_min: int
    price: Decimal
    product_cost: Decimal = Decimal("0")
    supplier_cost: Decimal = Decimal("0")
    active: bool = True
    order: int = 0


# ---- Pacchetti ------------------------------------------------------------------


class PackageItemIn(Schema):
    service_id: int
    qty: int = 1


class PackageItemOut(Schema):
    id: int
    service_id: int
    qty: int


class PackageIn(Schema):
    name: str
    description: str = ""
    price: Decimal
    active: bool = True
    items: list[PackageItemIn] = []


class PackageOut(Schema):
    id: int
    name: str
    description: str
    price: Decimal
    active: bool
    items: list[PackageItemOut]


# ---- Endpoint pubblici (web app cliente, no auth) ----------------------------


class PublicServiceOut(Schema):
    id: int
    name_it: str
    name_en: str
    duration_min: int
    price: Decimal


class PublicCategoryOut(Schema):
    id: int
    name_it: str
    name_en: str
    color: str
    services: list[PublicServiceOut]


class PublicPackageItemOut(Schema):
    service_id: int
    name_it: str
    name_en: str
    qty: int


class PublicPackageOut(Schema):
    id: int
    name: str
    description: str
    price: Decimal
    items: list[PublicPackageItemOut]


class OkOut(Schema):
    ok: bool = True
