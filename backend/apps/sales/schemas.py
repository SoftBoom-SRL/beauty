from datetime import datetime
from decimal import Decimal
from typing import Literal, Optional

from ninja import Schema
from pydantic import Field

from apps.marketing.gift_cards import MAX_SESSIONS

# Visite in più in un conto unico: mani e piedi, magari una piega. Un tetto di
# sanità, come quelli sulle righe: nessuna cliente ne fa dieci in un giorno.
MAX_EXTRA_VISITS = 10

# ---- Input -------------------------------------------------------------------


class SaleLineIn(Schema):
    line_type: str  # service | product | gift_card | package
    service_id: Optional[int] = None
    product_id: Optional[int] = None
    # Riga «package»: il pacchetto di listino venduto. Senza prezzo vale il suo
    # prezzo di listino; crea le sedute della cliente (una carta per servizio).
    package_id: Optional[int] = None
    qty: int = Field(1, ge=1)
    unit_price: Optional[Decimal] = Field(None, ge=0)
    discount_pct: int = Field(0, ge=0, le=100)
    is_gift: bool = False
    # vendita gift card (POS): valore della card + destinatario opzionale
    value: Optional[Decimal] = Field(None, gt=0)
    recipient_name: str = ""
    # Gift card «a trattamento»: il servizio che copre e quante sedute (il
    # valore è il prezzo di tutte). `kind`: «gift» (regalo, di serie) o
    # «prepaid» (trattamento pagato in anticipo dalla cliente stessa, che ne è
    # la destinataria: serve la cliente).
    gift_service_id: Optional[int] = None
    sessions: int = Field(1, ge=1, le=MAX_SESSIONS)
    kind: Optional[str] = None


class BlockIn(Schema):
    operator_id: Optional[int] = None
    lines: list[SaleLineIn]


class PaymentIn(Schema):
    method: str  # cash | card | other | gift_card
    amount: Decimal = Field(..., ge=0)  # niente pagamenti negativi: un reso è un altro flusso
    gift_card_code: str = ""
    # Gift card a sedute (pacchetto, trattamenti già pagati): quante sedute
    # scala questo pagamento, una per riga del servizio coperta nel conto.
    sessions: int = Field(1, ge=1, le=MAX_SESSIONS)


class SaleIn(Schema):
    blocks: list[BlockIn]
    payments: list[PaymentIn]
    # Buono sconto presentato al banco: facoltativo. Vuoto = conto come prima.
    coupon_code: str = ""
    # Vero = la cliente paga ora meno del dovuto e il resto resta da saldare
    # (`Sale.amount_due`, poi POST /{id}/settle). Serve la cliente; pagare più
    # del dovuto resta un errore.
    leave_due: bool = False


class CheckoutIn(SaleIn):
    # Conto unico: altre visite della STESSA cliente nello STESSO giorno, non
    # annullate e non ancora incassate, chiuse con questa vendita. Le loro
    # righe arrivano nei blocchi come quelle della visita principale.
    extra_appointment_ids: list[int] = Field(default_factory=list, max_length=MAX_EXTRA_VISITS)


class PosIn(SaleIn):
    client_id: Optional[int] = None


class SettleIn(Schema):
    """Pagamento (anche parziale) di quanto resta da saldare su una vendita."""

    payments: list[PaymentIn] = Field(..., min_length=1)


# ---- Output ------------------------------------------------------------------


class SaleLineOut(Schema):
    id: int
    line_type: str
    operator_id: Optional[int] = None
    operator_name: str = ""
    service_id: Optional[int] = None
    service_name: str = ""
    product_id: Optional[int] = None
    product_name: str = ""
    package_id: Optional[int] = None
    package_name: str = ""
    gift_card_code: Optional[str] = None
    qty: int
    unit_price: Decimal
    discount_pct: int
    is_gift: bool
    # Già al netto della quota di buono sconto della riga (`coupon_share`).
    amount: Decimal
    coupon_share: Decimal = Decimal("0.00")


class PaymentOut(Schema):
    id: int
    method: str
    amount: Decimal
    gift_card_code: Optional[str] = None
    # Quando è arrivato il denaro: per un saldo pagato dopo è il giorno del saldo.
    created_at: Optional[datetime] = None


class SaleOut(Schema):
    id: int
    kind: str
    appointment_id: Optional[int] = None
    # Vendita-caparra: l'appuntamento di cui è l'anticipo (vedi reports.sales_history).
    deposit_appointment_id: Optional[int] = None
    client_id: Optional[int] = None
    client_name: str = ""
    location_id: Optional[int] = None
    total: Decimal
    coupon_discount: Decimal = Decimal("0.00")
    deposit_deducted: Decimal
    # Quanto la cliente deve ancora su questo conto (0 = saldato).
    amount_due: Decimal = Decimal("0.00")
    created_at: datetime


class SaleDetailOut(SaleOut):
    lines: list[SaleLineOut]
    payments: list[PaymentOut]
    # Conto unico: le altre visite chiuse con questa vendita (oltre ad `appointment_id`).
    covered_appointment_ids: list[int] = []


class OperatorBreakdownOut(Schema):
    operator_id: Optional[int] = None
    operator_name: str
    amount: Decimal


class CheckoutOut(Schema):
    sale: SaleDetailOut
    breakdown: list[OperatorBreakdownOut]


class SalesKpiOut(Schema):
    revenue: Decimal
    count: int
    items_count: int
    # Quanto resta da saldare sulle vendite del filtro corrente.
    due_total: Decimal = Decimal("0.00")


class SaleListOut(Schema):
    count: int
    kpi: SalesKpiOut
    items: list[SaleOut]


class ClientDuesOut(Schema):
    """I conti ancora da saldare di una cliente, dal più vecchio."""

    client_id: int
    amount_due: Decimal
    sales: list[SaleOut]


class TodaySummaryOut(Schema):
    total: Decimal
    count: int
    checkout_total: Decimal
    pos_total: Decimal
    gift_card_sold: Decimal = Decimal("0.00")
    # Pacchetti venduti oggi (righe «package»): sono già nel venduto.
    package_sold: Decimal = Decimal("0.00")
    gift_card_redeemed: Decimal = Decimal("0.00")
    deposit_used: Decimal = Decimal("0.00")
    # Caparre arrivate oggi: denaro in cassa, ma non venduto di oggi.
    deposit_cashed: Decimal = Decimal("0.00")
    # Caparre restituite oggi: denaro uscito, già tolto da `cash_in`.
    deposit_refunded: Decimal = Decimal("0.00")
    # Parte del venduto di oggi lasciata da saldare: non è entrata, già tolta da `cash_in`.
    due_left: Decimal = Decimal("0.00")
    # Saldi arrivati oggi per conti di giorni precedenti: entrati, già in `cash_in`.
    settled: Decimal = Decimal("0.00")
    cash_in: Decimal = Decimal("0.00")


class ChargeNoShowOut(Schema):
    ok: bool = True
    payment_intent_id: str
    amount: Decimal


class SetupIntentOut(Schema):
    setup_intent_id: str
    client_secret: Optional[str] = None


class StripeConnectStatusOut(Schema):
    available: bool           # la piattaforma ha la chiave Stripe: si può collegare
    oauth_available: bool = False  # si può collegare un account già esistente (client id OAuth)
    payments_enabled: bool    # si possono creare link di pagamento (account del salone attivo)
    # none | incomplete (dati da finire su Stripe) | pending (Stripe verifica) | active
    state: str = "none"
    connected: bool           # account attivo
    account_id: str = ""
    connected_at: Optional[datetime] = None


class StripeConnectStartIn(Schema):
    # create: il portale crea l'account e il titolare lo completa su Stripe;
    # existing: collega un account che il titolare ha già (OAuth).
    mode: Literal["create", "existing"] = "create"


class StripeConnectStartOut(Schema):
    url: str


class StripeConnectCallbackIn(Schema):
    # Solo l'OAuth torna con code e state; l'onboarding di Stripe torna senza niente.
    code: str = ""
    state: str = ""


class DepositLinkOut(Schema):
    url: str
    amount: Decimal
    due_at: Optional[datetime] = None
