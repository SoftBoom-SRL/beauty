"""Chiave per gli strumenti di automazione esterni (n8n, Make, Zapier).

Lo strumento legge gli appuntamenti in arrivo con una chiave Bearer del salone
e manda da sé i messaggi (es. ogni ora: chi ha un appuntamento fra 24 ore, e
quale trattamento). Legge e basta: la chiave non scrive niente. Spostamenti e
annullamenti non chiedono altro, perché a ogni giro lo strumento rilegge
l'agenda com'è adesso.
"""

import calendar
import datetime as dt
import secrets

from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime
from ninja.errors import HttpError
from ninja.security import HttpBearer

from apps.agenda.models import Appointment
from apps.agenda.services.messages import _event_payload
from apps.clients.models import Client
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


def visits(salon, start: str, end: str) -> list[dict]:
    """Visite incassate (conti di appuntamenti) chiuse in [start, end), con `first_visit`.

    Lo stesso contenuto dell'evento `visit.completed`, ma da leggere: l'evento
    arriva solo a Yourang, e n8n (che non riceve i webhook del salone) non
    aveva modo di sapere chi era alla prima visita per mandarle la richiesta
    di recensione. Le vendite al banco (prodotti, caparre) non sono visite.
    """
    from apps.sales.models import Sale  # lazy: le vendite non servono al resto del modulo

    first, last = _parse_moment(start, "start"), _parse_moment(end, "end")
    if last <= first or last - first > MAX_WINDOW:
        raise HttpError(400, "Intervallo non valido (massimo 7 giorni)")
    sales = (
        Sale.objects.filter(
            salon=salon, kind=Sale.Kind.CHECKOUT, client__isnull=False,
            created_at__gte=first, created_at__lt=last,
        )
        .select_related("client", "client__contact_client")
        .prefetch_related("lines__service")
        .order_by("created_at", "id")
    )
    rows = []
    for sale in sales:
        client = sale.client
        # Prima visita: nessun conto di appuntamento della cliente prima di
        # questo, come nell'evento. «Prima» per data O per id: un conto
        # riportato a una data passata conta, e uno registrato prima conta
        # anche se il suo orario coincide. Una query per conto: la finestra è
        # di al massimo 7 giorni.
        earlier = (
            Sale.objects.filter(salon=salon, client=client, kind=Sale.Kind.CHECKOUT)
            .filter(Q(created_at__lt=sale.created_at) | Q(id__lt=sale.id))
            .exclude(pk=sale.pk)
        )
        rows.append({
            "sale_id": sale.id,
            "appointment_id": sale.appointment_id,
            "closed_at": sale.created_at.isoformat(),
            "client_id": client.id,
            "client_name": client.full_name,
            "phone": client.contact_phone,
            "lang": client.lang,
            "wa": client.wa,
            "marketing": bool((client.consents or {}).get("marketing")),
            "services": [line.service.name_it for line in sale.lines.all() if line.service_id],
            "total": str(sale.total),
            "first_visit": not earlier.exists(),
        })
    return rows


def birthdays(salon, date: str | None = None) -> list[dict]:
    """Clienti attive che compiono gli anni il giorno `date` (oggi, se manca).

    Chi è nata il 29 febbraio, negli anni non bisestili, compare il 28.
    `marketing` è il consenso della cliente: il messaggio di auguri è
    promozionale, decide lo strumento esterno se mandarlo (come per `wa`).
    """
    if date:
        day = parse_date(date)
        if day is None:
            raise HttpError(400, "«date» non valido: usa una data ISO (AAAA-MM-GG)")
    else:
        day = timezone.localdate()
    days = [(day.month, day.day)]
    if (day.month, day.day) == (2, 28) and not calendar.isleap(day.year):
        days.append((2, 29))
    matches = Q()
    for month, dom in days:
        matches |= Q(birthday__month=month, birthday__day=dom)
    clients = (
        Client.objects.filter(matches, salon=salon, is_active=True)
        .select_related("contact_client")
        .order_by("first_name", "last_name", "id")
    )
    return [
        {
            "client_id": c.id,
            "client_name": c.full_name,
            "phone": c.contact_phone,
            "lang": c.lang,
            "wa": c.wa,
            "marketing": bool((c.consents or {}).get("marketing")),
            "birthday": c.birthday_iso,
        }
        for c in clients
    ]
