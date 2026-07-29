from datetime import datetime
from typing import Optional

from ninja import Schema


class AuthorizeOut(Schema):
    authorize_url: str


class ExchangeIn(Schema):
    code: str
    state: str


class StatusOut(Schema):
    connected: bool
    status: str = "disconnected"
    connected_at: Optional[datetime] = None
    last_sync_at: Optional[datetime] = None
    scope: str = ""
    yourang_org_id: str = ""
    # Stato degli strumenti Yourang: active | no_credit | not_connected.
    # È il campo su cui l'UI decide se lasciar passare o mostrare il popup.
    feature_state: str = "not_connected"
    credit_exhausted: bool = False
    credit_exhausted_at: Optional[datetime] = None
    # Dove mandare l'utente quando lo strumento non è disponibile. Il backend le
    # serve (da settings) così cambiarle non richiede una release del frontend.
    activation_url: str = ""   # non collegato → richiesta informazioni/attivazione
    topup_url: str = ""        # collegato senza credito → ricarica sulla piattaforma


class StripeStatusOut(Schema):
    """Stato dell'account Stripe del salone (Connect Standard).

    `can_charge` è l'unico campo che conta per sapere se si può incassare ADESSO:
    un account può essere collegato ma con onboarding incompleto.
    """

    connected: bool = False
    status: str = "disconnected"
    can_charge: bool = False
    stripe_account_id: str = ""
    charges_enabled: bool = False
    payouts_enabled: bool = False
    details_submitted: bool = False
    livemode: bool = False
    connected_at: Optional[datetime] = None
    last_error: str = ""
    # False se manca STRIPE_CONNECT_CLIENT_ID: la UI lo dice invece di far
    # partire un collegamento che non può funzionare.
    configured: bool = False


class OkOut(Schema):
    ok: bool = True
