"""Schemi d'ingresso e d'uscita dell'anagrafica.

I campi in ingresso sono lunghi al massimo quanto la colonna che li accoglie e
ristretti alle scelte del modello. Non è pignoleria: gli schemi dichiaravano
`str` nudi e nessun endpoint chiama `full_clean()`, quindi una stringa più
lunga della colonna arrivava intatta a Postgres e usciva come 500 (`DataError`
non gestita), mentre un valore fuori dalle `choices` — `lang="xx"`,
`visibility="shared"`, `reliability=5000` — restava scritto in archivio.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from ninja import Schema
from pydantic import Field


# ---- Etichette (ClientCategory) ---------------------------------------------


class CategoryOut(Schema):
    id: int
    name: str
    color: str
    order: int


class CategoryIn(Schema):
    name: str = Field(max_length=60)
    # Colonna di 7 caratteri: solo #RRGGBB, «rgb(255,0,0)» non ci sta.
    color: str = Field("#6366F1", pattern=r"^#[0-9A-Fa-f]{6}$")
    order: int = Field(0, ge=0)


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
    # True quando chi legge non ha il permesso «vendite»: i tre contatori sopra
    # valgono zero perché sono nascosti, non perché la cliente sia nuova.
    stats_hidden: bool = False


class ClientIn(Schema):
    """Corpo del POST cliente (il PUT usa `ClientUpdateIn`, tutto facoltativo).

    Sul PUT i campi si applicano solo se presenti nel corpo (`exclude_unset` in
    api._client_payload): quasi tutti hanno un default e riversarli su una
    scheda esistente cancellava la prova del consenso privacy, l'affidabilità e
    perfino la disattivazione di chi mandava solo il campo da correggere.

    Gli identificativi Stripe NON sono qui: sono scritti da
    apps.sales.stripe_service quando la carta viene registrata davvero.
    Accettarli dal client permetteva di copiare `stripe_customer_id` e
    `stripe_payment_method_id` della cliente A sulla scheda B e addebitare un
    no-show sulla carta di A.
    """

    first_name: str = Field(max_length=80)
    last_name: str = Field("", max_length=80)
    phone: str = Field(max_length=32)
    email: str = Field("", max_length=254)
    wa: bool = True
    lang: Literal["it", "en"] = "it"
    category_ids: list[int] = []
    reliability: int = Field(100, ge=0, le=100)
    origin: str = Field("", max_length=60)
    gender: str = ""
    # 'YYYY-MM-DD' | '--MM-DD' (solo giorno e mese) | None
    birthday: Optional[str] = None
    since: Optional[date] = None
    consents: dict = {}
    whatsapp_reminders: bool = True
    deposit_always: bool = False
    is_active: bool = True


class ClientUpdateIn(Schema):
    """Corpo del PUT cliente: ogni campo è facoltativo (C15).

    Si applicano solo i campi presenti, e si scrivono solo le colonne che
    cambiano. Con lo schema del POST nome e telefono erano obbligatori: il PUT
    di una sola etichetta, o di `is_active` per riattivare una scheda, doveva
    rimandare tutta la copia letta all'apertura, e con lei i consensi, la
    lingua e i promemoria che nel frattempo la cliente aveva cambiato
    dall'app (06-10, 14-05, 18-07). `null` vale solo per compleanno e «cliente
    dal» (li svuota) e per i testi facoltativi; sugli altri è un errore.
    """

    first_name: Optional[str] = Field(None, max_length=80)
    last_name: Optional[str] = Field(None, max_length=80)
    phone: Optional[str] = Field(None, max_length=32)
    email: Optional[str] = Field(None, max_length=254)
    wa: Optional[bool] = None
    lang: Optional[Literal["it", "en"]] = None
    category_ids: Optional[list[int]] = None
    reliability: Optional[int] = Field(None, ge=0, le=100)
    origin: Optional[str] = Field(None, max_length=60)
    gender: Optional[str] = None
    birthday: Optional[str] = None
    since: Optional[date] = None
    # Solo i flag contano (privacy, marketing, card_charge): le date della
    # prova del consenso le scrive il server quando un flag cambia.
    consents: Optional[dict] = None
    whatsapp_reminders: Optional[bool] = None
    deposit_always: Optional[bool] = None
    is_active: Optional[bool] = None


# ---- Import CSV (righe già parsate lato client, JSON) ------------------------


class ImportRowIn(Schema):
    """Riga già mappata e normalizzata dal frontend (mapping colonne → campi).

    Qui NON si vincolano le lunghezze: un solo valore fuori misura farebbe
    fallire con un 422 l'intero file, senza dire quale riga. Le righe che il
    database rifiuta finiscono una per una in `errors` (vedi import_rows) e le
    altre entrano lo stesso.
    """

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
    # «Cliente dal» del gestionale di provenienza ('YYYY-MM-DD' | ""). Senza,
    # la scheda importata resta senza data: prima prendeva quella dell'import
    # e tutta la rubrica storica risultava cliente «dal 2026» (06-07, 08-05).
    since: str = ""


# Tetto per richiesta. Ogni riga costa 2-5 query dentro un savepoint, in una
# sola richiesta sincrona: senza limite un file da 50.000 righe tiene occupato
# un worker finché il proxy non chiude la connessione. La modale del gestionale
# spezza già l'import in blocchi da 250.
IMPORT_MAX_ROWS = 1000


class ImportIn(Schema):
    rows: list[ImportRowIn] = Field(max_length=IMPORT_MAX_ROWS)
    # False: i clienti già in rubrica (stesso telefono/email) vengono saltati, non toccati
    update_existing: bool = True


class ImportErrorOut(Schema):
    row: int
    reason: str
    # La scheda a cui la riga si riferisce, quando c'è (archiviata, email di
    # un'altra persona): la dashboard può aprirla invece di un vicolo cieco.
    client_id: Optional[int] = None


class ImportOut(Schema):
    created: int
    updated: int
    skipped: int = 0
    # Righe NON importate.
    errors: list[ImportErrorOut] = []
    # Righe importate lasciando fuori un dato che non si poteva leggere (per
    # esempio il 29/02 di un anno non bisestile): la cliente c'è, quel campo no.
    warnings: list[ImportErrorOut] = []


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


# Le sole scelte del modello (ClientNote.Visibility). La colonna è lunga 10:
# «da-condividere» non ci sta e usciva come 500; «shared» ci stava ed entrava
# in archivio pur non essendo una scelta prevista.
NoteVisibility = Literal["private", "ai"]


class NoteIn(Schema):
    text: str = ""
    visibility: NoteVisibility = "private"
    appointment_id: Optional[int] = None


class NoteUpdateIn(Schema):
    text: Optional[str] = None
    visibility: Optional[NoteVisibility] = None


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
    category: str = Field(max_length=40)
    treatment: str = Field(max_length=120)
    zone: str = Field("", max_length=120)
    products: str = ""
    params: dict = {}
    outcome: str = ""
    duration_hold: str = Field("", max_length=60)
    advice: str = ""
    protocol: str = ""
    next_step: str = Field("", max_length=120)


class OkOut(Schema):
    ok: bool = True


class HookLeadIn(Schema):
    """Form pubblico di raccolta contatti (/<slug>/hook nell'app cliente)."""

    salon_slug: str = Field(max_length=60)
    first_name: str = Field(max_length=80)
    last_name: str = Field("", max_length=80)
    phone: str = Field(max_length=32)
    email: str = Field("", max_length=254)
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
