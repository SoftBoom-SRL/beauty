"""Prenotazioni al telefono: l'agente vocale Yourang prenota mentre parla con la cliente.

Come in food (Impostazioni → Assistente vocale): l'agente ha tre «strumenti
esterni» (servizi, disponibilità, prenotazione) che chiamano le rotte
`/voice/...` con una chiave Bearer del salone. La chiave non passa dall'OAuth:
il titolare la genera nelle impostazioni e la incolla (o la importa col file)
su Yourang.

Gli esiti che l'agente deve gestire nella conversazione (orario preso, dati
sbagliati) sono risposte 200 con `success: false`: Yourang non fa leggere
all'agente il corpo di una risposta 4xx/5xx e gli fa dire un generico
«riprova più tardi», e le alternative da proporre andavano perse.

La prenotazione passa da `create_appointment`, come quella dell'app: servizi
veri, disponibilità ricontrollata sotto lock, caparra e conferma WhatsApp.
L'import degli eventi Yourang (sync.import_event) resta per l'agente che usa
lo strumento di prenotazione interno di Yourang.
"""

import datetime as dt
import hashlib
import re
import secrets

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError
from ninja.security import HttpBearer

from apps.agenda.models import Appointment
from apps.agenda.schemas import MAX_ITEMS_PER_REQUEST
from apps.core.models import Salon
from apps.core.services import default_location, log_activity
from common.phone import normalize_phone

KEY_PREFIX = "yrb_"
# Un ritentativo dell'agente (timeout, risposta persa) entro questa finestra
# ritrova la prenotazione già fatta invece di crearne una seconda.
RETRY_WINDOW = dt.timedelta(minutes=10)
MAX_ALTERNATIVES = 4
MAX_NOTES = 500
PHONE_NOTE = "Prenotata al telefono dall'assistente Yourang"

WEEKDAYS = ("lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica")
MONTHS = (
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
)


def generate_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(32)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


class VoiceKeyAuth(HttpBearer):
    """Il salone della chiave Bearer, o None (→ 401 senza dire perché)."""

    def authenticate(self, request, token):
        return Salon.objects.filter(voice_api_key_hash=hash_key(token)).first()


voice_auth = VoiceKeyAuth()


def rotate_key(salon, actor) -> str:
    """Nuova chiave in chiaro (la si mostra una volta sola); la precedente smette subito di valere."""
    key = generate_key()
    salon.voice_api_key_hash = hash_key(key)
    salon.voice_api_key_created_at = timezone.now()
    salon.save(update_fields=["voice_api_key_hash", "voice_api_key_created_at"])
    log_activity(salon, "integration.voice_key", "Nuova chiave dell'assistente vocale", actor=actor)
    return key


def revoke_key(salon, actor) -> None:
    salon.voice_api_key_hash = None
    salon.voice_api_key_created_at = None
    salon.save(update_fields=["voice_api_key_hash", "voice_api_key_created_at"])
    log_activity(salon, "integration.voice_key", "Assistente vocale disattivato", actor=actor)


def date_label(day: dt.date) -> str:
    """«sabato 3 ottobre»: l'agente legge questa, la conversione delle date la sbagliava da sé (food)."""
    return f"{WEEKDAYS[day.weekday()]} {day.day} {MONTHS[day.month - 1]}"


def services_reply(salon) -> list[dict]:
    """Il listino pubblico in una lista piatta, quella che l'agente legge."""
    from apps.catalog.services import public_price_list

    return [
        {
            "id": service.id,
            "name": service.name_it,
            "category": category["name_it"],
            "duration_min": service.duration_min,
            "price": str(service.price),
        }
        for category in public_price_list(salon)
        for service in category["services"]
    ]


def availability_reply(salon, date: str, services) -> dict:
    try:
        day = _parse_day(date)
        times = list(_free_slots(salon, day, _parse_services(services)))
    except HttpError as err:
        return _invalid(err)
    return {"success": True, "date": day.isoformat(), "date_label": date_label(day), "times": times}


def booking_reply(salon, data) -> dict:
    try:
        day = _parse_day(data.date)
        service_ids = _parse_services(data.services)
        time = _parse_time(data.time)
        name = " ".join(str(data.customer_name or "").split())
        if not name:
            raise HttpError(400, "Manca il nome della cliente")
        phone = normalize_phone(str(data.customer_phone or ""))
        if not phone:
            raise HttpError(400, "Telefono non valido: serve quello della cliente, es. +393331234567")
        appointment = book(
            salon, day=day, time=time, service_ids=service_ids, name=name, phone=phone,
            notes=str(data.notes or "")[:MAX_NOTES],
        )
    except HttpError as err:
        if err.status_code != 409:
            return _invalid(err)
        return {
            "success": False,
            "error": "unavailable",
            "message": str(err),
            "alternatives": _nearest_times(salon, day, service_ids, time),
        }
    return {
        "success": True,
        "appointment_id": appointment.id,
        "date": day.isoformat(),
        "date_label": date_label(day),
        "time": time,
        "services": [row.service.name_it for row in appointment.items.select_related("service")],
        "deposit_amount": str(appointment.deposit_amount),
    }


def book(salon, *, day, time, service_ids, name, phone, notes="") -> Appointment:
    """Crea l'appuntamento all'orario detto dalla cliente, o ritrova quello appena creato.

    Tutto sotto il lock del salone: due ritentativi in parallelo non passano
    entrambi il controllo dei doppioni, e la scheda di una cliente nuova non
    resta se la prenotazione non va a buon fine.
    """
    from apps.agenda.services import deposits
    from apps.agenda.services.appointments import create_appointment
    from apps.agenda.services.locking import lock_salon

    from .sync import _client_for_event

    with transaction.atomic():
        lock_salon(salon)
        client = _client_for_event(salon, {"client_full_name": name, "client_phone_number": phone})
        # Il ritentativo si riconosce dall'orario: in food bastavano giorno e
        # telefono, e una seconda prenotazione della stessa cliente per un
        # altro orario tornava indietro come la prima.
        recent = Appointment.objects.filter(
            salon=salon,
            client=client,
            created_via=Appointment.CreatedVia.YOURANG,
            status__in=Appointment.OPEN_STATUSES,
            created_at__gte=timezone.now() - RETRY_WINDOW,
            start__date=day,
        )
        for appointment in recent:
            if f"{timezone.localtime(appointment.start):%H:%M}" == time:
                return appointment
        slot = _free_slots(salon, day, service_ids).get(time)
        if slot is None:
            raise HttpError(409, "Orario non disponibile")
        appointment = create_appointment(
            salon,
            client,
            slot["assignment"],
            dt.datetime.fromisoformat(slot["start"]),
            via=Appointment.CreatedVia.YOURANG,
            note=f"{PHONE_NOTE}: {notes}" if notes else PHONE_NOTE,
            location=default_location(salon),
            allow_past=False,
            allow_soak=False,
        )
    # Fuori dalla transazione: prepara il link Stripe (chiamata esterna).
    deposits.send_deposit_link(appointment)
    return appointment


def _free_slots(salon, day, service_ids) -> dict:
    """{"HH:MM": slot} degli orari che l'app proporrebbe, sulla sede dell'app."""
    from apps.agenda.services import availability

    items = [{"service_id": service_id, "operator_id": None} for service_id in service_ids]
    slots = availability.smart_slots(
        salon, availability.get_free_slots(salon, day, items, default_location(salon))
    )
    return {
        f"{timezone.localtime(dt.datetime.fromisoformat(slot['start'])):%H:%M}": slot
        for slot in slots
    }


def _nearest_times(salon, day, service_ids, time) -> list[str]:
    def minutes(hhmm):
        hours, mins = hhmm.split(":")
        return int(hours) * 60 + int(mins)

    times = sorted(_free_slots(salon, day, service_ids), key=lambda t: abs(minutes(t) - minutes(time)))
    return sorted(times[:MAX_ALTERNATIVES])


def _invalid(err: HttpError) -> dict:
    return {"success": False, "error": "invalid_request", "message": str(err)}


def _parse_day(value) -> dt.date:
    from apps.agenda.api.params import _parse_day as parse_day

    return parse_day(str(value or ""))


def _parse_time(value) -> str:
    """«HH:MM» da «9:30», «09.30», «09:30»: il formato lo sceglie l'agente."""
    match = re.fullmatch(r"\s*(\d{1,2})[:.](\d{2})\s*", str(value or ""))
    if not match or int(match[1]) > 23 or int(match[2]) > 59:
        raise HttpError(400, "Orario non valido (atteso HH:MM, es. 15:30)")
    return f"{int(match[1]):02d}:{match[2]}"


def _parse_services(value) -> list[int]:
    """Id dei servizi: «12,15» dalla query, ma anche 12 o [12, 15] dal corpo."""
    if isinstance(value, int) and not isinstance(value, bool):
        value = [value]
    if isinstance(value, str):
        value = [part for part in re.split(r"[,;\s]+", value) if part]
    try:
        ids = [int(part) for part in value or ()]
    except (TypeError, ValueError):
        ids = []
    if not ids or any(service_id <= 0 for service_id in ids):
        raise HttpError(400, "Servizi non validi: usa gli id di list_services, es. 12,15")
    if len(ids) > MAX_ITEMS_PER_REQUEST:
        raise HttpError(400, f"Troppi servizi nella richiesta (massimo {MAX_ITEMS_PER_REQUEST})")
    return ids
