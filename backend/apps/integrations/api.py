"""Rotte integrazione Yourang: connect OAuth (PKCE), webhook in ingresso, stato.

Flusso "Collega Yourang" (come i portali food/real_estate, qui lato server Django):
  1. dashboard apre un popup su /oauth-popup/start
  2. la pagina chiama GET /oauth/start → riceve authorize_url e va su Yourang
  3. Yourang torna su /oauth-popup/done?code&state → POST /oauth/exchange
  4. exchange salva i token, registra il webhook e fa il primo sync
"""

import json
import logging
import secrets

from django.conf import settings
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from common.auth import staff_auth
from common.permissions import require_owner

from . import client as yc
from . import crypto, sync
from .login import WEBHOOK_EVENT_TYPES, login_with_yourang
from .models import YourangConnection, YourangOAuthState
from .schemas import AuthorizeOut, ExchangeIn, OkOut, StatusOut

logger = logging.getLogger("youty.integrations")
router = Router(tags=["integrations"])

STATE_TTL_SECONDS = 600


def _status_out(conn: YourangConnection | None) -> dict:
    if conn is None or conn.status != YourangConnection.Status.CONNECTED:
        return {"connected": False, "status": conn.status if conn else "disconnected"}
    return {
        "connected": True,
        "status": conn.status,
        "connected_at": conn.connected_at,
        "last_sync_at": conn.last_sync_at,
        "scope": conn.scope,
        "yourang_org_id": conn.yourang_org_id,
    }


def _require_config() -> None:
    if not (settings.YOURANG_ISSUER_URL and settings.YOURANG_CLIENT_ID):
        raise HttpError(503, "Integrazione Yourang non configurata")


# ---- Connect (OAuth) -------------------------------------------------------


@router.get("/yourang/oauth/start", auth=staff_auth, response=AuthorizeOut)
def oauth_start(request):
    """Avvia il flusso "connect" (dalle impostazioni, utente loggato → collega QUESTO salone)."""
    ctx = request.auth
    require_owner(ctx)
    _require_config()
    verifier, challenge = yc.make_pkce()
    state = secrets.token_urlsafe(24)
    YourangOAuthState.objects.create(
        state=state, code_verifier=verifier, salon=ctx.salon, user=ctx.user
    )
    return {"authorize_url": yc.build_authorize_url(state, challenge, nonce=secrets.token_urlsafe(16))}


@router.get("/yourang/oauth/login/start", auth=None, response=AuthorizeOut)
def oauth_login_start(request):
    """Avvia il flusso "login con Yourang" (dalla pagina di login, nessuna sessione)."""
    _require_config()
    verifier, challenge = yc.make_pkce()
    state = secrets.token_urlsafe(24)
    YourangOAuthState.objects.create(state=state, code_verifier=verifier)  # salon/user null
    return {"authorize_url": yc.build_authorize_url(state, challenge, nonce=secrets.token_urlsafe(16))}


@router.post("/yourang/oauth/exchange", auth=None)
def oauth_exchange(request, data: ExchangeIn):
    """Scambia il code. Lo `state` distingue i due flussi: con salone → connect;
    senza → login con Yourang (provisiona/collega + conia la sessione staff)."""
    _require_config()

    st = (
        YourangOAuthState.objects.select_related("salon", "user")
        .filter(state=data.state)
        .first()
    )
    if st is None:
        raise HttpError(400, "Stato OAuth non valido o scaduto")
    age = (timezone.now() - st.created_at).total_seconds()
    verifier, salon, user = st.code_verifier, st.salon, st.user
    st.delete()
    if age > STATE_TTL_SECONDS:
        raise HttpError(400, "Stato OAuth scaduto: riprova")

    # --- Login con Yourang: nessun salone nello stato ---
    if salon is None:
        try:
            session = login_with_yourang(data.code, verifier)
        except Exception as exc:
            logger.exception("Yourang login failed")
            raise HttpError(502, "Login con Yourang fallito") from exc
        return {"mode": "login", "session": session}

    # --- Connect: collega il salone esistente ---
    try:
        token_resp = yc.exchange_code(data.code, verifier)
    except Exception as exc:
        logger.exception("Yourang token exchange failed")
        raise HttpError(502, "Scambio token con Yourang fallito") from exc

    conn, _ = YourangConnection.objects.get_or_create(salon=salon)
    yc.store_tokens(conn, token_resp)
    conn.yourang_org_id = yc.org_id_from_access_token(token_resp["access_token"])
    conn.connected_by = user
    conn.status = YourangConnection.Status.CONNECTED
    conn.last_error = ""
    if settings.YOURANG_WEBHOOK_RECEIVER_URL:
        try:
            secret = yc.YourangClient(conn).register_webhook(
                settings.YOURANG_WEBHOOK_RECEIVER_URL, WEBHOOK_EVENT_TYPES
            )
            conn.webhook_secret_enc = crypto.encrypt(secret)
        except Exception:
            logger.exception("Yourang webhook registration failed")
    conn.save()

    try:
        sync.sync_clients(conn)
        sync.sync_services(conn)
        conn.last_sync_at = timezone.now()
        conn.save(update_fields=["last_sync_at"])
    except Exception as exc:
        logger.exception("Yourang initial sync failed")
        conn.last_error = str(exc)
        conn.save(update_fields=["last_error"])

    return {"mode": "connect", "status": _status_out(conn)}


@router.get("/yourang/status", auth=staff_auth, response=StatusOut)
def status(request):
    conn = YourangConnection.objects.filter(salon=request.auth.salon).first()
    return _status_out(conn)


@router.delete("/yourang/connection", auth=staff_auth, response=OkOut)
def disconnect(request):
    ctx = request.auth
    require_owner(ctx)
    YourangConnection.objects.filter(salon=ctx.salon).delete()
    return OkOut()


# ---- Webhook in ingresso (nessuna auth JWT: firma HMAC) ---------------------


@router.post("/yourang/webhook", auth=None, response=OkOut)
def webhook(request):
    body = request.body
    org_id = ""
    try:
        payload = json.loads(body) if body else {}
        org_id = str(payload.get("organization_id") or "")
    except json.JSONDecodeError:
        raise HttpError(400, "Payload non valido")

    conn = YourangConnection.objects.filter(yourang_org_id=org_id).first() if org_id else None
    if conn is None:
        return OkOut()  # org sconosciuta: ignora silenziosamente

    secret = crypto.decrypt(conn.webhook_secret_enc)
    if not crypto.verify_signature(
        body,
        request.headers.get("x-yourang-signature", ""),
        request.headers.get("x-yourang-timestamp", ""),
        secret,
    ):
        raise HttpError(401, "Firma webhook non valida")

    # Payload Yourang: notifica sottile {type, resource, resource_id, organization_id}.
    # NB: `id` è l'id della consegna webhook (random), l'evento è in `resource_id`.
    event_type = str(payload.get("type") or payload.get("event_type") or "")
    entity_id = str(payload.get("resource_id") or "")

    try:
        if event_type.startswith("contact"):
            sync.sync_clients(conn)  # riconciliazione completa (robusta al payload)
        elif event_type == "event.deleted":
            sync.cancel_event(conn, entity_id)
        elif event_type.startswith("event") and entity_id:
            sync.import_event(conn, entity_id)
    except Exception:
        logger.exception("Yourang webhook processing failed (%s)", event_type)

    return OkOut()
