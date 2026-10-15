from decimal import Decimal
from typing import Optional

from ninja import Schema
from pydantic import Field

from common.money import MAX_MONEY
from common.validation import MAX_POSITIVE_INT


# ---- Categorie --------------------------------------------------------------


# Il prefisso dell'app serve: django-ninja chiama i componenti OpenAPI con il
# nome della classe, e le `CategoryIn`/`CategoryOut` di listino, etichette e
# magazzino si sovrascrivevano. Ne restava una sola, e il listino risultava
# documentato con `name` invece di `name_it` e `name_en` (voce 24 dei bug
# sospetti del 24/09).
class ServiceCategoryOut(Schema):
    id: int
    name_it: str
    name_en: str
    color: str
    order: int


class ServiceCategoryIn(Schema):
    # Lunghi quanto le colonne: più lunghi, su PostgreSQL erano un 500.
    name_it: str = Field(max_length=120)
    name_en: str = Field("", max_length=120)
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
    # "" = il colore della categoria; "#RRGGBB" = un colore suo, personalizzato.
    color: str = Field(
        "", description="Colore del servizio (#RRGGBB); vuoto = quello della categoria"
    )
    is_addon: bool = Field(
        False,
        description=(
            "Aggiuntivo: si fa durante un altro servizio (nail art durante la manicure). "
            "In agenda aggiunge il prezzo, non il tempo: la sua voce dura 0 minuti e va "
            "dopo il servizio a cui si appoggia. `duration_min` resta quella indicativa."
        ),
    )


class ServiceIn(Schema):
    category_id: int
    # Nomi lunghi quanto le colonne (120) e ordine dentro PositiveIntegerField:
    # un nome più lungo su PostgreSQL e un ordine negativo anche su SQLite
    # erano un 500 invece di un errore che dice quale campo correggere (bug
    # sospetti del 24/09, voce 21). Lo stesso per prezzo e costi, in colonne
    # numeric(10,2): oltre i cento milioni PostgreSQL rifiuta la riga.
    name_it: str = Field(max_length=120)
    name_en: str = Field("", max_length=120)
    description_it: str = Field("", max_length=600)
    description_en: str = Field("", max_length=600)
    duration_min: int = Field(..., ge=1, le=24 * 60)  # un servizio da zero minuti non esiste
    soak_min: int = Field(0, ge=0, le=24 * 60)
    price: Decimal = Field(..., ge=0, le=MAX_MONEY)
    product_cost: Decimal = Field(Decimal("0"), ge=0, le=MAX_MONEY)
    supplier_cost: Decimal = Field(Decimal("0"), ge=0, le=MAX_MONEY)
    active: bool = True
    order: int = Field(0, ge=0, le=MAX_POSITIVE_INT)
    # Assente = «non toccare il colore» (come per le categorie): riattivare un
    # servizio dalla lista manda il servizio senza colore, e non deve togliere
    # quello scelto a mano. "" = torna al colore della categoria.
    color: Optional[str] = Field(
        None,
        description="Colore del servizio (#RRGGBB); \"\" = quello della categoria; assente = invariato",
    )
    # Assente = invariato, come il colore: la riattivazione dalla lista manda il
    # servizio senza questo campo, e con un default a False avrebbe tolto in
    # silenzio il segno «aggiuntivo» alla nail art (che da lì in poi avrebbe
    # allungato ogni manicure del suo tempo di listino).
    is_addon: Optional[bool] = Field(
        None,
        description=(
            "Aggiuntivo: si fa durante un altro servizio e in agenda non aggiunge tempo; "
            "assente = invariato (falso per un servizio nuovo)"
        ),
    )


# ---- Pacchetti ------------------------------------------------------------------


class PackageItemIn(Schema):
    service_id: int
    qty: int = Field(1, ge=1, le=MAX_POSITIVE_INT)  # PositiveIntegerField


class PackageItemOut(Schema):
    id: int
    service_id: int
    qty: int


# Validità massima delle sedute di un pacchetto: dieci anni. Un numero di giorni
# battuto con uno zero in più (36500) è un errore da dire, non una scadenza.
MAX_PACKAGE_VALIDITY_DAYS = 3650


class PackageIn(Schema):
    # Nome e prezzo dentro le loro colonne (120 caratteri, numeric(10,2)): fuori,
    # su PostgreSQL erano un 500.
    name: str = Field(max_length=120)
    description: str = ""
    price: Decimal = Field(..., ge=0, le=MAX_MONEY)
    active: bool = True
    # Assente = «non toccare le righe». Con il default a [] un PUT che cambiava
    # solo il prezzo svuotava il pacchetto dei servizi inclusi.
    items: Optional[list[PackageItemIn]] = None
    # Giorni per usare le sedute dalla vendita; null = senza scadenza. Assente
    # nel PUT = invariata (come `items`): un modulo che non la conosce non deve
    # togliere la scadenza a un pacchetto.
    validity_days: Optional[int] = Field(
        None,
        ge=1,
        le=MAX_PACKAGE_VALIDITY_DAYS,
        description="Giorni di validità delle sedute dalla vendita; null = senza scadenza",
    )


class PackageOut(Schema):
    id: int
    name: str
    description: str
    price: Decimal
    active: bool
    validity_days: Optional[int] = None
    items: list[PackageItemOut]


# ---- Endpoint pubblici (web app cliente, no auth) ----------------------------


class PublicServiceOut(Schema):
    id: int
    name_it: str
    name_en: str
    description_it: str = ""
    description_en: str = ""
    duration_min: int
    # Minuti di posa dopo il lavoro attivo: la cliente resta in salone. Senza,
    # l'app chiamava «Durata» il solo lavoro — colore 60' + 40' di posa letto
    # «1 h», mentre l'agenda la tiene 1 h 40' (09-07, C4).
    soak_min: int = 0
    price: Decimal
    # Aggiuntivo (nail art, scrub): non si prenota da solo. L'app lo offre come
    # «Aggiungi» dopo il servizio principale, e non ne conta il tempo.
    is_addon: bool = False


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
    soak_min: int = 0  # come in PublicServiceOut (C4)
    qty: int


class PublicPackageOut(Schema):
    id: int
    name: str
    description: str
    price: Decimal
    # Entro quanti giorni dall'acquisto vanno fatte le sedute (null = nessun limite).
    validity_days: Optional[int] = None
    items: list[PublicPackageItemOut]
