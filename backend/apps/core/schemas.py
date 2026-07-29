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
    agenda_fill: str
    slot_recovery: str
    slot_interval_min: int
    lastminute_discount_cap: int
    lastminute_monthly_budget: Decimal
    flexible_enabled: bool
    flexible_window_min: int
    flexible_reward_pct: int
    # Soglia (ore) sotto la quale una cancellazione è "tardiva" → caparra trattenuta.
    # Derivata da settings.CLIENT_MOVE_CANCEL_MIN_HOURS, sola lettura.
    cancel_min_hours: int
    # Fuso orario del salone (IANA). La matematica degli slot lato server è
    # ora-locale-salone: il frontend DEVE rendere gli orari in questo fuso, non in
    # quello del browser. Derivato da settings.TIME_ZONE, sola lettura.
    timezone: str
    # Policy pagamenti (Stripe). Due automatismi distinti: "prima" = scadenza
    # caparra, "dopo" = mancata presentazione. Configurabili per salone.
    deposit_enabled: bool = True
    deposit_deadline_hours: int = 0
    deposit_deadline_action: str = "none"
    noshow_charge_mode: str = "manual"
    noshow_charge_delay_min: int = 30
    noshow_charge_pct: int = 100
    late_cancel_charge_pct: int = 0


class SettingsIn(Schema):
    default_lang: Optional[str] = None
    brand_color: Optional[str] = None
    opening_hours: Optional[str] = None
    agenda_fill: Optional[str] = None
    slot_recovery: Optional[str] = None
    slot_interval_min: Optional[int] = None
    lastminute_discount_cap: Optional[int] = None
    lastminute_monthly_budget: Optional[Decimal] = None
    flexible_enabled: Optional[bool] = None
    flexible_window_min: Optional[int] = None
    flexible_reward_pct: Optional[int] = None
    # Policy pagamenti: "prima" governa la caparra, "dopo" il no-show.
    deposit_enabled: Optional[bool] = None
    deposit_deadline_hours: Optional[int] = None
    deposit_deadline_action: Optional[str] = None
    noshow_charge_mode: Optional[str] = None
    noshow_charge_delay_min: Optional[int] = None
    noshow_charge_pct: Optional[int] = None
    late_cancel_charge_pct: Optional[int] = None


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


class PublicBrandingOut(Schema):
    name: str
    slug: str
    default_lang: str
    logo_url: Optional[str] = None
    brand_color: str
    address: str = ""
    phone: str = ""
    opening_hours: str = ""
    # Fuso del salone: l'app cliente lo legge prima del login per rendere gli
    # orari di prenotazione nell'ora del salone e non in quella del dispositivo.
    timezone: str = ""


class OkOut(Schema):
    ok: bool = True
