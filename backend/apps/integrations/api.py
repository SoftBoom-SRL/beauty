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
from common.permissions import require_owner, require_scope
from common.schemas import OkOut

from . import client as yc
from . import automation_key, crypto, sync, voice, webhooks
from .connection import OrgConflict, attach_tokens, link_org, reset_remote_refs
from .login import login_with_yourang
from .models import YourangConnection
from .oauth import consume_state, start_flow
from .schemas import (
    AuthorizeOut,
    AutomationKeyOut,
    ExchangeIn,
    StatusOut,
    VoiceAppointmentIn,
    VoiceCancelIn,
    VoiceRescheduleIn,
    VoiceStatusOut,
    VoiceToolsIn,
)

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
    require_scope(ctx, "integrations")
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
    # UnicodeDecodeError: un corpo che non è UTF-8 non arriva nemmeno al parser
    # JSON, e con il solo JSONDecodeError rispondeva 500 (come nel webhook delle
    # automazioni, che li prende già tutti e due)
    except (json.JSONDecodeError, UnicodeDecodeError):
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


# ---- Assistente vocale: l'agente Yourang prenota al telefono (voice.py) ------
# Le risposte all'agente sono 200 anche quando la prenotazione non riesce: vedi
# la nota in cima a voice.py.


@router.get("/voice/services", auth=voice.voice_auth)
def voice_services(request):
    """Servizi prenotabili: id, nome, categoria, durata in minuti e prezzo."""
    return voice.refused(request.auth, "list_services") or voice.services_reply(request.auth)


@router.get("/voice/availability", auth=voice.voice_auth)
def voice_availability(request, date: str = "", services: str = "", appointment_id: str = ""):
    """Orari liberi («HH:MM») in quel giorno per i servizi indicati (id separati da virgola),
    o per spostare l'appuntamento `appointment_id`.

    `times` vuoto: salone pieno o chiuso. `date_label` è la data da leggere alla cliente.
    """
    return voice.refused(request.auth, "check_availability") or voice.availability_reply(
        request.auth, date, services, appointment_id
    )


@router.post("/voice/appointments", auth=voice.voice_auth)
def voice_book(request, data: VoiceAppointmentIn):
    """Prenota per la cliente al telefono (trovata o creata dal numero).

    `success: false` con `error`: `unavailable` (orario preso, proporre
    `alternatives`) o `invalid_request` (correggere quanto dice `message`).
    """
    return voice.refused(request.auth, "create_appointment") or voice.booking_reply(request.auth, data)


@router.get("/voice/appointments", auth=voice.voice_auth)
def voice_find(request, customer_phone: str = ""):
    """Prossimi appuntamenti della cliente con quel numero (e di chi si contatta tramite lei)."""
    return voice.refused(request.auth, "find_appointments") or voice.appointments_reply(request.auth, customer_phone)


@router.post("/voice/appointments/reschedule", auth=voice.voice_auth)
def voice_reschedule(request, data: VoiceRescheduleIn):
    """Sposta un appuntamento della cliente. `error`: `unavailable` (con `alternatives`),
    `too_late` (sotto il preavviso decide il salone) o `invalid_request`."""
    return voice.refused(request.auth, "reschedule_appointment") or voice.reschedule_reply(request.auth, data)


@router.post("/voice/appointments/cancel", auth=voice.voice_auth)
def voice_cancel(request, data: VoiceCancelIn):
    """Annulla un appuntamento della cliente. `error`: `too_late` o `invalid_request`."""
    return voice.refused(request.auth, "cancel_appointment") or voice.cancel_reply(request.auth, data)


@router.get("/voice/assistant", auth=staff_auth, response=VoiceStatusOut)
def voice_status(request):
    """Se l'assistente vocale è attivo, e se il collegamento Yourang permette di attivarlo."""
    ctx = request.auth
    require_scope(ctx, "integrations")
    return voice.status(ctx.salon)


@router.post("/voice/assistant", auth=staff_auth, response=VoiceStatusOut)
def voice_install(request):
    """Attiva l'assistente vocale: installa gli strumenti di prenotazione sull'org Yourang.

    Ripeterlo reinstalla con una chiave nuova (la precedente smette di valere).
    """
    ctx = request.auth
    require_scope(ctx, "integrations")
    try:
        voice.install(ctx.salon, ctx.user)
    except voice.VoiceSetupError as exc:
        raise HttpError(409, str(exc)) from exc
    return voice.status(ctx.salon)


@router.put("/voice/assistant/tools", auth=staff_auth, response=VoiceStatusOut)
def voice_tools(request, data: VoiceToolsIn):
    """Cosa l'agente può leggere e fare. Scrivere porta con sé le letture che servono."""
    ctx = request.auth
    require_scope(ctx, "integrations")
    try:
        voice.set_tools(ctx.salon, data.tools, ctx.user)
    except voice.VoiceSetupError as exc:
        raise HttpError(409, f"Permessi salvati, ma non aggiornati su Yourang: {exc}") from exc
    return voice.status(ctx.salon)


@router.delete("/voice/assistant", auth=staff_auth, response=VoiceStatusOut)
def voice_uninstall(request):
    """Spegne l'assistente vocale: l'agente non può più leggere la disponibilità né prenotare."""
    ctx = request.auth
    require_scope(ctx, "integrations")
    voice.uninstall(ctx.salon, ctx.user)
    return voice.status(ctx.salon)


# ---- Automazioni esterne: n8n, Make, Zapier leggono l'agenda (automation_key.py)


@router.get("/automation/appointments", auth=automation_key.automation_auth)
def automation_appointments(request, start: str, end: str):
    """Appuntamenti confermati che iniziano fra `start` (incluso) ed `end` (escluso), massimo 7 giorni.

    Autenticazione: `Authorization: Bearer <chiave>` generata in Impostazioni.
    `start`/`end` in ISO (es. `2026-10-23T10:00:00Z`); senza fuso valgono nel fuso
    del salone, una data sola vale la sua mezzanotte. Per ogni appuntamento:
    cliente, `phone`, `lang`, preferenze (`whatsapp_reminders` falso = niente
    promemoria; `wa` falso = non usa WhatsApp), orari e `services` con id e nome.
    Uso tipico: ogni ora, la finestra da +24h a +25h, così ogni appuntamento
    passa una volta sola.
    """
    return automation_key.upcoming(request.auth, start, end)


@router.get("/automation/birthdays", auth=automation_key.automation_auth)
def automation_birthdays(request, date: str = None):
    """Clienti attive che compiono gli anni il giorno `date` (AAAA-MM-GG; senza, oggi nel fuso del salone).

    Stessa chiave degli appuntamenti. Per ogni cliente: `client_id`,
    `client_name`, `phone`, `lang`, `wa`, `marketing` (consenso ai messaggi
    promozionali) e `birthday` ('AAAA-MM-GG', o '--MM-GG' se l'anno non è noto).
    Il 28 febbraio degli anni non bisestili ci sono anche le nate il 29.
    Uso tipico: ogni mattina alle 9, senza parametri.
    """
    return automation_key.birthdays(request.auth, date)


@router.get("/automation/key", auth=staff_auth, response=AutomationKeyOut)
def automation_key_status(request):
    """Se la chiave per gli strumenti esterni è attiva, e da quando."""
    ctx = request.auth
    require_scope(ctx, "integrations")
    return automation_key.status(ctx.salon)


@router.post("/automation/key", auth=staff_auth, response=AutomationKeyOut)
def automation_key_rotate(request):
    """Genera la chiave e la restituisce una volta sola; la precedente smette subito di valere."""
    ctx = request.auth
    require_scope(ctx, "integrations")
    key = automation_key.rotate_key(ctx.salon, ctx.user)
    return {**automation_key.status(ctx.salon), "key": key}


@router.delete("/automation/key", auth=staff_auth, response=AutomationKeyOut)
def automation_key_revoke(request):
    """Revoca la chiave: lo strumento esterno non legge più l'agenda."""
    ctx = request.auth
    require_scope(ctx, "integrations")
    automation_key.revoke_key(ctx.salon, ctx.user)
    return automation_key.status(ctx.salon)
