"""Automazioni che inviano un modello WhatsApp approvato su Yourang.

Fino a qui un'automazione era solo una regola: youty la mandava a Yourang
(`automation.updated`), ma dall'altra parte nessuno la eseguiva, e il salone
non aveva modo di scegliere quale messaggio partisse. Ora la regola porta il
modello (nome, lingua) e i campi di youty che ne riempiono i valori; il giro
`run` (comando `run_automations`, ogni 5 minuti) trova gli appuntamenti per cui
è il momento e invia il modello con l'API pubblica di Yourang, a nome del
salone (token OAuth della connessione, scope `whatsapp:write`).

Un messaggio per cliente e occasione: lo garantisce `AutomationSend`. Un
appuntamento annullato o spostato prima dell'invio non riceve il promemoria
vecchio, perché lo stato e l'orario si rileggono al momento di inviare.
"""

import datetime as dt
import logging

import httpx
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from .models import Automation, AutomationSend

logger = logging.getLogger("youty.automations")


# Campi di youty che riempiono i valori di un modello: chiave → (it, en).
# Sono tutti dell'appuntamento o della cliente: gli eventi che inviano sono
# quelli dell'appuntamento (SENDING_EVENTS).
PARAMETER_FIELDS = {
    "first_name": ("Nome cliente", "Client first name"),
    "full_name": ("Nome e cognome cliente", "Client full name"),
    "date": ("Data appuntamento", "Appointment date"),
    "time": ("Ora appuntamento", "Appointment time"),
    "services": ("Servizi", "Services"),
    "operator": ("Operatrice", "Operator"),
    "salon": ("Nome del salone", "Salon name"),
}

# Gli eventi per cui l'invio esiste. Gli altri restano regole senza modello:
# l'API rifiuta un modello su un evento che il giro non saprebbe eseguire,
# così il titolare non vede attiva un'automazione che non manda niente.
SENDING_EVENTS = (
    Automation.Event.APPOINTMENT_CREATED,
    Automation.Event.APPOINTMENT_UPCOMING,
    Automation.Event.VISIT_COMPLETED,
)

# Quanto indietro si recupera un invio che è già l'ora di fare: un giro
# saltato (deploy, riavvio) non perde i messaggi, ma un promemoria non parte
# ore dopo l'appuntamento. Il ringraziamento dopo la visita parte dalla
# visita CHIUSA, e al banco la si chiude spesso a fine giornata.
LOOKBACK = {
    Automation.Event.APPOINTMENT_CREATED: dt.timedelta(hours=2),
    Automation.Event.APPOINTMENT_UPCOMING: dt.timedelta(hours=2),
    Automation.Event.VISIT_COMPLETED: dt.timedelta(hours=24),
}
MAX_ATTEMPTS = 3


class TemplatesUnavailable(Exception):
    """I modelli non si possono leggere: il messaggio è per il titolare."""


# ---- Connessione e modelli ----------------------------------------------------


def _connection(salon):
    from apps.integrations.models import YourangConnection  # lazy: integrations importa automations

    return YourangConnection.objects.filter(
        salon=salon, status=YourangConnection.Status.CONNECTED
    ).first()


def can_send(conn) -> bool:
    return conn is not None and "whatsapp:write" in (conn.scope or "").split()


def connection_state(salon) -> str:
    """`ok`, `not_connected`, `needs_reconnect` (collegato prima degli scope
    WhatsApp) o `unavailable` (scope non ancora abilitati su questo server)."""
    if not settings.YOURANG_WHATSAPP_SCOPES:
        return "unavailable"
    conn = _connection(salon)
    if conn is None:
        return "not_connected"
    return "ok" if can_send(conn) else "needs_reconnect"


def available_templates(salon) -> list[dict]:
    """I modelli approvati che l'API sa riempire, come li descrive Yourang."""
    from apps.integrations.client import YourangClient  # lazy

    state = connection_state(salon)
    if state != "ok":
        raise TemplatesUnavailable(state)
    try:
        rows = YourangClient(_connection(salon)).list_whatsapp_templates()
    except (httpx.HTTPError, RuntimeError) as exc:
        logger.warning("Modelli WhatsApp non letti per il salone %s: %s", salon.id, exc)
        raise TemplatesUnavailable("yourang_error") from exc
    return [row for row in rows if row.get("api_sendable", True)]


def apply_template(salon, payload: dict) -> str | None:
    """Controlla il modello scelto e completa `payload`; None se va bene, sennò l'errore.

    Senza modello azzera i campi del modello. Con il modello, lo cerca fra
    quelli approvati: un nome sbagliato o un numero di valori diverso da quello
    del modello partiva comunque e WhatsApp lo rifiutava, cliente per cliente.
    """
    name = str(payload.get("template_name") or "").strip()
    if not name:
        payload.update(
            template_name="", template_language="", template_category="",
            template_parameters=[], message_preview="",
        )
        return None
    if payload.get("event") not in SENDING_EVENTS:
        return "Il messaggio WhatsApp si può inviare solo per gli eventi dell'appuntamento"
    fields = payload.get("template_parameters") or []
    if not isinstance(fields, list) or any(f not in PARAMETER_FIELDS for f in fields):
        return "Valori del messaggio non validi"
    language = str(payload.get("template_language") or "").strip()
    try:
        templates = available_templates(salon)
    except TemplatesUnavailable:
        return "Impossibile leggere i modelli WhatsApp da Yourang: riprova tra poco"
    template = next(
        (t for t in templates if t.get("name") == name and t.get("language") == language), None
    )
    if template is None:
        return "Modello WhatsApp non trovato fra quelli approvati su Yourang"
    if len(fields) != len(template.get("parameters") or []):
        return "Ogni valore del modello deve avere un campo"
    payload.update(
        template_name=name,
        template_language=language,
        template_category=str(template.get("category") or ""),
        template_parameters=fields,
        message_preview=str(template.get("body") or ""),
    )
    return None


# ---- Quando inviare -----------------------------------------------------------


def _signed_offset(automation: Automation) -> dt.timedelta:
    offset = dt.timedelta(**{automation.offset_unit: automation.offset_value})
    return -offset if automation.offset_direction == Automation.OffsetDirection.BEFORE else offset


def due_at(automation: Automation, appointment) -> dt.datetime:
    """L'istante in cui l'automazione scatta per questo appuntamento."""
    anchor = {
        Automation.Event.APPOINTMENT_CREATED: appointment.created_at,
        Automation.Event.APPOINTMENT_UPCOMING: appointment.start,
        Automation.Event.VISIT_COMPLETED: appointment.end,
    }[automation.event]
    due = anchor + _signed_offset(automation)
    if automation.send_time:
        # «alle 10»: la prima volta che sono le 10 da quell'istante in poi,
        # nel fuso del salone.
        local = timezone.localtime(due)
        at = local.replace(
            hour=automation.send_time.hour, minute=automation.send_time.minute,
            second=0, microsecond=0,
        )
        due = at if at >= local else at + dt.timedelta(days=1)
    return due


def _candidates(automation: Automation, now: dt.datetime):
    """Appuntamenti per cui l'automazione può scattare ora (finestra larga, poi `due_at`)."""
    from apps.agenda.models import Appointment  # lazy

    lookback = LOOKBACK[automation.event]
    delta = _signed_offset(automation)
    slack = dt.timedelta(days=1)  # orario fisso (`send_time`) e durata della visita
    lo, hi = now - lookback - delta - slack, now - delta
    qs = Appointment.objects.filter(
        salon_id=automation.salon_id, removed_from_agenda_at__isnull=True
    ).select_related("client", "operator", "salon")
    if automation.event == Automation.Event.APPOINTMENT_CREATED:
        qs = qs.filter(created_at__range=(lo, hi)).exclude(status__in=Appointment.INACTIVE_STATUSES)
    elif automation.event == Automation.Event.APPOINTMENT_UPCOMING:
        qs = qs.filter(start__range=(lo, hi + slack), status__in=Appointment.OPEN_STATUSES)
    else:
        qs = qs.filter(start__range=(lo - slack, hi), status=Appointment.Status.CLOSED)
    # Mai prima che l'automazione esistesse: crearne una non deve scrivere
    # alle clienti delle ore passate.
    since = max(now - lookback, automation.created_at)
    for appointment in qs:
        if since <= due_at(automation, appointment) <= now:
            yield appointment


def send_key(automation: Automation, appointment) -> str:
    if automation.event == Automation.Event.APPOINTMENT_UPCOMING:
        # L'orario fa parte dell'occasione: spostato l'appuntamento, il
        # promemoria del nuovo orario è un altro messaggio.
        return f"appt:{appointment.id}:{appointment.start:%Y%m%d%H%M}"
    return f"appt:{appointment.id}"


# ---- Chi lo riceve e con che valori ------------------------------------------


def skip_reason(automation: Automation, client) -> str:
    """Perché questa cliente non deve ricevere il messaggio ("" = la riceve)."""
    from apps.clients.services import client_facts  # lazy
    from common.conditions import evaluate
    from common.phone import is_real_number, normalize_phone

    if not client.is_active:
        return "cliente archiviata"
    phone = normalize_phone(client.phone or "")
    if not client.wa or not phone or not is_real_number(phone):
        return "nessun numero WhatsApp"
    if not client.whatsapp_reminders:
        return "messaggi WhatsApp disattivati dalla cliente"
    if automation.template_category == "MARKETING" and not (client.consents or {}).get("marketing"):
        return "nessun consenso marketing"
    if not evaluate(automation.conditions, client_facts(client)):
        return "condizioni non soddisfatte"
    return ""


def parameter_values(automation: Automation, appointment) -> list[str]:
    client = appointment.client
    english = client.lang == "en"
    start = timezone.localtime(appointment.start)
    items = appointment.items.select_related("service").order_by("order")
    services = ", ".join(
        dict.fromkeys(
            (item.service.name_en if english and item.service.name_en else item.service.name_it)
            for item in items
        )
    )
    values = {
        "first_name": client.first_name,
        "full_name": f"{client.first_name} {client.last_name}".strip(),
        "date": f"{start:%d/%m/%Y}",
        "time": f"{start:%H:%M}",
        "services": services,
        "operator": appointment.operator.first_name,
        "salon": appointment.salon.name,
    }
    # WhatsApp rifiuta un valore vuoto: un trattino è meglio di nessun messaggio.
    return [values.get(field) or "-" for field in automation.template_parameters]


# ---- Il giro -----------------------------------------------------------------


def _claim(automation: Automation, appointment, key: str) -> AutomationSend | None:
    """La riga di questo invio, presa in carico; None se è già fatto o di un altro giro."""
    try:
        # Il savepoint tiene in piedi la transazione intorno quando la riga c'è già.
        with transaction.atomic():
            return AutomationSend.objects.create(
                automation=automation, client=appointment.client, appointment=appointment, key=key,
            )
    except IntegrityError:
        pass
    send = AutomationSend.objects.filter(automation=automation, key=key).first()
    if send is None or send.status != AutomationSend.Status.FAILED or send.attempts >= MAX_ATTEMPTS:
        return None
    # Ritento: chi aggiorna la riga da «fallito» a «in invio» la prende.
    claimed = AutomationSend.objects.filter(
        pk=send.pk, status=AutomationSend.Status.FAILED
    ).update(status=AutomationSend.Status.SENDING)
    return send if claimed else None


def _error_text(exc: Exception) -> tuple[str, bool]:
    """(testo dell'errore, si può ritentare?)."""
    if isinstance(exc, httpx.HTTPStatusError):
        response = exc.response
        try:
            details = (response.json().get("error") or {}).get("details") or {}
        except ValueError:
            details = {}
        reason = details.get("reason") or f"HTTP {response.status_code}"
        # Un 4xx (modello rifiutato, numero non valido…) non cambia ritentando,
        # tranne il limite di frequenza.
        return reason, response.status_code >= 500 or response.status_code == 429
    return str(exc) or exc.__class__.__name__, True


def _send(client_api, automation: Automation, appointment, send: AutomationSend) -> None:
    from apps.core.services import log_activity  # lazy
    from common.phone import normalize_phone

    send.attempts += 1
    reason = skip_reason(automation, appointment.client)
    if reason:
        send.status, send.error = AutomationSend.Status.SKIPPED, reason
        send.save(update_fields=["status", "error", "attempts", "updated_at"])
        return
    try:
        client_api.send_whatsapp_template(
            normalize_phone(appointment.client.phone),
            automation.template_name,
            automation.template_language,
            parameter_values(automation, appointment),
            idempotency_key=f"youty-automation-send-{send.pk}",
        )
    except (httpx.HTTPError, RuntimeError) as exc:
        error, retry = _error_text(exc)
        send.status, send.error = AutomationSend.Status.FAILED, error[:300]
        if not retry:
            send.attempts = MAX_ATTEMPTS
        send.save(update_fields=["status", "error", "attempts", "updated_at"])
        if send.attempts >= MAX_ATTEMPTS:
            log_activity(
                automation.salon,
                "automation.send_failed",
                f"WhatsApp non inviato ({automation.name}) a {appointment.client.first_name}: {error}"[:255],
                payload={"automation_id": automation.id, "appointment_id": appointment.id},
            )
        return
    send.status, send.error = AutomationSend.Status.SENT, ""
    send.save(update_fields=["status", "error", "attempts", "updated_at"])


def run(now: dt.datetime | None = None) -> dict:
    """Invia i messaggi di cui è l'ora, per tutte le automazioni attive con un modello."""
    from apps.integrations.client import YourangClient  # lazy

    now = now or timezone.now()
    counts = {"sent": 0, "failed": 0, "skipped": 0}
    automations = (
        Automation.objects.filter(active=True, event__in=SENDING_EVENTS)
        .exclude(template_name="")
        .select_related("salon")
    )
    for automation in automations:
        conn = _connection(automation.salon)
        if not can_send(conn):
            continue
        with YourangClient(conn) as client_api:
            for appointment in _candidates(automation, now):
                send = _claim(automation, appointment, send_key(automation, appointment))
                if send is None:
                    continue
                try:
                    _send(client_api, automation, appointment, send)
                except Exception:  # noqa: BLE001 - una cliente non deve fermare il giro
                    logger.exception("Invio automazione %s non riuscito", automation.id)
                    AutomationSend.objects.filter(pk=send.pk).update(
                        status=AutomationSend.Status.FAILED, attempts=MAX_ATTEMPTS,
                        error="errore interno",
                    )
                    counts["failed"] += 1
                    continue
                counts[send.status] += 1
    return counts
