from datetime import datetime, time
from typing import Optional

from ninja import Schema


class AutomationIn(Schema):
    name: str
    event: str
    offset_direction: str = "after"
    offset_value: int = 0
    offset_unit: str = "hours"
    send_time: Optional[time] = None
    conditions: dict = {}
    trigger_origin: str = "yourang"
    active: bool = True
    # Modello WhatsApp approvato su Yourang (vuoto = nessun invio) e i campi di
    # youty che ne riempiono i valori, in ordine (vedi GET /whatsapp-templates).
    template_name: str = ""
    template_language: str = ""
    template_parameters: list[str] = []


class AutomationOut(Schema):
    id: int
    name: str
    event: str
    offset_direction: str
    offset_value: int
    offset_unit: str
    send_time: Optional[time] = None
    conditions: dict
    trigger_origin: str
    webhook_token: str
    webhook_url: str
    message_preview: str
    template_name: str
    template_language: str
    template_parameters: list[str]
    active: bool
    created_at: datetime
    updated_at: datetime

    @staticmethod
    def resolve_webhook_token(obj):
        # Chi non ha «marketing» legge l'automazione ma non la sua credenziale:
        # con il token si fa partire la sequenza di messaggi senza autenticarsi.
        if getattr(obj, "_mask_secrets", False):
            return ""
        return str(obj.webhook_token)

    @staticmethod
    def resolve_webhook_url(obj):
        # L'indirizzo contiene il token: nasconderne uno e non l'altro non
        # servirebbe a niente.
        if getattr(obj, "_mask_secrets", False):
            return ""
        return f"/api/automations/hook/{obj.webhook_token}"


class CatalogItemOut(Schema):
    value: str
    label_it: str
    label_en: str


class EventsCatalogOut(Schema):
    events: list[CatalogItemOut]
    operators: list[CatalogItemOut]
    fields: list[CatalogItemOut]


class WebhookTriggerOut(Schema):
    ok: bool = True
    automation_id: int


class TemplateParameterOut(Schema):
    key: str
    label: Optional[str] = None


class WhatsAppTemplateOut(Schema):
    name: str
    language: str
    category: str
    body: Optional[str] = None
    parameters: list[TemplateParameterOut]


class ParameterFieldOut(Schema):
    value: str
    label_it: str
    label_en: str


class WhatsAppTemplatesOut(Schema):
    """Modelli WhatsApp approvati su Yourang, per il costruttore.

    `state`: `ok`; `not_connected` (salone non collegato a Yourang);
    `needs_reconnect` (collegato prima dei permessi WhatsApp: ricollegare);
    `unavailable` (invio WhatsApp non ancora abilitato su questo server);
    `yourang_error` (Yourang non risponde). `events` sono gli eventi che
    possono inviare un modello, `fields` i campi che ne riempiono i valori.
    """

    state: str
    templates: list[WhatsAppTemplateOut]
    events: list[str]
    fields: list[ParameterFieldOut]
