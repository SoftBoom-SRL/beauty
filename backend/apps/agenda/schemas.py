import datetime as dt
from decimal import Decimal
from typing import Optional

from ninja import Field, Schema
from pydantic import field_validator

# Servizi per richiesta. La ricerca di disponibilità prova ogni slot della
# giornata per ogni servizio: senza tetto una sola richiesta con qualche
# centinaio di voci tiene occupato un worker e interroga il database migliaia di
# volte (e in creazione scrive altrettante righe con il lock in mano). Nessuna
# visita vera ne ha più di una decina.
MAX_ITEMS_PER_REQUEST = 12

# Un orario senza fuso non è un istante: interpretarlo a caso significa
# prenotare all'ora sbagliata, e fino a ieri arrivava intatto fino al database
# e faceva esplodere la richiesta con un 500 invece di dire cosa manca.
NAIVE_DATETIME_MESSAGE = (
    "Orario senza fuso orario: usa il formato ISO con offset (es. 2026-09-18T10:00:00+02:00)"
)


# Anni plausibili per un'agenda. Un orario del 9999 passava la validazione e
# poi esplodeva nell'aritmetica (fine = inizio + durata oltre l'anno massimo)
# con un 500 invece di dire che la data non ha senso.
MIN_YEAR = 2000
MAX_YEAR = 2100
YEAR_OUT_OF_RANGE_MESSAGE = f"Data fuori dall'intervallo ammesso ({MIN_YEAR}–{MAX_YEAR})"


def _require_aware(value: dt.datetime) -> dt.datetime:
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ValueError(NAIVE_DATETIME_MESSAGE)
    if not (MIN_YEAR <= value.year <= MAX_YEAR):
        raise ValueError(YEAR_OUT_OF_RANGE_MESSAGE)
    return value


def aware_start_validator():
    """Validatore condiviso: il campo `start` deve portare il fuso orario."""
    return field_validator("start")(_require_aware)


# ---- Input -----------------------------------------------------------------


class ItemIn(Schema):
    service_id: int
    operator_id: Optional[int] = None  # None = qualsiasi operatrice idonea


class ItemEditIn(Schema):
    id: Optional[int] = None            # existing AppointmentService id (None = new item)
    service_id: int
    operator_id: Optional[int] = None   # None = first eligible free operator
    # None = keep the duration already booked. Con un tetto, come posa e
    # listino: un «600» battuto al posto di «60» passava, forzato dal
    # ritentativo automatico, e bloccava l'agenda dell'operatrice per giorni.
    duration_min: Optional[int] = Field(None, ge=1, le=12 * 60)
    # Attesa DOPO il servizio: la posa di un colore, o semplicemente il buco che
    # il salone vuole lasciare prima del trattamento successivo (la cliente
    # resta lì, l'operatrice nel frattempo è libera — è la stessa cosa per
    # l'agenda). Senza questo campo i servizi di una visita erano per forza
    # attaccati, e chiudere il buco era l'unica scelta possibile.
    # None = quella già sulla visita (o del listino, per le voci nuove).
    soak_min: Optional[int] = Field(None, ge=0, le=12 * 60)


class AppointmentCreateIn(Schema):
    client_id: int
    items: list[ItemIn] = Field(..., max_length=MAX_ITEMS_PER_REQUEST)
    start: dt.datetime
    flexible: bool = False
    note: str = ""
    location_id: Optional[int] = None
    # Solo staff: inserisce anche fuori turno/orario o sopra un'altra prenotazione
    # (straordinario, "ci incastriamo"). L'appuntamento resta marcato `forced`.
    force: bool = False

    _start_aware = aware_start_validator()


class ClientAppointmentCreateIn(Schema):
    items: list[ItemIn] = Field(..., max_length=MAX_ITEMS_PER_REQUEST)
    start: dt.datetime

    _start_aware = aware_start_validator()


class MoveIn(Schema):
    start: dt.datetime
    operator_id: Optional[int] = None
    # Colonna di PARTENZA del gesto in agenda: i servizi di quell'operatrice
    # passano a `operator_id`. Senza, la riassegnazione toccava sempre e solo i
    # servizi dell'operatrice principale, e trascinare in un'altra colonna il
    # gruppo di servizi affidato a una collega spostava quelli sbagliati.
    # Assente = l'operatrice principale, come prima.
    from_operator_id: Optional[int] = None
    force: bool = False

    _start_aware = aware_start_validator()


class SplitIn(Schema):
    """Stacca un servizio da un appuntamento multi-servizio e lo sposta altrove."""

    item_id: int
    start: dt.datetime
    operator_id: Optional[int] = None
    force: bool = False

    _start_aware = aware_start_validator()


class RestoreIn(Schema):
    force: bool = False


class ClientMoveIn(Schema):
    start: dt.datetime

    _start_aware = aware_start_validator()


class ReasonIn(Schema):
    # Il motivo finisce in Appointment.cancel_reason, che è lungo 255: più in là
    # PostgreSQL rifiutava la scrittura e la richiesta moriva con un 500.
    reason: str = Field("", max_length=255)


class CancelIn(ReasonIn):
    # Annullamento chiesto dalla CLIENTE (al telefono, al banco) e registrato
    # dallo staff: valgono le sue regole, come dall'app. Sotto le ore minime la
    # caparra resta al salone e la disdetta conta come tardiva. L'app rifiuta
    # l'annullamento tardivo e manda la cliente dal salone: senza questo il
    # salone annullava sempre come se fosse colpa sua, e la penale non si
    # applicava mai.
    by_client: bool = False


class DepositCashedIn(Schema):
    """Caparra incassata al banco: come è stata pagata (contanti, POS, …)."""

    method: str = Field("cash", max_length=20)


class AppointmentUpdateIn(Schema):
    items: Optional[list[ItemEditIn]] = Field(None, max_length=MAX_ITEMS_PER_REQUEST)
    note: Optional[str] = None
    # Come in creazione e spostamento: lo staff può andare oltre le regole.
    # Allungare un trattamento mentre accanto c'è un incastro forzato è un gesto
    # normale al banco, e senza questo l'agenda rispondeva «Orario non più
    # disponibile» a un trascinamento che deve solo scrivere.
    force: bool = False
    # `updated_at` della copia da cui parte chi scrive (AppointmentOut): se nel
    # frattempo la visita è cambiata la modifica risponde 412, anche forzando.
    # Il pannello rimasto aperto rimandava la lista vecchia e disfaceva gli
    # spostamenti e gli stacchi fatti intanto dalla griglia o da un'altra
    # postazione.
    expected_updated_at: Optional[dt.datetime] = None

    @field_validator("expected_updated_at")
    @classmethod
    def _expected_aware(cls, value):
        return value if value is None else _require_aware(value)


class PauseIn(Schema):
    operator_id: int
    start: dt.datetime
    # Una pausa di zero minuti (o negativa) arrivava fino al database e poi
    # occupava un intervallo vuoto che nessuna vista sapeva disegnare.
    duration_min: int = Field(..., ge=5, le=12 * 60)
    note: str = Field("", max_length=255)  # come sulla colonna del modello

    _start_aware = aware_start_validator()


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
    # Versione della visita: va rimandata in `expected_updated_at` del PUT.
    updated_at: Optional[dt.datetime] = None


class ClientOperatorOut(Schema):
    id: int
    name: str


class ClientServiceOut(Schema):
    service_id: int
    operator_id: int
    name: str
    duration_min: int
    price: Decimal


class ClientAppointmentOut(Schema):
    """L'appuntamento come lo vede la cliente nell'app (vedi `_client_appointment_out`).

    Niente nota interna, `forced`, `created_via` né motivo di annullamento: sono
    appunti e dati del salone. Sposta, annulla e prenota dall'app rispondevano
    con la scheda dello staff, e la nota scritta sulla cliente le arrivava nella
    risposta.
    """

    id: int
    start: dt.datetime
    end: dt.datetime
    status: str
    operator: ClientOperatorOut
    services: list[ClientServiceOut]
    total_price: Decimal
    deposit_status: str
    deposit_amount: Decimal
    deposit_due_at: Optional[dt.datetime] = None
    deposit_payment_link: str = ""
    auto_released: bool = False
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


class UndoIn(Schema):
    # Nessun id = l'ultima azione annullabile di chi sta chiedendo.
    entry_id: Optional[int] = None


class UndoOut(Schema):
    """Un gesto ancora annullabile, come lo mostra il tasto «torna indietro»."""

    id: int
    kind: str
    label: str
    created_at: dt.datetime
    expires_at: dt.datetime


class UndoResultOut(Schema):
    ok: bool = True
    label: str
    # Giorno da mostrare in agenda dopo l'annullamento: il gesto può aver
    # riportato l'appuntamento su un'altra data.
    date: Optional[str] = None
    appointment_ids: list[int] = []
