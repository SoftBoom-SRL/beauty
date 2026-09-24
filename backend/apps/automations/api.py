import json
import uuid as uuid_lib

from django.db import transaction
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import has_scope, require_scope
from common.schemas import OkOut
from common.utils import salon_get

from .models import Automation
from .schemas import (
    AutomationIn,
    AutomationOut,
    EventsCatalogOut,
    WebhookTriggerOut,
)

router = Router(tags=["automations"])


# ---- Catalogo statico per il costruttore UI --------------------------------

# Il catalogo mostrato dal costruttore DEVE coincidere con le scelte del
# modello: erano due elenchi separati, e un evento aggiunto al modello (o tolto)
# lasciava l'interfaccia a proporre valori che l'API poi rifiuta, o a nascondere
# quelli buoni. Qui l'elenco è quello del modello; la traduzione inglese è
# l'unica cosa che vive in questo file.
EVENTS_EN = {
    "new_client": "New client",
    "appointment_created": "Appointment created",
    "appointment_upcoming": "Upcoming appointment",
    "visit_completed": "Visit completed",
    "birthday": "Birthday",
    "client_inactive": "Inactive client",
    "no_show": "No-show",
    "slot_freed": "Slot freed",
}
EVENTS = [
    (value, label, EVENTS_EN.get(value, label)) for value, label in Automation.Event.choices
]

OPERATORS = [
    ("eq", "Uguale a", "Equal to"),
    ("neq", "Diverso da", "Not equal to"),
    ("lt", "Minore di", "Less than"),
    ("lte", "Minore o uguale a", "Less than or equal to"),
    ("gt", "Maggiore di", "Greater than"),
    ("gte", "Maggiore o uguale a", "Greater than or equal to"),
    ("contains", "Contiene", "Contains"),
]

FILTER_FIELDS = [
    ("reliability", "Affidabilità", "Reliability"),
    ("categories", "Etichette", "Categories"),
    ("total_spent", "Speso totale", "Total spent"),
    ("visits", "Visite", "Visits"),
    ("noshow_count", "Mancate presentazioni", "No-shows"),
]


def _catalog_items(rows):
    return [{"value": value, "label_it": label_it, "label_en": label_en} for value, label_it, label_en in rows]


def automation_event_key(automation_id) -> str:
    """Chiave degli eventi di un'automazione: flush_outbox consegna in ordine
    quelli con la stessa chiave, così Yourang non riceve una versione vecchia
    dopo una nuova (un invio fallito e ritentato passava dopo il successivo)."""
    return f"automation:{automation_id}"


def _definition(automation: Automation) -> dict:
    """Definizione completa della regola, inviata a Yourang per la sincronizzazione."""
    return {
        "id": automation.id,
        "salon_id": automation.salon_id,
        "name": automation.name,
        "event": automation.event,
        "offset_direction": automation.offset_direction,
        "offset_value": automation.offset_value,
        "offset_unit": automation.offset_unit,
        "send_time": automation.send_time.isoformat() if automation.send_time else None,
        "conditions": automation.conditions,
        "trigger_origin": automation.trigger_origin,
        "webhook_token": str(automation.webhook_token),
        "message_preview": automation.message_preview,
        "active": automation.active,
    }


# ---- CRUD --------------------------------------------------------------


# Valore massimo dell'anticipo/ritardo, per unità: oltre non è una regola, è un
# errore di digitazione. `offset_value` è una colonna senza segno, quindi un -2
# arrivava fino al database e tornava 500.
MAX_OFFSET = {"minutes": 7 * 24 * 60, "hours": 24 * 30, "days": 365}
MAX_NAME_CHARS = 120


def _validated(data: AutomationIn) -> dict:
    """Payload ripulito, con gli enum confrontati con le scelte del MODELLO.

    Senza questi controlli un refuso come event="birtday" veniva salvato e
    spedito a Yourang: il titolare vedeva la regola attiva in dashboard e non
    partiva mai un messaggio.
    """
    payload = data.dict()
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HttpError(400, "Il nome dell'automazione è obbligatorio")
    payload["name"] = name[:MAX_NAME_CHARS]
    for field, choices, label in (
        ("event", Automation.Event.values, "Evento"),
        ("offset_direction", Automation.OffsetDirection.values, "Direzione"),
        ("offset_unit", Automation.OffsetUnit.values, "Unità"),
        ("trigger_origin", Automation.TriggerOrigin.values, "Origine"),
    ):
        if payload.get(field) not in choices:
            raise HttpError(400, f"{label} non valido: usa {', '.join(choices)}")
    offset = payload.get("offset_value") or 0
    if not isinstance(offset, int) or isinstance(offset, bool):
        raise HttpError(400, "Anticipo non valido")
    if not 0 <= offset <= MAX_OFFSET[payload["offset_unit"]]:
        raise HttpError(
            400,
            f"Anticipo fuori scala: da 0 a {MAX_OFFSET[payload['offset_unit']]} "
            f"{payload['offset_unit']}",
        )
    payload["offset_value"] = offset
    if not isinstance(payload.get("conditions") or {}, dict):
        raise HttpError(400, "Condizioni non valide")
    return payload


@router.get("/", auth=staff_auth, response=list[AutomationOut])
def list_automations(request):
    ctx = request.auth
    # I webhook_token sono credenziali: l'endpoint pubblico /hook/<token> non ha
    # altra autenticazione e il token non si rigenera, quindi li vede solo chi ha
    # «marketing». L'elenco in sé resta però leggibile da tutto lo staff: negarlo
    # spegneva la sezione Automazioni per due dei tre ruoli predefiniti (Front
    # desk e Operatrice non hanno «marketing»), che fino a ieri la consultavano.
    # La sezione era già progettata come lettura a tutti e scrittura ai soli
    # marketing: qui si nasconde il segreto, non la pagina.
    mask = not has_scope(ctx, "marketing")
    rows = list(ctx.salon.automations.all())
    for row in rows:
        row._mask_secrets = mask
    return rows


@router.post("/", auth=staff_auth, response=AutomationOut)
def create_automation(request, data: AutomationIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    automation = Automation.objects.create(salon=ctx.salon, **_validated(data))
    log_activity(
        ctx.salon,
        "automation.created",
        f"Automazione creata: {automation.name}",
        actor=ctx.user,
        payload={"automation_id": automation.id},
    )
    emit_event(
        ctx.salon, "automation.updated", _definition(automation),
        coalesce_key=automation_event_key(automation.id),
    )
    return automation


@router.put("/{int:automation_id}", auth=staff_auth, response=AutomationOut)
def update_automation(request, automation_id: int, data: AutomationIn):
    ctx = request.auth
    require_scope(ctx, "marketing")
    automation = salon_get(Automation, ctx, automation_id)
    payload = _validated(data)
    for name, value in payload.items():
        setattr(automation, name, value)
    # Solo i campi della maschera: il save completo riscriveva con la copia
    # letta a inizio richiesta anche `message_preview`, che sincronizza Yourang.
    automation.save(update_fields=[*payload, "updated_at"])
    log_activity(
        ctx.salon,
        "automation.updated",
        f"Automazione aggiornata: {automation.name}",
        actor=ctx.user,
        payload={"automation_id": automation.id},
    )
    emit_event(
        ctx.salon, "automation.updated", _definition(automation),
        coalesce_key=automation_event_key(automation.id),
    )
    return automation


@router.delete("/{int:automation_id}", auth=staff_auth, response=OkOut)
def delete_automation(request, automation_id: int):
    ctx = request.auth
    require_scope(ctx, "marketing")
    automation = salon_get(Automation, ctx, automation_id)
    name = automation.name
    automation_id_value = automation.id
    definition = _definition(automation)
    definition["deleted"] = True
    automation.delete()
    log_activity(
        ctx.salon,
        "automation.deleted",
        f"Automazione eliminata: {name}",
        actor=ctx.user,
        payload={"automation_id": automation_id_value},
    )
    emit_event(
        ctx.salon, "automation.updated", definition,
        coalesce_key=automation_event_key(automation_id_value),
    )
    return OkOut()


@router.post("/{int:automation_id}/toggle", auth=staff_auth, response=AutomationOut)
def toggle_automation(request, automation_id: int):
    ctx = request.auth
    require_scope(ctx, "marketing")
    automation = salon_get(Automation, ctx, automation_id)
    # Si inverte lo stato della riga bloccata, non quello della copia letta a
    # inizio richiesta: due clic ravvicinati (o due postazioni) leggevano
    # entrambi «attiva», scrivevano entrambi «spenta» e un clic spariva — con
    # Yourang informato dello stato sbagliato (18-07).
    with transaction.atomic():
        automation = Automation.objects.select_for_update().get(pk=automation.pk)
        automation.active = not automation.active
        automation.save(update_fields=["active", "updated_at"])
        log_activity(
            ctx.salon,
            "automation.updated",
            f"Automazione {'attivata' if automation.active else 'disattivata'}: {automation.name}",
            actor=ctx.user,
            payload={"automation_id": automation.id, "active": automation.active},
        )
        emit_event(
            ctx.salon, "automation.updated", _definition(automation),
            coalesce_key=automation_event_key(automation.id),
        )
    return automation


# ---- Catalogo eventi/operatori/campi (per il costruttore UI) ---------------


@router.get("/events-catalog", auth=staff_auth, response=EventsCatalogOut)
def events_catalog(request):
    return {
        "events": _catalog_items(EVENTS),
        "operators": _catalog_items(OPERATORS),
        "fields": _catalog_items(FILTER_FIELDS),
    }


# ---- Webhook esterno (Yourang → youty), nessuna autenticazione -------------

# Attivazioni accettate per automazione in un'ora e dimensione massima del corpo.
HOOK_MAX_PER_WINDOW = 120
HOOK_WINDOW_SECONDS = 3600
MAX_HOOK_BODY_BYTES = 64 * 1024



@router.post("/hook/{webhook_token}", response=WebhookTriggerOut)
def trigger_webhook(request, webhook_token: str):
    try:
        token = uuid_lib.UUID(str(webhook_token))
    except (ValueError, TypeError, AttributeError):
        raise HttpError(404, "Automazione non trovata")

    automation = Automation.objects.filter(webhook_token=token).select_related("salon").first()
    if automation is None:
        raise HttpError(404, "Automazione non trovata")
    # Spegnere un'automazione dalla dashboard deve spegnerla davvero: finora il
    # webhook la faceva partire lo stesso, e il titolare non aveva modo di
    # fermare una sequenza di messaggi già avviata.
    if not automation.active:
        raise HttpError(409, "Automazione disattivata")

    # L'endpoint è pubblico (il token nell'URL è l'unica credenziale): senza
    # tetto, chi lo intercetta può far partire messaggi a raffica a spese del
    # salone, e ogni chiamata scrive una riga nel registro attività.
    ratelimit.enforce(
        f"automation-hook:{automation.id}", HOOK_MAX_PER_WINDOW, HOOK_WINDOW_SECONDS,
        "Troppe attivazioni: riprova tra qualche minuto",
    )

    body = request.body or b""
    # Il corpo finisce nel registro attività e nell'outbox: un payload enorme
    # gonfierebbe il database a ogni chiamata.
    if len(body) > MAX_HOOK_BODY_BYTES:
        raise HttpError(413, "Payload troppo grande")
    try:
        payload = json.loads(body) if body else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        payload = {}

    log_activity(
        automation.salon,
        "automation.triggered",
        f"Automazione attivata via webhook: {automation.name}",
        payload={"automation_id": automation.id, "payload": payload},
    )
    emit_event(
        automation.salon,
        "automation.triggered",
        {"automation_id": automation.id, "payload": payload},
    )
    return {"ok": True, "automation_id": automation.id}
