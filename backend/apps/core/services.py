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


# ---- Orari di apertura -----------------------------------------------------------

WEEKDAYS_IT = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"]


def normalize_opening_hours_week(value) -> dict:
    """Valida {"0".."6": [["HH:MM","HH:MM"], …]} e ritorna la forma canonica.

    Solleva ValueError con messaggio user-facing. Accetta chiavi int o str,
    intervalli come liste/tuple di due stringhe "H:MM"/"HH:MM"; ordina e
    rifiuta sovrapposizioni e intervalli invertiti.
    """
    import re

    if value in (None, ""):
        return {}
    if not isinstance(value, dict):
        raise ValueError("Orari non validi")
    out: dict[str, list] = {}
    for day in range(7):
        raw = value.get(str(day), value.get(day, []))
        if raw in (None, ""):
            raw = []
        if not isinstance(raw, (list, tuple)):
            raise ValueError(f"Orari non validi per {WEEKDAYS_IT[day]}")
        ranges = []
        for rng in raw:
            if not isinstance(rng, (list, tuple)) or len(rng) != 2:
                raise ValueError(f"Intervallo non valido per {WEEKDAYS_IT[day]}")
            mins = []
            for hm in rng:
                m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(hm).strip())
                if not m or int(m.group(1)) > 24 or int(m.group(2)) > 59:
                    raise ValueError(f"Orario non valido per {WEEKDAYS_IT[day]}: {hm}")
                mins.append(int(m.group(1)) * 60 + int(m.group(2)))
            if mins[1] <= mins[0]:
                raise ValueError(f"Intervallo invertito per {WEEKDAYS_IT[day]}")
            ranges.append(mins)
        ranges.sort()
        for a, b in zip(ranges, ranges[1:]):
            if b[0] < a[1]:
                raise ValueError(f"Intervalli sovrapposti per {WEEKDAYS_IT[day]}")
        out[str(day)] = [[f"{a // 60:02d}:{a % 60:02d}", f"{b // 60:02d}:{b % 60:02d}"] for a, b in ranges]
    return out


def opening_hours_text(week: dict) -> str:
    """Riassunto leggibile: "Lun–Ven 9:00–13:00, 14:00–19:00 · Sab 9:00–13:00 · Dom chiuso"."""
    if not week:
        return ""

    def fmt(rng):
        return ", ".join(f"{_short(a)}–{_short(b)}" for a, b in rng)

    def _short(hm):
        h, m = hm.split(":")
        return f"{int(h)}:{m}"

    groups = []  # [ [start_day, end_day, label] ]
    for day in range(7):
        label = fmt(week.get(str(day), [])) or "chiuso"
        if groups and groups[-1][2] == label and groups[-1][1] == day - 1:
            groups[-1][1] = day
        else:
            groups.append([day, day, label])
    parts = []
    for a, b, label in groups:
        days = WEEKDAYS_IT[a] if a == b else f"{WEEKDAYS_IT[a]}–{WEEKDAYS_IT[b]}"
        parts.append(f"{days} {label}")
    return " · ".join(parts)
