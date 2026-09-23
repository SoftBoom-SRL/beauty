from datetime import datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema


class LocationOut(Schema):
    id: int
    name: str
    address: str
    phone: str
    is_default: bool


class LocationIn(Schema):
    name: str
    address: str = ""
    phone: str = ""
    is_default: bool = False


class SettingsOut(Schema):
    logo_url: Optional[str] = None
    brand_color: str
    opening_hours: str = ""
    # {"0": [["09:00","13:00"],["14:00","19:00"]], …, "6": []} — 0 = lunedì
    opening_hours_week: dict = {}
    agenda_fill: str
    slot_recovery: str
    slot_interval_min: int
    lastminute_discount_cap: int
    lastminute_monthly_budget: Decimal
    flexible_enabled: bool
    flexible_window_min: int
    flexible_reward_pct: int
    # Informativa privacy del salone, mostrata nel form pubblico /<slug>/hook.
    privacy_policy_url: str = ""
    # Soglia (ore) sotto la quale una cancellazione è "tardiva" → caparra trattenuta.
    # Derivata da settings.CLIENT_MOVE_CANCEL_MIN_HOURS, sola lettura.
    cancel_min_hours: int
    # Fuso in cui il server calcola gli orari del salone (sola lettura). Serve
    # alle due app per mostrare l'ora della reception e non quella del
    # dispositivo di chi guarda.
    timezone: str = "Europe/Rome"
    # Caparra con scadenza (0 = disattiva) e sollecito (0 = nessuno), in minuti.
    deposit_hold_minutes: int = 0
    deposit_reminder_minutes: int = 0
    # Secondi di attesa prima che un'automazione dell'agenda parta davvero
    # (0 = subito). Serve a non mandare due messaggi quando si corregge
    # l'appuntamento appena inserito.
    automation_delay_seconds: int = 30
    # Motivazioni personalizzate (vuote = predefinite della dashboard).
    cancel_reasons: list[str] = []
    no_show_reasons: list[str] = []
    # Pagamenti online: Stripe Connect del salone (sola lettura, si gestisce da /api/sales/stripe/connect).
    stripe_connected: bool = False
    stripe_connect_available: bool = False
    stripe_account_id: str = ""


class SettingsIn(Schema):
    default_lang: Optional[str] = None
    brand_color: Optional[str] = None
    opening_hours: Optional[str] = None
    opening_hours_week: Optional[dict] = None
    agenda_fill: Optional[str] = None
    slot_recovery: Optional[str] = None
    slot_interval_min: Optional[int] = None
    lastminute_discount_cap: Optional[int] = None
    lastminute_monthly_budget: Optional[Decimal] = None
    flexible_enabled: Optional[bool] = None
    flexible_window_min: Optional[int] = None
    flexible_reward_pct: Optional[int] = None
    privacy_policy_url: Optional[str] = None
    deposit_hold_minutes: Optional[int] = None
    deposit_reminder_minutes: Optional[int] = None
    automation_delay_seconds: Optional[int] = None
    cancel_reasons: Optional[list[str]] = None
    no_show_reasons: Optional[list[str]] = None


class SalonOut(Schema):
    id: int
    name: str
    slug: str
    default_lang: str
    currency: str
    locations: list[LocationOut]
    settings: SettingsOut


class DepositRuleOut(Schema):
    id: int
    name: str
    conditions: dict
    amount_type: str
    amount: Decimal
    priority: int
    active: bool


class DepositRuleIn(Schema):
    name: str
    conditions: dict = {}
    amount_type: str
    amount: Decimal
    priority: int = 0
    active: bool = True


class ActivityLogOut(Schema):
    id: int
    type: str
    summary: str
    actor_name: str
    payload: dict
    created_at: datetime


class ActivityFeedEventOut(Schema):
    """Voce del feed live (sottoinsieme del registro, con l'id dell'autore per
    distinguere le proprie azioni da quelle degli altri)."""

    id: int
    type: str
    summary: str
    actor_id: Optional[int] = None
    actor_name: str
    payload: dict
    created_at: datetime


class OutboxStatusOut(Schema):
    """Stato della consegna dei messaggi (OTP, conferme, promemoria) verso Yourang."""

    configured: bool            # YOURANG_API_URL impostato: senza, nulla parte
    pending: int
    failed: int
    sent_24h: int
    oldest_pending_at: Optional[datetime] = None
    last_sent_at: Optional[datetime] = None
    pending_types: list[str] = []


class ActivityFeedOut(Schema):
    cursor: int  # ultimo id noto: da ripassare come `after` alla prossima chiamata
    events: list[ActivityFeedEventOut]


class PublicBrandingOut(Schema):
    name: str
    slug: str
    default_lang: str
    logo_url: Optional[str] = None
    brand_color: str
    address: str = ""
    phone: str = ""
    opening_hours: str = ""
    opening_hours_week: dict = {}
    privacy_policy_url: str = ""
    timezone: str = "Europe/Rome"
    # Ore minime di preavviso per spostare o annullare: l'app cliente scriveva
    # «24h» a codice fisso, e un salone con una soglia diversa prometteva alle
    # clienti una regola che il server poi non applicava.
    cancel_min_hours: int = 24


class OkOut(Schema):
    ok: bool = True
