"""Collegamento dell'account Stripe del salone via **Connect Standard** (OAuth2).

Perché Standard + direct charges:
  - il salone è merchant of record: il suo nome compare sull'estratto conto della
    cliente, e le dispute le gestisce lui (è lui che decide la policy no-show);
  - nessun costo per account collegato a carico della piattaforma, e Stripe si
    occupa interamente di KYC e conformità;
  - la piattaforma NON trattiene commissioni (nessuna application_fee_amount).

Il flusso ricalca quello già collaudato per Yourang: la dashboard apre un popup,
il popup ottiene l'authorize URL, Stripe torna su /oauth-popup/done?code&state e
il server scambia il code. Lo `state` è a uso singolo e scade.

Config (settings): STRIPE_SECRET_KEY, STRIPE_CONNECT_CLIENT_ID.
"""

import logging
import secrets
from urllib.parse import urlencode

from django.conf import settings
from django.utils import timezone
from ninja.errors import HttpError

from . import crypto
from .models import StripeConnection, StripeOAuthState

logger = logging.getLogger("youty.integrations")

AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize"
STATE_TTL_SECONDS = 600


def configured() -> bool:
    return bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_CONNECT_CLIENT_ID)


def _require_config() -> None:
    if not configured():
        raise HttpError(503, "Stripe Connect non configurato")


def _stripe():
    import stripe  # lazy: dipendenza opzionale a runtime

    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


def redirect_uri() -> str:
    """Pagina di ritorno dedicata: Yourang e Stripe tornano entrambi con ?code&state,
    quindi il percorso è ciò che distingue i due ritorni senza ambiguità.
    Va inserita fra i redirect URI consentiti nelle impostazioni Connect di Stripe."""
    return f"{settings.FRONTEND_ORIGIN.rstrip('/')}/oauth-popup/stripe-done"


def build_authorize_url(state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": settings.STRIPE_CONNECT_CLIENT_ID,
        "scope": "read_write",
        "redirect_uri": redirect_uri(),
        "state": state,
        # NIENTE pre-compilazioni: la maggior parte dei centri è una ditta
        # individuale, non una società. Suggerire il tipo sbagliato metterebbe
        # davanti al titolare una risposta errata che non saprebbe correggere.
        # Meglio che sia Stripe a chiedere, con le sue spiegazioni.
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def start(salon, user) -> str:
    _require_config()
    state = secrets.token_urlsafe(24)
    StripeOAuthState.objects.create(state=state, salon=salon, user=user)
    return build_authorize_url(state)


def _refresh_capabilities(conn: StripeConnection) -> StripeConnection:
    """Rilegge da Stripe se l'account può davvero incassare.

    Serve perché un account può risultare collegato ma con onboarding incompleto:
    in quel caso `charges_enabled` è False e ogni incasso fallirebbe.
    """
    try:
        account = _stripe().Account.retrieve(conn.stripe_account_id)
    except Exception as exc:  # noqa: BLE001
        conn.last_error = str(exc)
        conn.status = StripeConnection.Status.ERROR
        conn.save(update_fields=["last_error", "status", "updated_at"])
        return conn
    conn.charges_enabled = bool(account.get("charges_enabled"))
    conn.payouts_enabled = bool(account.get("payouts_enabled"))
    conn.details_submitted = bool(account.get("details_submitted"))
    conn.last_error = ""
    conn.status = StripeConnection.Status.CONNECTED
    conn.save(update_fields=[
        "charges_enabled", "payouts_enabled", "details_submitted",
        "last_error", "status", "updated_at",
    ])
    return conn


def exchange(code: str, state: str) -> StripeConnection:
    """Scambia il code OAuth e collega l'account al salone dello `state`."""
    _require_config()
    st = StripeOAuthState.objects.select_related("salon", "user").filter(state=state).first()
    if st is None:
        raise HttpError(400, "Stato OAuth non valido o scaduto")
    age = (timezone.now() - st.created_at).total_seconds()
    salon, user = st.salon, st.user
    st.delete()  # uso singolo
    if age > STATE_TTL_SECONDS:
        raise HttpError(400, "Stato OAuth scaduto: riprova")

    try:
        token = _stripe().OAuth.token(grant_type="authorization_code", code=code)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Stripe OAuth token exchange failed")
        raise HttpError(502, "Collegamento a Stripe non riuscito") from exc

    account_id = token.get("stripe_user_id") or ""
    if not account_id:
        raise HttpError(502, "Stripe non ha restituito l'account collegato")

    conn, _ = StripeConnection.objects.get_or_create(
        salon=salon, defaults={"stripe_account_id": account_id}
    )
    conn.stripe_account_id = account_id
    conn.access_token_enc = crypto.encrypt(token.get("access_token") or "")
    conn.livemode = bool(token.get("livemode"))
    conn.connected_by = user
    conn.status = StripeConnection.Status.CONNECTED
    conn.last_error = ""
    conn.save()
    return _refresh_capabilities(conn)


def refresh(salon) -> StripeConnection | None:
    conn = StripeConnection.objects.filter(salon=salon).first()
    if conn is None or not conn.stripe_account_id:
        return conn
    return _refresh_capabilities(conn)


def disconnect(salon) -> None:
    """Revoca lato Stripe (best-effort) e rimuove la connessione locale."""
    conn = StripeConnection.objects.filter(salon=salon).first()
    if conn is None:
        return
    if configured() and conn.stripe_account_id:
        try:
            _stripe().OAuth.deauthorize(
                client_id=settings.STRIPE_CONNECT_CLIENT_ID,
                stripe_user_id=conn.stripe_account_id,
            )
        except Exception:  # noqa: BLE001 — la connessione locale va rimossa comunque
            logger.exception("Stripe deauthorize failed")
    conn.delete()


def account_id_for(salon) -> str | None:
    """L'account su cui operare per questo salone, o None se non può incassare."""
    conn = StripeConnection.objects.filter(salon=salon).first()
    return conn.stripe_account_id if (conn and conn.can_charge) else None


def require_account(salon) -> str:
    """L'account del salone, o un errore che spiega cosa manca."""
    conn = StripeConnection.objects.filter(salon=salon).first()
    if conn is None or conn.status != StripeConnection.Status.CONNECTED:
        raise HttpError(412, "Account Stripe non collegato: collegalo dalle impostazioni")
    if not conn.charges_enabled:
        raise HttpError(
            412,
            "Account Stripe collegato ma non ancora abilitato agli incassi: "
            "completa la verifica su Stripe",
        )
    return conn.stripe_account_id
