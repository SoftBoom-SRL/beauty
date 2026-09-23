from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from ninja import Schema


class OkOut(Schema):
    ok: bool = True


# ---- Coupon ------------------------------------------------------------------


class CouponIn(Schema):
    client_id: Optional[int] = None
    kind: str  # percent | amount
    value: Decimal
    expires_at: Optional[datetime] = None


class CouponOut(Schema):
    id: int
    code: str
    kind: str
    value: Decimal
    origin: str
    status: str
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    sale_id: Optional[int] = None
    expires_at: Optional[datetime] = None
    redeemed_at: Optional[datetime] = None
    created_at: datetime

    @staticmethod
    def resolve_client_name(obj):
        return obj.client.full_name if obj.client else None


class CouponRedeemIn(Schema):
    sale_id: Optional[int] = None


# ---- Gift card ---------------------------------------------------------------


class GiftCardIn(Schema):
    value: Decimal
    gift_service_id: Optional[int] = None
    buyer_client_id: Optional[int] = None
    recipient_client_id: Optional[int] = None
    recipient_name: str = ""
    paid: bool = False
    paid_method: str = ""
    delivery_date: Optional[date] = None
    expires_at: Optional[datetime] = None


class GiftCardOut(Schema):
    id: int
    code: str
    initial_value: Decimal
    balance: Decimal
    gift_service_id: Optional[int] = None
    gift_service_name: Optional[str] = None
    buyer_client_id: Optional[int] = None
    buyer_name: Optional[str] = None
    recipient_client_id: Optional[int] = None
    recipient_name: str
    payment_status: str
    paid_at: Optional[datetime] = None
    paid_method: str
    delivery_date: Optional[date] = None
    expires_at: Optional[datetime] = None
    status: str
    created_at: datetime

    @staticmethod
    def resolve_buyer_name(obj):
        return obj.buyer_client.full_name if obj.buyer_client else None

    @staticmethod
    def resolve_gift_service_name(obj):
        return obj.gift_service.name_it if obj.gift_service else None


class GiftCardKpiOut(Schema):
    sold_total: Decimal
    redeemed_total: Decimal
    outstanding: Decimal


class GiftCardListOut(Schema):
    kpi: GiftCardKpiOut
    # Quante carte corrispondono al filtro: `items` è una pagina, i KPI no.
    total: int = 0
    items: list[GiftCardOut]


class MarkPaidIn(Schema):
    method: str


# ---- Fedeltà -----------------------------------------------------------------


class LoyaltyProgramIn(Schema):
    name: str
    type: str = "points"
    earn_metric: str = "per_euro"
    earn_ratio: Decimal = Decimal("1")
    reward_type: str = "coupon_amount"
    reward_value: Decimal = Decimal("0")
    reward_service_id: Optional[int] = None
    threshold: int
    enrollment: str = "auto"
    points_expiry_months: int = 0
    bonus: dict = {}
    color: str = "#6366F1"
    active: bool = True


class LoyaltyProgramOut(Schema):
    id: int
    name: str
    type: str
    earn_metric: str
    earn_ratio: Decimal
    reward_type: str
    reward_value: Decimal
    reward_service_id: Optional[int] = None
    threshold: int
    enrollment: str
    points_expiry_months: int
    bonus: dict
    color: str
    active: bool
    accounts_count: int = 0

    @staticmethod
    def resolve_accounts_count(obj):
        # L'elenco annota il conteggio nella query principale; quando manca
        # (creazione/modifica del singolo programma) si ricade sul COUNT.
        annotated = getattr(obj, "accounts_count", None)
        return annotated if annotated is not None else obj.accounts.count()


class LoyaltyAccountOut(Schema):
    id: int
    client_id: int
    client_name: str
    points: int
    joined_at: datetime

    @staticmethod
    def resolve_client_name(obj):
        return obj.client.full_name


# ---- Comunicazioni -----------------------------------------------------------


class CommunicationIn(Schema):
    title: str
    body: str
    cta_label: str = ""
    cta_url: str = ""
    audience_type: str = "labels"
    audience: list[int] = []
    scheduled_at: Optional[datetime] = None


class CommunicationOut(Schema):
    id: int
    title: str
    body: str
    image_url: Optional[str] = None
    cta_label: str
    cta_url: str
    audience_type: str
    audience: list[int]
    status: str
    scheduled_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    created_at: datetime

    @staticmethod
    def resolve_image_url(obj):
        return obj.image.url if obj.image else None


class CommunicationSendIn(Schema):
    scheduled_at: Optional[datetime] = None


# ---- Wallet cliente ----------------------------------------------------------


class WalletGiftCardOut(Schema):
    id: int
    code: str
    initial_value: Decimal
    balance: Decimal
    recipient_name: str
    expires_at: Optional[datetime] = None
    payment_status: str = "paid"
    # Carta "a trattamento": il servizio regalato (None = carta monetaria).
    gift_service_id: Optional[int] = None
    gift_service_name: Optional[str] = None
    # Chi l'ha regalata / ricevuta, per mostrarlo nel wallet.
    buyer_name: Optional[str] = None
    received: bool = False

    @staticmethod
    def resolve_gift_service_name(obj):
        return obj.gift_service.name_it if obj.gift_service_id else None

    @staticmethod
    def resolve_buyer_name(obj):
        return obj.buyer_client.full_name if obj.buyer_client_id else None

    @staticmethod
    def resolve_received(obj):
        return bool(getattr(obj, "_received", False))


class WalletCouponOut(Schema):
    id: int
    code: str
    kind: str
    value: Decimal
    origin: str
    expires_at: Optional[datetime] = None


class WalletLoyaltyOut(Schema):
    program_id: int
    program_name: str
    type: str
    color: str
    points: int
    threshold: int
    progress_pct: int


class WalletOut(Schema):
    gift_cards: list[WalletGiftCardOut]
    coupons: list[WalletCouponOut]
    loyalty: list[WalletLoyaltyOut]


class ClientGiftCardIn(Schema):
    value: Decimal
    recipient_name: str = ""


class MarketingConsentIn(Schema):
    """True = do il consenso, False = lo revoco (GDPR art. 7.3)."""

    accepted: bool
