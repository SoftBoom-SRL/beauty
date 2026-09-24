from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema
from pydantic import Field


# ---- Operatrici ----------------------------------------------------------------


class OperatorIn(Schema):
    # Testi lunghi al massimo quanto la colonna del modello: un ruolo di 121
    # caratteri su PostgreSQL faceva rifiutare la riga, 500 invece di un errore
    # che dice quale campo correggere (bug sospetti del 24/09, voce 21). Colore,
    # ciclo, ordine e costo orario li controlla `validate_operator_payload` (400).
    first_name: str = Field(max_length=80)
    last_name: str = Field(max_length=80)
    color: str = "#A5B4FC"
    role_title: str = Field("", max_length=120)
    location_id: Optional[int] = None
    user_id: Optional[int] = None
    service_ids: list[int] = []
    hourly_cost: Decimal = Decimal("0")
    cycle_weeks: int = 1
    active: bool = True
    order: int = 0


class OperatorPatchIn(Schema):
    """PUT /api/staff/{id}: si applicano SOLO i campi presenti nel corpo (C19).

    `location_id` e `user_id` accettano null (nessuna sede, nessun utente);
    gli altri campi, se presenti, non possono essere null.
    """

    first_name: Optional[str] = Field(None, max_length=80)  # come in OperatorIn
    last_name: Optional[str] = Field(None, max_length=80)
    color: Optional[str] = None
    role_title: Optional[str] = Field(None, max_length=120)
    location_id: Optional[int] = None
    user_id: Optional[int] = None
    service_ids: Optional[list[int]] = None
    hourly_cost: Optional[Decimal] = None
    cycle_weeks: Optional[int] = None
    active: Optional[bool] = None
    order: Optional[int] = None


class OperatorColorIn(Schema):
    color: str


class OperatorOut(Schema):
    id: int
    first_name: str
    last_name: str
    initials: str
    color: str
    role_title: str
    location_id: Optional[int] = None
    user_id: Optional[int] = None
    service_ids: list[int] = []
    # null (mai 0) per chi non è titolare e non ha lo scope `team`: è un dato
    # salariale. Vedi `cash_hidden`.
    hourly_cost: Optional[Decimal] = None
    cycle_weeks: int
    active: bool
    order: int
    # Vero quando qualche dato di cassa/HR della riga è stato nascosto (null)
    # per mancanza di permesso: la dashboard mostra «•••» (C6).
    cash_hidden: bool = False


class OperatorStatusOut(OperatorOut):
    """Riga della lista operatrici: anagrafica + stato di oggi + KPI rapide."""

    on_shift: bool
    windows: list[tuple[str, str]]
    absence_type: Optional[str] = None
    # null senza il permesso vendite (C6).
    month_revenue: Optional[Decimal] = None
    today_clients: int


class WeeklyShiftOut(Schema):
    id: int
    week_index: int
    weekday: int
    start_min: int
    end_min: int
    break_start_min: Optional[int] = None
    break_end_min: Optional[int] = None


class OperatorDetailOut(OperatorOut):
    """Dettaglio operatrice: anagrafica + pattern di turno corrente."""

    shifts: list[WeeklyShiftOut]


class PublicOperatorOut(Schema):
    """Riga pubblica per la scelta dello stilista in prenotazione (no auth)."""

    id: int
    first_name: str
    last_name: str
    initials: str
    color: str
    service_ids: list[int] = []


# ---- Turni -----------------------------------------------------------------


class WeeklyShiftIn(Schema):
    week_index: int = 0
    weekday: int
    start_min: int
    end_min: int
    break_start_min: Optional[int] = None
    break_end_min: Optional[int] = None


class ShiftsReplaceIn(Schema):
    shifts: list[WeeklyShiftIn]


# ---- Assenze -----------------------------------------------------------------


class AbsenceIn(Schema):
    date_from: date
    date_to: date
    type: str
    note: str = Field("", max_length=255)  # come la colonna del modello (voce 21)


class AbsenceOut(AbsenceIn):
    id: int


# ---- Performance e clienti serviti ---------------------------------------------


class PerformanceOut(Schema):
    month: str  # "YYYY-MM"
    revenue: Optional[Decimal] = None  # null senza il permesso vendite (C6)
    sales_count: int
    cash_hidden: bool = False


class ServedClientOut(Schema):
    client_id: int
    first_name: str
    last_name: str
    phone: str
    # Visite, ultima visita e spesa sono dati di cassa, come nella scheda
    # cliente: null senza il permesso vendite, con `cash_hidden` (C6).
    visits: Optional[int] = None
    last_visit: Optional[datetime] = None
    total_spent: Optional[Decimal] = None
    cash_hidden: bool = False
