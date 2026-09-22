from decimal import Decimal
from typing import Optional

from ninja import Schema
from pydantic import Field


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
    # Assente = «non toccare il colore». Con il default a "#E0E7FF" bastava
    # rinominare una categoria da un modulo che non manda il campo per
    # riportarne il colore al grigio di fabbrica.
    color: Optional[str] = None
    order: int = 0


class ReorderIn(Schema):
    ids: list[int]


# ---- Servizi ------------------------------------------------------------------


class ServiceOut(Schema):
    id: int
    category_id: int
    name_it: str
    name_en: str
    description_it: str = ""
    description_en: str = ""
    duration_min: int
    soak_min: int = 0
    price: Decimal
    product_cost: Decimal
    supplier_cost: Decimal
    active: bool
    order: int


class ServiceIn(Schema):
    category_id: int
    name_it: str
    name_en: str = ""
    description_it: str = Field("", max_length=600)
    description_en: str = Field("", max_length=600)
    duration_min: int = Field(..., ge=1, le=24 * 60)  # un servizio da zero minuti non esiste
    soak_min: int = Field(0, ge=0, le=24 * 60)
    price: Decimal = Field(..., ge=0)
    product_cost: Decimal = Field(Decimal("0"), ge=0)
    supplier_cost: Decimal = Field(Decimal("0"), ge=0)
    active: bool = True
    order: int = 0


# ---- Pacchetti ------------------------------------------------------------------


class PackageItemIn(Schema):
    service_id: int
    qty: int = Field(1, ge=1)


class PackageItemOut(Schema):
    id: int
    service_id: int
    qty: int


class PackageIn(Schema):
    name: str
    description: str = ""
    price: Decimal = Field(..., ge=0)
    active: bool = True
    # Assente = «non toccare le righe». Con il default a [] un PUT che cambiava
    # solo il prezzo svuotava il pacchetto dei servizi inclusi.
    items: Optional[list[PackageItemIn]] = None


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
    description_it: str = ""
    description_en: str = ""
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
