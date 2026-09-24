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
import secrets

from django.conf import settings
from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.auth import staff_auth
from common.permissions import require_owner
from common.schemas import OkOut

from . import client as yc
from . import crypto, sync
from .connection import OrgConflict, link_org, reset_remote_refs
from .login import attach_tokens, login_with_yourang
from .models import YourangConnection, YourangOAuthState
from .schemas import AuthorizeOut, ExchangeIn, StatusOut

logger = logging.getLogger("youty.integrations")
router = Router(tags=["integrations"])

STATE_TTL_SECONDS = 600


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


# ---- Chi ha chiesto questo codice? ------------------------------------------
#
# Lo `state` sta a database con il verifier PKCE, e basta a legare il codice al
# flusso. Non lega però il flusso alla FINESTRA che l'ha avviato: chi avviava un
# «Accedi con Yourang» con la propria identità poteva mandare a un altro il link
# di ritorno (/oauth-popup/done?code=…&state=…), e chi lo apriva si ritrovava
# dentro il salone di chi l'aveva mandato, a scriverci dati (10-02). L'avvio
# restituisce quindi anche un `nonce`, che il popup tiene nel sessionStorage
# della sua finestra (un link aperto altrove non ce l'ha) e rimanda
# all'exchange. È l'HMAC dello state con la chiave del server: nessuna colonna
# in più, e nessuno può ricavarlo dallo state.

NONCE_SALT = "apps.integrations.yourang-oauth-window"
_BAD_FLOW = "Richiesta di collegamento non valida: riavvia «Yourang» da questa finestra"


def _window_nonce(state: str) -> str:
    return salted_hmac(NONCE_SALT, state).hexdigest()


def _start_flow(salon=None, user=None) -> dict:
    verifier, challenge = yc.make_pkce()
    state = secrets.token_urlsafe(24)
    YourangOAuthState.objects.create(state=state, code_verifier=verifier, salon=salon, user=user)
    return {
        "authorize_url": yc.build_authorize_url(state, challenge, nonce=secrets.token_urlsafe(16)),
        "nonce": _window_nonce(state),
    }


# ---- Connect (OAuth) -------------------------------------------------------


@router.get("/yourang/oauth/start", auth=staff_auth, response=AuthorizeOut)
def oauth_start(request):
    """Avvia il flusso "connect" (dalle impostazioni, utente loggato → collega QUESTO salone)."""
    ctx = request.auth
    require_owner(ctx)
    _require_config()
    return _start_flow(ctx.salon, ctx.user)


@router.get("/yourang/oauth/login/start", auth=None, response=AuthorizeOut)
def oauth_login_start(request):
    """Avvia il flusso "login con Yourang" (dalla pagina di login, nessuna sessione)."""
    _require_config()
    return _start_flow()  # salon/user null


@router.post("/yourang/oauth/exchange", auth=None)
def oauth_exchange(request, data: ExchangeIn):
    """Scambia il code. Lo `state` distingue i due flussi: con salone → connect;
    senza → login con Yourang (provisiona/collega + conia la sessione staff)."""
    _require_config()
    # Il nonce si controlla PRIMA di consumare lo state: un link di ritorno
    # aperto in un'altra finestra non deve né usarlo né bruciarlo.
    if not data.nonce or not constant_time_compare(data.nonce, _window_nonce(data.state)):
        raise HttpError(400, _BAD_FLOW)

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
    org_id = ""
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
        if event_type == "contact.deleted":
            # Niente da fare: la scheda locale resta (storico, caparre, note) e
            # il suo contact-id non viene più usato; toglierlo farebbe
            # rispingere su Yourang, al prossimo giro, il contatto appena
            # cancellato lì. Prima qui partiva comunque la sync completa.
            pass
        elif event_type.startswith("contact") and entity_id:
            # Solo quel contatto: la sync completa (elenco + push di ogni
            # scheda non collegata) dentro ogni webhook costava migliaia di
            # chiamate a raffica. Il push resta al primo collegamento e al cron.
            sync.sync_contact(conn, entity_id)
        elif event_type.startswith("contact"):
            # Payload senza resource_id: riconciliazione completa, senza push.
            sync.sync_clients(conn, push=False)
        elif event_type == "event.deleted" and entity_id:
            # `and entity_id` come nel ramo gemello qui sotto: senza, un
            # event.deleted col campo assente arrivava a cancel_event con "" e
            # annullava l'INTERA agenda del salone in una sola UPDATE,
            # rispondendo pure 200 "ok".
            sync.cancel_event(conn, entity_id)
        elif event_type.startswith("event") and entity_id:
            sync.import_event(conn, entity_id)
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
