"""Chiave per gli strumenti di automazione esterni (n8n, Make, Zapier).

Lo strumento legge gli appuntamenti in arrivo con una chiave Bearer del salone
e manda da sé i messaggi (es. ogni ora: chi ha un appuntamento fra 24 ore, e
quale trattamento). Legge e basta: la chiave non scrive niente. Spostamenti e
annullamenti non chiedono altro, perché a ogni giro lo strumento rilegge
l'agenda com'è adesso.
"""

import datetime as dt
import secrets

from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from ninja.errors import HttpError
from ninja.security import HttpBearer

from apps.agenda.models import Appointment
from apps.agenda.services.messages import _event_payload
from apps.core.models import Salon
from apps.core.services import log_activity

from .voice import hash_key

KEY_PREFIX = "yta_"
MAX_WINDOW = dt.timedelta(days=7)


class AutomationKeyAuth(HttpBearer):
    def authenticate(self, request, token):
        return Salon.objects.filter(automation_api_key_hash=hash_key(token)).first()


automation_auth = AutomationKeyAuth()


def rotate_key(salon, actor) -> str:
    """Nuova chiave in chiaro (la si mostra una volta sola); la precedente smette subito di valere."""
    key = KEY_PREFIX + secrets.token_urlsafe(32)
    salon.automation_api_key_hash = hash_key(key)
    salon.automation_api_key_created_at = timezone.now()
    salon.save(update_fields=["automation_api_key_hash", "automation_api_key_created_at"])
    log_activity(salon, "integration.automation_key", "Nuova chiave per le automazioni esterne", actor=actor)
    return key


def revoke_key(salon, actor) -> None:
    salon.automation_api_key_hash = None
    salon.automation_api_key_created_at = None
    salon.save(update_fields=["automation_api_key_hash", "automation_api_key_created_at"])
    log_activity(salon, "integration.automation_key", "Chiave per le automazioni esterne revocata", actor=actor)


def status(salon) -> dict:
    return {
        "active": bool(salon.automation_api_key_hash),
        "created_at": salon.automation_api_key_created_at,
    }


def _parse_moment(value: str, field: str) -> dt.datetime:
    # Lo strumento esterno manda di solito un ISO con fuso; un giorno senza ora
    # vale la mezzanotte del salone, un'ora senza fuso è nel fuso del salone.
    moment = parse_datetime(value or "")
    if moment is None:
        day = parse_date(value or "")
        if day is None:
            raise HttpError(400, f"«{field}» non valido: usa una data o una data e ora ISO")
        moment = dt.datetime.combine(day, dt.time())
    if timezone.is_naive(moment):
        moment = timezone.make_aware(moment)
    return moment


def upcoming(salon, start: str, end: str) -> list[dict]:
    """Appuntamenti confermati che iniziano in [start, end), col payload dei messaggi Yourang."""
    first, last = _parse_moment(start, "start"), _parse_moment(end, "end")
    if last <= first or last - first > MAX_WINDOW:
        raise HttpError(400, "Intervallo non valido (massimo 7 giorni)")
    appointments = (
        Appointment.objects.filter(
            salon=salon, status=Appointment.Status.CONFIRMED, start__gte=first, start__lt=last
        )
        .select_related("client")
        .order_by("start", "id")
    )
    # ponytail: _event_payload fa una query per i servizi di ogni appuntamento;
    # su una finestra di un'ora sono pochi. Prefetch se si leggono settimane intere.
    return [_event_payload(a) for a in appointments]
