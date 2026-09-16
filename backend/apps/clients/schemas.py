from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema


# ---- Etichette (ClientCategory) ---------------------------------------------


class CategoryOut(Schema):
    id: int
    name: str
    color: str
    order: int


class CategoryIn(Schema):
    name: str
    color: str = "#6366F1"
    order: int = 0


# ---- Cliente ------------------------------------------------------------------


class ClientOut(Schema):
    id: int
    first_name: str
    last_name: str
    full_name: str
    phone: str
    email: str
    wa: bool
    lang: str
    categories: list[CategoryOut]
    reliability: int
    origin: str
    gender: str = ""  # female | male | other | "" (non specificato)
    # 'YYYY-MM-DD', oppure '--MM-DD' se il cliente non ha dato l'anno (ISO 8601)
    birthday: Optional[str] = None
    birthday_year_known: bool = True
    age: Optional[int] = None
    since: Optional[date] = None
    consents: dict
    whatsapp_reminders: bool
    stripe_customer_id: str
    stripe_payment_method_id: str
    deposit_always: bool
    is_active: bool


    @staticmethod
    def resolve_birthday(obj):
        return getattr(obj, "birthday_iso", None)

    @staticmethod
    def resolve_age(obj):
        return getattr(obj, "age", None)


class ClientDetailOut(ClientOut):
    visits: int
    total_spent: Decimal
    last_visit: Optional[datetime] = None


class ClientIn(Schema):
    first_name: str
    last_name: str = ""
    phone: str
    email: str = ""
    wa: bool = True
    lang: str = "it"
    category_ids: list[int] = []
    reliability: int = 100
    origin: str = ""
    gender: str = ""
    # 'YYYY-MM-DD' | '--MM-DD' (solo giorno e mese) | None
    birthday: Optional[str] = None
    since: Optional[date] = None
    consents: dict = {}
    whatsapp_reminders: bool = True
    stripe_customer_id: str = ""
    stripe_payment_method_id: str = ""
    deposit_always: bool = False
    is_active: bool = True


# ---- Import CSV (righe già parsate lato client, JSON) ------------------------


class ImportRowIn(Schema):
    """Riga già mappata e normalizzata dal frontend (mapping colonne → campi)."""

    first_name: str = ""
    last_name: str = ""
    email: str = ""
    phone: str = ""
    gender: str = ""            # female | male | other | ""
    birthday: str = ""          # 'YYYY-MM-DD' | '--MM-DD' | ""
    origin: str = ""
    lang: str = ""              # it | en | ""
    note: str = ""              # diventa una nota privata sul cliente
    categories: list[str] = []  # nomi etichetta: create se mancanti


class ImportIn(Schema):
    rows: list[ImportRowIn]
    # False: i clienti già in rubrica (stesso telefono/email) vengono saltati, non toccati
    update_existing: bool = True


class ImportErrorOut(Schema):
    row: int
    reason: str


class ImportOut(Schema):
    created: int
    updated: int
    skipped: int = 0
    errors: list[ImportErrorOut] = []


# ---- Note ----------------------------------------------------------------------


class AttachmentOut(Schema):
    id: int
    name: str
    url: str
    content_type: str
    size: int
    is_image: bool
    created_at: datetime


class NoteOut(Schema):
    """Serializzata da api._note_out (dizionari), non da istanze: niente resolver."""

    id: int
    client_id: int
    appointment_id: Optional[int] = None
    text: str
    visibility: str
    author_id: Optional[int] = None
    author_name: str = ""
    attachments: list[AttachmentOut] = []
    created_at: datetime
    updated_at: Optional[datetime] = None


class NoteIn(Schema):
    text: str = ""
    visibility: str = "private"
    appointment_id: Optional[int] = None


class NoteUpdateIn(Schema):
    text: Optional[str] = None
    visibility: Optional[str] = None


# ---- Schede tecniche (sola lettura dopo la creazione) -------------------------


class TechnicalSheetOut(Schema):
    id: int
    client_id: int
    appointment_id: Optional[int] = None
    category: str
    treatment: str
    zone: str
    products: str
    params: dict
    outcome: str
    duration_hold: str
    advice: str
    protocol: str
    next_step: str
    photo: Optional[str] = None
    author_id: Optional[int] = None
    author_name: str = ""
    created_at: datetime

    @staticmethod
    def resolve_author_name(obj) -> str:
        author = getattr(obj, "author", None)
        if not author:
            return ""
        return author.get_full_name() or author.email


class TechnicalSheetIn(Schema):
    appointment_id: Optional[int] = None
    category: str
    treatment: str
    zone: str = ""
    products: str = ""
    params: dict = {}
    outcome: str = ""
    duration_hold: str = ""
    advice: str = ""
    protocol: str = ""
    next_step: str = ""


class OkOut(Schema):
    ok: bool = True


class HookLeadIn(Schema):
    """Form pubblico di raccolta contatti (/<slug>/hook nell'app cliente)."""

    salon_slug: str
    first_name: str
    last_name: str = ""
    phone: str
    email: str = ""
    marketing: bool = False
    privacy: bool = False
    # Honeypot a CHECKBOX, nascosta via CSS: deve arrivare False.
    # Non un campo di testo: l'autofill di Chrome riempiva il vecchio `website`
    # (token che riconosce) e scartava utenti veri in silenzio. Le checkbox
    # l'autofill non le spunta, i bot che compilano tutto sì.
    trap: bool = False
    # Accettato per retrocompatibilità con bundle vecchi ancora in cache.
    website: str = ""


class HookLeadOut(Schema):
    ok: bool = True
