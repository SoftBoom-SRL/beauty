"""Lista d'attesa: iscrizione dall'app, uscita, e la cliente contattata dal salone.

Gli annunci degli orari liberati per chi è in lista stanno in `freed_slots`.
"""

from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity

from ..models import WaitlistEntry


def mark_contacted(salon, entry: WaitlistEntry, *, actor=None) -> WaitlistEntry:
    entry.status = WaitlistEntry.Status.CONTACTED
    entry.save(update_fields=["status"])
    log_activity(
        salon,
        "waitlist.contacted",
        f"{entry.client.full_name} contattata dalla lista d'attesa",
        actor=actor,
        payload={"entry_id": entry.id},
    )
    return entry


def join_waitlist(
    salon, client, service, operator, *, preference: str, exact_days: list, exact_time
) -> WaitlistEntry:
    """Iscrive la cliente (dall'app) per quel servizio; 400 se preferenza o giorni non vanno."""
    if preference not in WaitlistEntry.Preference.values:
        raise HttpError(400, "Preferenza non valida")
    if any(not isinstance(d, int) or d < 0 or d > 6 for d in exact_days):
        raise HttpError(400, "Giorni non validi (attesi 0=lunedì … 6=domenica)")

    entry = WaitlistEntry.objects.create(
        salon=salon,
        client=client,
        service=service,
        operator=operator,
        preference=preference,
        exact_days=exact_days,
        exact_time=exact_time,
    )
    log_activity(
        salon,
        "waitlist.created",
        f"{client.full_name} in lista d'attesa per {service.name_it}",
        payload={"entry_id": entry.id},
    )
    return entry


def leave_waitlist(salon, client, entry: WaitlistEntry) -> None:
    entry_id = entry.id  # dopo il delete l'istanza non ha più id
    service_name = entry.service.name_it
    entry.delete()
    # L'iscrizione spariva senza lasciare traccia: l'operatrice che aveva appena
    # visto la cliente in lista non capiva più perché non ci fosse.
    log_activity(
        salon,
        "waitlist.deleted",
        f"{client.full_name} si è tolta dalla lista d'attesa per {service_name}",
        payload={"entry_id": entry_id, "client_id": client.id},
    )
    emit_event(
        salon,
        "waitlist.deleted",
        {"entry_id": entry_id, "client_id": client.id, "service_name": service_name},
    )
