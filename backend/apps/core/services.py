"""Servizi trasversali: registro attività + outbox eventi verso Yourang.

Ogni app chiama queste due funzioni dentro le proprie transazioni:

    log_activity(salon, "appointment.created", "Nuovo appuntamento per Sofia Ricci",
                 actor=ctx.user, payload={"appointment_id": appt.id})
    emit_event(salon, "appointment.created", {...})
"""

import logging

from .models import ActivityLog, OutboxEvent

logger = logging.getLogger("youty.events")


def log_activity(salon, type: str, summary: str, *, actor=None, location=None, payload=None):
    return ActivityLog.objects.create(
        salon=salon,
        location=location,
        actor=actor if (actor and getattr(actor, "pk", None)) else None,
        actor_name=(actor.get_full_name() or actor.email) if actor else "",
        type=type,
        summary=summary,
        payload=payload or {},
    )


def emit_event(salon, event_type: str, payload: dict | None = None):
    """Accoda un evento per Yourang. La consegna avverrà quando le API saranno attive."""
    event = OutboxEvent.objects.create(
        salon=salon, event_type=event_type, payload=payload or {}
    )
    logger.info("outbox event %s: %s", event_type, payload)
    return event
