"""Automazioni verso Yourang: la definizione che le descrive e il suo invio.

Yourang esegue le automazioni con l'ultima definizione ricevuta, quindi ogni
modifica gliela rimanda con un evento `automation.updated`: creazione,
modifica, attivazione, eliminazione, e anche il rinomina di un'etichetta
citata nelle condizioni (clients). L'invio era scritto a mano in quattro
endpoint, e le etichette dei clienti prendevano definizione e chiave dal
modulo degli endpoint: qui ci sono una volta sola.
"""

from apps.core.services import emit_event

from .models import Automation


def automation_event_key(automation_id) -> str:
    """Chiave degli eventi di un'automazione: flush_outbox consegna in ordine
    quelli con la stessa chiave, così Yourang non riceve una versione vecchia
    dopo una nuova (un invio fallito e ritentato passava dopo il successivo)."""
    return f"automation:{automation_id}"


def definition(automation: Automation) -> dict:
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


def publish_definition(salon, data: dict):
    """Accoda per Yourang la definizione `data` (vedi `definition`) come `automation.updated`.

    La chiave è quella dell'automazione (`data["id"]`), così le versioni
    partono nell'ordine in cui sono nate. Chi elimina manda la definizione
    letta prima dell'eliminazione, con `deleted: True`.
    """
    return emit_event(
        salon, "automation.updated", data,
        coalesce_key=automation_event_key(data["id"]),
    )
