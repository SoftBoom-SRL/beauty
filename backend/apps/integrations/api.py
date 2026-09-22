"""Rotte integrazione Yourang: connect via proxy, webhook in ingresso, stato.

Flusso "Collega Yourang" (tutti i portali passano dal proxy connect.<brand>):
  1. dashboard apre un popup su /oauth-popup/start
  2. la pagina chiama GET /oauth/start → riceve l'URL di login sul proxy
  3. il proxy gestisce consenso e PKCE e torna su /oauth-popup/done?yr_link=…
  4. exchange riscatta il link code lato server e fa il primo sync

Niente PKCE, niente state, niente token da queste parti: sono tutti nel proxy.
"""

import hashlib
import hmac
import json
import logging
import time

from django.apps import apps as django_apps
from django.conf import settings
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.auth import StaffAuth, staff_auth
from common.permissions import require_owner

from . import client as yc
from . import sync
from .login import login_with_link_code
from .models import YourangConnection
from .schemas import AuthorizeOut, ExchangeIn, OkOut, StatusOut

logger = logging.getLogger("youty.integrations")
router = Router(tags=["integrations"])

WEBHOOK_TOLERANCE_SECONDS = 300


def _status_out(conn: YourangConnection | None) -> dict:
    if conn is None or conn.status != YourangConnection.Status.CONNECTED:
        return {"connected": False, "status": conn.status if conn else "disconnected"}
    return {
        "connected": True,
        "status": conn.status,
        "connected_at": conn.connected_at,
        "last_sync_at": conn.last_sync_at,
        "yourang_org_id": conn.yourang_org_id,
    }


def _first_sync_error(errors: list[str]) -> str:
    """Riassunto degli errori di sync da mostrare al titolare ("" se tutto bene)."""
    if not errors:
        return ""
    head = "; ".join(errors[:3])
    more = f" (+{len(errors) - 3} altri)" if len(errors) > 3 else ""
    return f"Sincronizzazione parziale: {head}{more}"[:500]


def _require_config() -> None:
    if not (settings.YOURANG_PROXY_URL and settings.YOURANG_PROXY_API_KEY):
        raise HttpError(503, "Integrazione Yourang non configurata")


def _return_to(mode: str) -> str:
    """Dove il proxy rimanda il browser dopo il consenso (vi aggiunge ?yr_link=).

    Il `mode` viaggia qui perché non esiste più una riga di stato lato nostro a
    ricordarlo: il proxy possiede PKCE e state, e il guard sull'open-redirect
    confronta solo schema+host+porta, quindi una query string passa intatta.
    """
    return f"{settings.FRONTEND_ORIGIN.rstrip('/')}/oauth-popup/done?mode={mode}"


# ---- Connect (OAuth) -------------------------------------------------------


@router.get("/yourang/oauth/start", auth=staff_auth, response=AuthorizeOut)
def oauth_start(request):
    """Avvia il flusso "connect" (dalle impostazioni, utente loggato)."""
    require_owner(request.auth)
    _require_config()
    return {"authorize_url": yc.proxy_login_url(_return_to("connect"))}


@router.get("/yourang/oauth/login/start", auth=None, response=AuthorizeOut)
def oauth_login_start(request):
    """Avvia il flusso "login con Yourang" (dalla pagina di login, nessuna sessione)."""
    _require_config()
    return {"authorize_url": yc.proxy_login_url(_return_to("login"))}


@router.post("/yourang/oauth/exchange", auth=None)
def oauth_exchange(request, data: ExchangeIn):
    """Riscatta il link code. `mode` distingue i due flussi (lo state non esiste
    più lato nostro: PKCE e state vivono nel proxy).

    connect → collega il salone della sessione staff corrente;
    login   → provisiona/collega salone+utente e conia la sessione staff.
    """
    _require_config()

    if data.mode == "login":
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

    try:
        identity = yc.redeem_link_code(data.code)
    except Exception as exc:
        logger.exception("Yourang link code redemption failed")
        raise HttpError(502, "Collegamento con Yourang fallito") from exc

    org = str(identity.get("org_id") or "")
    if not org:
        raise HttpError(502, "Identità Yourang senza organizzazione")

    # Un'org serve UN salone: se è già altrove, collegarla qui spezzerebbe
    # silenziosamente l'altro (il webhook risolve il salone dall'org).
    taken = YourangConnection.objects.filter(yourang_org_id=org).exclude(salon=ctx.salon).first()
    if taken:
        raise HttpError(409, "Questa organizzazione Yourang è già collegata a un altro salone")

    conn, _ = YourangConnection.objects.get_or_create(salon=ctx.salon)
    conn.yourang_org_id = org
    conn.connected_by = ctx.user
    conn.status = YourangConnection.Status.CONNECTED
    conn.last_error = ""
    conn.save()

    try:
        clients = sync.sync_clients(conn)
        services = sync.sync_services(conn)
        conn.last_sync_at = timezone.now()
        # Gli errori della prima sync venivano buttati via: la dashboard diceva
        # "Connesso" mentre su Yourang non era arrivato nulla. Restano scritti
        # sulla connessione, che è ciò che il titolare vede.
        conn.last_error = _first_sync_error(clients.errors + services.errors)
        conn.save(update_fields=["last_sync_at", "last_error"])
    except Exception as exc:
        logger.exception("Yourang initial sync failed")
        conn.last_error = str(exc)[:500]
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
    # Via anche i riferimenti remoti: restavano appiccicati ai record locali e
    # dopo una riconnessione (org e catalogo nuovi) ogni cliente veniva saltato
    # perché "già sincronizzato" e ogni PUT catalogues/items/{id} rispondeva 404,
    # cioè il listino non arrivava MAI nel catalogo nuovo. I modelli sono di
    # altre app: accesso lazy, come altrove nel progetto.
    django_apps.get_model("clients", "Client").objects.filter(salon=ctx.salon).exclude(
        yourang_contact_id=""
    ).update(yourang_contact_id="")
    for model_name in ("Service", "Package"):
        django_apps.get_model("catalog", model_name).objects.filter(
            salon=ctx.salon
        ).exclude(yourang_item_id="").update(yourang_item_id="")
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
        if event_type.startswith("contact"):
            sync.sync_clients(conn)  # riconciliazione completa (robusta al payload)
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
