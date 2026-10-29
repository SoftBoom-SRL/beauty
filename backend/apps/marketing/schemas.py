from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from ninja import Field, Schema

from .codes import code_for, effective_status


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
    def resolve_code(obj, context):
        return code_for(obj, context)

    @staticmethod
    def resolve_status(obj):
        return effective_status(obj)

    @staticmethod
    def resolve_client_name(obj):
        return obj.client.full_name if obj.client else None


class CouponRedeemIn(Schema):
    sale_id: Optional[int] = None


# ---- Gift card ---------------------------------------------------------------


class GiftCardIn(Schema):
    """Carta venduta dallo staff.

    `kind`: «gift» (regalo) o «prepaid» (trattamento già pagato dalla cliente,
    che ne è acquirente e destinataria). Le sedute dei pacchetti nascono solo
    dalla vendita del pacchetto in cassa. Con `gift_service_id` il valore è il
    prezzo del servizio per `sessions` sedute, e `value` si ignora.
    """

    value: Decimal
    gift_service_id: Optional[int] = None
    buyer_client_id: Optional[int] = None
    recipient_client_id: Optional[int] = None
    recipient_name: str = ""
    paid: bool = False
    # Non più lungo della colonna `GiftCard.paid_method`: un metodo più lungo
    # arrivava al database e PostgreSQL rifiutava la riga (500). Il valore lo
    # controlla `gift_cards` sulle scelte della cassa.
    paid_method: str = Field("", max_length=20)
    delivery_date: Optional[date] = None
    expires_at: Optional[datetime] = None
    kind: str = "gift"
    # Da 1 a 100, solo con `gift_service_id` (lo controlla `gift_cards`, con
    # un messaggio che dice cosa correggere).
    sessions: int = 1
    # Credito portato dal gestionale di prima: pagata, ma senza incasso oggi.
    imported: bool = False


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
    # gift (regalo) | prepaid (già pagato dalla cliente) | package (sedute di un pacchetto)
    kind: str = "gift"
    # Sedute del trattamento: rimaste su totali. Le carte a importo sono 1/1.
    sessions_total: int = 1
    sessions_left: int = 1
    # Quanto scala dal saldo la prossima seduta (l'ultima prende il resto).
    session_value: Decimal = Decimal("0.00")
    package_id: Optional[int] = None
    package_name: Optional[str] = None

    @staticmethod
    def resolve_code(obj, context):
        return code_for(obj, context)

    @staticmethod
    def resolve_status(obj):
        return effective_status(obj)

    @staticmethod
    def resolve_buyer_name(obj):
        return obj.buyer_client.full_name if obj.buyer_client else None

    @staticmethod
    def resolve_gift_service_name(obj):
        return obj.gift_service.name_it if obj.gift_service else None

    @staticmethod
    def resolve_session_value(obj):
        return obj.session_value

    @staticmethod
    def resolve_package_name(obj):
        return obj.package.name if obj.package_id else None


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
    method: str = Field(max_length=20)  # come GiftCardIn.paid_method


class TopUpIn(Schema):
    """Ricarica di una carta a importo: quanto si carica e come lo paga la cliente."""

    amount: Decimal
    method: str = Field(max_length=20)
    receipt_issued: bool = True


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


class LoyaltyEnrollIn(Schema):
    client_id: int


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
    # Spendibile da QUESTA cliente in salone adesso (contratto C3): la stessa
    # regola di `gift_index` dell'agenda. L'app sommava nel credito anche le
    # carte da pagare e quelle comprate per un'altra persona.
    spendable: bool = False
    # Chi gliel'ha regalata: vuoto se l'ha comprata lei (un trattamento già
    # pagato, le sedute del suo pacchetto). È la regola di `from_name`
    # dell'agenda: con il solo `buyer_name` l'app scriveva «Regalo di» lei stessa.
    from_name: str = ""
    # Trattamenti già pagati: tipo, sedute rimaste su totali, valore di una
    # seduta, pacchetto da cui vengono (vedi GiftCardOut).
    kind: str = "gift"
    sessions_total: int = 1
    sessions_left: int = 1
    session_value: Decimal = Decimal("0.00")
    package_id: Optional[int] = None
    package_name: Optional[str] = None

    @staticmethod
    def resolve_gift_service_name(obj):
        return obj.gift_service.name_it if obj.gift_service_id else None

    @staticmethod
    def resolve_buyer_name(obj):
        return obj.buyer_client.full_name if obj.buyer_client_id else None

    @staticmethod
    def resolve_from_name(obj):
        return getattr(obj, "_from_name", "")

    @staticmethod
    def resolve_session_value(obj):
        return obj.session_value

    @staticmethod
    def resolve_package_name(obj):
        return obj.package.name if obj.package_id else None

    @staticmethod
    def resolve_received(obj):
        return bool(getattr(obj, "_received", False))

    @staticmethod
    def resolve_spendable(obj):
        return bool(getattr(obj, "_spendable", False))


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
