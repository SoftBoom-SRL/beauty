"""Rotte integrazione Yourang: connect via proxy, webhook in ingresso, stato.

Flusso "Collega Yourang" (tutti i portali passano dal proxy connect.<brand>):
  1. dashboard apre un popup su /oauth-popup/start
  2. la pagina chiama GET /oauth/start → riceve l'URL di login sul proxy e un
     nonce, che tiene nel sessionStorage della finestra
  3. il proxy gestisce consenso e PKCE e torna su
     /oauth-popup/done?mode=…&state=…&yr_link=…
  4. exchange verifica state + nonce, riscatta il link code lato server e
     avvia la prima sync (in background)

PKCE, state verso Yourang e token sono del proxy. Lo `state` di qui è un'altra
cosa: lega il codice alla finestra (e, per il connect, al titolare) che ha
avviato il flusso.
"""

import hashlib
import hmac
import json
import logging
import secrets
import time
from urllib.parse import urlencode

from django.conf import settings
from django.core import signing
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.auth import StaffAuth, staff_auth
from common.permissions import require_owner

from . import client as yc
from . import sync
from .connection import OrgConflict, link_org, reset_remote_refs
from .login import login_with_link_code
from .models import YourangConnection
from .schemas import AuthorizeOut, ExchangeIn, OkOut, StatusOut

logger = logging.getLogger("youty.integrations")
router = Router(tags=["integrations"])

WEBHOOK_TOLERANCE_SECONDS = 300


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
        "yourang_org_id": conn.yourang_org_id,
        "last_error": conn.last_error,
    }


def _require_config() -> None:
    if not (settings.YOURANG_PROXY_URL and settings.YOURANG_PROXY_API_KEY):
        raise HttpError(503, "Integrazione Yourang non configurata")


# ---- State del flusso: chi ha chiesto questo codice? -------------------------
#
# Il codice monouso del proxy (?yr_link=) non porta nessun legame con chi ha
# avviato il flusso: /oauth-popup/done?mode=connect&yr_link=<codice di un altro>
# veniva riscattato con la sessione del titolare (localStorage) e il salone
# finiva collegato all'org dell'attaccante, anagrafica compresa; con mode=login
# la vittima si ritrovava dentro il salone dell'attaccante. Ora l'avvio conia:
#   - un `nonce` casuale, che il popup tiene nel sessionStorage della SUA
#     finestra (un link aperto altrove non ce l'ha) e rimanda all'exchange;
#   - uno `state` firmato con dentro il flusso, l'hash del nonce e, per il
#     connect, titolare e salone. Viaggia nel return_to: il guard anti
#     open-redirect del proxy confronta solo schema+host+porta, quindi la query
#     string torna intatta (è così che già viaggiava `mode`).
# Nessuna riga a database: la firma e la scadenza bastano, e il nonce ha senso
# solo nella finestra che l'ha ricevuto.

OAUTH_STATE_SALT = "apps.integrations.yourang-oauth-state"
OAUTH_STATE_MAX_AGE = 15 * 60  # secondi: consenso e login su Yourang compresi
OAUTH_MODES = ("login", "connect")
_BAD_FLOW = (
    "Richiesta di collegamento non valida: riavvia «Yourang» da questa finestra"
)


def _nonce_digest(nonce: str) -> str:
    return hashlib.sha256(nonce.encode()).hexdigest()


def _return_to(mode: str, state: str) -> str:
    """Dove il proxy rimanda il browser dopo il consenso (vi aggiunge yr_link)."""
    query = urlencode({"mode": mode, "state": state})
    return f"{settings.FRONTEND_ORIGIN.rstrip('/')}/oauth-popup/done?{query}"


def _start_flow(mode: str, ctx=None) -> dict:
    nonce = secrets.token_urlsafe(32)
    claims = {"m": mode, "n": _nonce_digest(nonce)}
    if ctx is not None:
        claims["u"] = ctx.user.pk
        claims["s"] = ctx.salon.pk
    state = signing.dumps(claims, salt=OAUTH_STATE_SALT)
    return {"authorize_url": yc.proxy_login_url(_return_to(mode, state)), "nonce": nonce}


def _check_flow(data: ExchangeIn, ctx=None) -> None:
    """400 se il codice non arriva dal flusso avviato da questa finestra/sessione.

    Si controlla PRIMA di riscattare il codice: un tentativo respinto non deve
    né consumarlo né rivelare l'identità che c'è dietro.
    """
    try:
        claims = signing.loads(data.state or "", salt=OAUTH_STATE_SALT, max_age=OAUTH_STATE_MAX_AGE)
    except signing.SignatureExpired:
        raise HttpError(400, "Collegamento con Yourang scaduto: riprova")
    except signing.BadSignature:
        raise HttpError(400, _BAD_FLOW)
    if not isinstance(claims, dict) or claims.get("m") != data.mode:
        raise HttpError(400, _BAD_FLOW)
    if not data.nonce or not hmac.compare_digest(
        str(claims.get("n") or ""), _nonce_digest(data.nonce)
    ):
        raise HttpError(400, _BAD_FLOW)
    if ctx is not None and (claims.get("u") != ctx.user.pk or claims.get("s") != ctx.salon.pk):
        # State di un altro utente o di un altro salone (anche dello stesso
        # titolare): il codice non è stato chiesto da questa sessione.
        raise HttpError(400, _BAD_FLOW)


# ---- Connect (OAuth) -------------------------------------------------------


@router.get("/yourang/oauth/start", auth=staff_auth, response=AuthorizeOut)
def oauth_start(request):
    """Avvia il flusso "connect" (dalle impostazioni, utente loggato)."""
    require_owner(request.auth)
    _require_config()
    return _start_flow("connect", request.auth)


@router.get("/yourang/oauth/login/start", auth=None, response=AuthorizeOut)
def oauth_login_start(request):
    """Avvia il flusso "login con Yourang" (dalla pagina di login, nessuna sessione)."""
    _require_config()
    return _start_flow("login")


@router.post("/yourang/oauth/exchange", auth=None)
def oauth_exchange(request, data: ExchangeIn):
    """Riscatta il link code del flusso `mode`, verificato con state + nonce.

    connect → collega il salone della sessione staff corrente;
    login   → provisiona/collega salone+utente e conia la sessione staff.
    """
    _require_config()
    if data.mode not in OAUTH_MODES:
        raise HttpError(400, _BAD_FLOW)

    if data.mode == "login":
        _check_flow(data)
        try:
            session = login_with_link_code(data.code)
        except Exception as exc:
            logger.exception("Yourang login failed")
            raise HttpError(502, "Login con Yourang fallito") from exc
        return {"mode": "login", "session": session}

    # --- Connect: serve una sessione staff, e solo il titolare può collegare ---
    ctx = StaffAuth()(request)
    if not ctx:
        raise HttpError(401, "Sessione staff richiesta")
    require_owner(ctx)
    _check_flow(data, ctx)

    try:
        identity = yc.redeem_link_code(data.code)
    except Exception as exc:
        logger.exception("Yourang link code redemption failed")
        raise HttpError(502, "Collegamento con Yourang fallito") from exc

    org = str(identity.get("org_id") or "")
    if not org:
        raise HttpError(502, "Identità Yourang senza organizzazione")

    # Un'org serve UN salone, e un salone già collegato non cambia org senza
    # prima scollegarsi: le due regole stanno in link_org, comuni al login.
    try:
        conn = link_org(ctx.salon, org, ctx.user)
    except OrgConflict as exc:
        raise HttpError(409, str(exc)) from exc

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


def _verify_webhook(body: bytes, signature_header: str, timestamp: str) -> bool:
    """HMAC-SHA256 su "{timestamp}.{body}", come firma il proxy.

    Il segreto è ora uno solo per portale (quello che il proxy usa per la sua
    ri-emissione), non più uno per salone: il proxy verifica la firma della
    piattaforma e ri-firma con il proprio. Fail-closed se non configurato —
    questa rotta è pubblica.
    """
    secret = settings.YOURANG_PROXY_WEBHOOK_SECRET
    if not secret or not signature_header or not timestamp:
        return False
    # compare_digest alza TypeError se una delle due stringhe non è ASCII: un
    # header con un byte ≥ 0x80 diventava un 500 su una rotta pubblica (e un
    # 500 ripetibile è già di per sé una leva). Firma non ASCII = firma sbagliata.
    if not signature_header.isascii():
        return False
    try:
        if abs(time.time() - int(timestamp)) > WEBHOOK_TOLERANCE_SECONDS:
            return False
    except ValueError:
        return False
    expected = hmac.new(
        secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature_header)


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

    # La firma si verifica PRIMA di toccare il DB: /yourang/webhook è pubblica,
    # e l'org nel payload non è attendibile finché la firma non lo rende tale.
    if not _verify_webhook(
        body,
        request.headers.get("x-yourang-signature", ""),
        request.headers.get("x-yourang-timestamp", ""),
    ):
        raise HttpError(401, "Firma webhook non valida")

    conn = YourangConnection.objects.filter(yourang_org_id=org_id).first() if org_id else None
    if conn is None:
        return OkOut()  # org sconosciuta: ignora silenziosamente

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
            # event.deleted col campo assente (o rinominato ancora dal proxy)
            # arrivava a cancel_event con "" e annullava l'INTERA agenda del
            # salone in una sola UPDATE, rispondendo pure 200 "ok".
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
