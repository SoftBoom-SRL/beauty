"""Rotte integrazione Yourang: connect OAuth (PKCE), webhook in ingresso, stato.

Flusso "Collega Yourang" (come i portali food/real_estate, qui lato server Django):
  1. dashboard apre un popup su /oauth-popup/start
  2. la pagina chiama GET /oauth/start → riceve authorize_url e un nonce, che
     tiene nel sessionStorage della SUA finestra, e va su Yourang
  3. Yourang torna su /oauth-popup/done?code&state → POST /oauth/exchange,
     con il nonce
  4. exchange verifica il nonce, salva i token, registra il webhook e avvia la
     prima sync (in background)
"""

import json
import logging

from django.conf import settings
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import require_owner
from common.schemas import OkOut

from . import client as yc
from . import crypto, sync, webhooks
from .connection import OrgConflict, attach_tokens, link_org, reset_remote_refs
from .login import login_with_yourang
from .models import YourangConnection
from .oauth import consume_state, start_flow
from .schemas import AuthorizeOut, ExchangeIn, StatusOut

logger = logging.getLogger("youty.integrations")
router = Router(tags=["integrations"])


def _status_out(conn: YourangConnection | None) -> dict:
    # `last_error` anche fuori da CONNECTED: in ERROR è proprio lì che il
    # titolare deve leggere perché la sync si è fermata.
    if conn is None or conn.status != YourangConnection.Status.CONNECTED:
        return {
            "connected": False,
            "status": conn.status if conn else "disconnected",
            "last_error": conn.last_error if conn else "",
        }
    return {
        "connected": True,
        "status": conn.status,
        "connected_at": conn.connected_at,
        "last_sync_at": conn.last_sync_at,
        "scope": conn.scope,
        "yourang_org_id": conn.yourang_org_id,
        "last_error": conn.last_error,
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
    return start_flow(ctx.salon, ctx.user)


# Avvii di «Accedi con Yourang» per IP nella finestra: larghi per chi accede
# (anche riprovando dopo aver chiuso il popup, anche da una rete condivisa dal
# salone), stretti per uno script.
LOGIN_START_MAX_PER_IP = 30
LOGIN_START_WINDOW_SECONDS = 15 * 60


@router.get("/yourang/oauth/login/start", auth=None, response=AuthorizeOut)
def oauth_login_start(request):
    """Avvia il flusso "login con Yourang" (dalla pagina di login, nessuna sessione)."""
    _require_config()
    # Tetto per IP, come gli altri endpoint pubblici che scrivono: ogni avvio
    # salva una riga (lo state), e senza tetto uno script che chiamava
    # l'endpoint in ciclo riempiva la tabella. Chiave e 429 come quelli di
    # `ratelimit.enforce_public`, senza il salone, che qui non c'è ancora.
    ratelimit.enforce(
        f"public-yourang-login:{ratelimit.client_ip(request)}",
        LOGIN_START_MAX_PER_IP,
        LOGIN_START_WINDOW_SECONDS,
        "Troppe richieste: riprova tra qualche minuto",
    )
    return start_flow()  # salon/user null


@router.post("/yourang/oauth/exchange", auth=None)
def oauth_exchange(request, data: ExchangeIn):
    """Scambia il code. Lo `state` distingue i due flussi: con salone → connect;
    senza → login con Yourang (provisiona/collega + conia la sessione staff)."""
    _require_config()
    verifier, salon, user = consume_state(data)

    # --- Login con Yourang: nessun salone nello stato ---
    if salon is None:
        try:
            session = login_with_yourang(data.code, verifier)
        except OrgConflict as exc:
            raise HttpError(409, str(exc)) from exc
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
    org = yc.org_id_from_access_token(token_resp["access_token"])
    if not org:
        raise HttpError(502, "Identità Yourang senza organizzazione")

    # Un'org serve UN salone, e un salone già collegato non cambia org senza
    # prima scollegarsi: le due regole stanno in link_org, comuni al login.
    # Prima il connect riscriveva l'org anche su un salone già collegato
    # (l'anagrafica partiva verso l'org nuova, i webhook di quella vecchia
    # finivano nel nulla), e con l'org di un altro salone il vincolo unico
    # rispondeva con un 500.
    try:
        conn = link_org(salon, org, user)
    except OrgConflict as exc:
        raise HttpError(409, str(exc)) from exc
    # Il connect registra sempre il webhook: a una riconnessione il segreto di
    # prima non vale più.
    attach_tokens(conn, token_resp, renew_webhook=True)

    # La prima sync (migliaia di chiamate su un salone grande) gira fuori dalla
    # richiesta: il suo esito compare in /status (last_sync_at, last_error).
    sync.schedule_initial_sync(conn)
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
    # Via anche i riferimenti remoti: restavano appiccicati ai record locali e
    # dopo una riconnessione (org e catalogo nuovi) ogni cliente veniva saltato
    # perché "già sincronizzato" e ogni PUT catalogues/items/{id} rispondeva 404.
    reset_remote_refs(ctx.salon)
    return OkOut()


# ---- Webhook in ingresso (nessuna auth JWT: firma HMAC) ---------------------


@router.post("/yourang/webhook", auth=None, response=OkOut)
def webhook(request):
    body = request.body
    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError:
        raise HttpError(400, "Payload non valido")
    # Un corpo JSON che non è un oggetto (una lista, un numero, null) faceva
    # esplodere payload.get con un 500 su rotta pubblica, ripetibile a piacere:
    # è una richiesta malformata, e come tale va rifiutata.
    if not isinstance(payload, dict):
        raise HttpError(400, "Payload non valido")
    org_id = str(payload.get("organization_id") or "")

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
        webhooks.dispatch(conn, event_type, entity_id)
    except Exception as exc:
        # Rispondere 200 a un'elaborazione fallita dice al mittente «ricevuto»:
        # Yourang non riprova e la prenotazione importata sparisce senza che
        # nessuno se ne accorga. Con un 503 la consegna viene ritentata, e la
        # riga nel registro attività rende il problema visibile al titolare.
        logger.exception("Yourang webhook processing failed (%s)", event_type)
        log_activity(
            conn.salon,
            "integration.webhook_failed",
            f"Webhook Yourang non elaborato ({event_type or 'senza tipo'})",
            payload={
                "event_type": event_type,
                "resource_id": entity_id,
                "error": f"{type(exc).__name__}: {exc}"[:500],
            },
        )
        raise HttpError(503, "Elaborazione non riuscita: riprova")

    return OkOut()
