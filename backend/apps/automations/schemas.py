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


class OkOut(Schema):
    ok: bool = True
