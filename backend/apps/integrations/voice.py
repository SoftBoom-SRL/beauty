"""Prenotazioni al telefono: l'agente vocale Yourang prenota mentre parla con la cliente.

Come in food (Impostazioni → Assistente vocale): l'agente ha degli «strumenti
esterni» (servizi, disponibilità, prenotazione; ritrovare, spostare e annullare
un appuntamento della cliente) che chiamano le rotte
`/voice/...` con una chiave Bearer del salone. La chiave non passa dall'OAuth:
il backend la genera e installa gli strumenti sull'org Yourang da sé, appena
il salone si collega (`install`, più sotto); la chiave non esce dal server.

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
import logging
import re
import secrets

import httpx
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError
from ninja.security import HttpBearer

from apps.agenda.models import Appointment
from apps.agenda.schemas import MAX_ITEMS_PER_REQUEST
from apps.core.models import Salon
from apps.core.services import default_location, log_activity
from common.phone import find_client_by_phone, normalize_phone

from .client import YourangClient
from .models import YourangConnection

logger = logging.getLogger("youty.integrations")

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


def rotate_key(salon, actor, key: str | None = None) -> str:
    """Nuova chiave in chiaro (la si mostra una volta sola); la precedente smette subito di valere."""
    key = key or generate_key()
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


# ---- Installazione automatica su Yourang ------------------------------------
# Prima il titolare generava la chiave, scaricava un file JSON e lo importava
# sull'agente (Strumenti → Strumenti esterni → Importa), poi spegneva a mano la
# prenotazione interna: troppi passi, e la chiave passava per le sue mani. Ora
# il backend installa gli strumenti sull'org (valgono per tutti gli agenti)
# con l'external API, e la chiave non esce mai dal server.

_DATE = {
    "type": "string",
    "description": 'Data in formato YYYY-MM-DD, es. 2026-10-02. Converti "domani", "sabato" ecc. nella data esatta',
}
_SERVICES = {
    "type": "string",
    "description": "Id dei servizi scelti, presi da list_services, separati da virgola, es. 12,15",
}
_PHONE = {
    "type": "string",
    "description": "Telefono della cliente in formato internazionale, es. +393331234567. "
    "Se è d'accordo usa il numero da cui chiama o scrive",
}
_APPOINTMENT = {
    "type": "string",
    "description": "Id dell'appuntamento, preso da find_appointments",
}

# Le descrizioni le legge l'agente, non l'utente: per questo solo in italiano.
# (nome, nome visibile, metodo, dove vanno i parametri, rotta, descrizione, schema)
_TOOLS = (
    (
        "list_services", "Servizi del salone", "GET", "query", "services",
        "Elenca i servizi prenotabili del salone con id, nome, categoria, durata in minuti e prezzo. "
        "Usalo appena la cliente dice cosa vuole fare, per trovare gli id dei servizi: non inventare "
        "servizi che non sono in elenco.",
        {"type": "object", "properties": {}, "required": []},
    ),
    (
        "check_availability", "Disponibilità salone", "GET", "query", "availability",
        "Controlla gli orari liberi del salone in una data per i servizi scelti. Usalo SEMPRE prima di "
        'prenotare. Proponi solo orari presenti in "times"; se "times" è vuoto il salone è pieno o chiuso '
        "quel giorno: proponi un altro giorno. Se success è false, correggi i dati indicati in "
        '"message" e riprova. Per dire la data alla cliente leggi "date_label". Per SPOSTARE un '
        'appuntamento passa il suo "appointment_id" al posto dei servizi: gli orari sono quelli della '
        "stessa visita.",
        {
            "type": "object",
            "properties": {"date": _DATE, "services": _SERVICES, "appointment_id": _APPOINTMENT},
            "required": ["date"],
        },
    ),
    (
        "create_appointment", "Prenota appuntamento", "POST", "body", "appointments",
        "Registra l'appuntamento. Chiamalo SOLO dopo aver letto alla cliente un riepilogo completo "
        '(servizi, data da "date_label", orario, nome) e aver ricevuto un sì a QUEL riepilogo: dare il '
        "nome non è una conferma. L'orario deve essere tra quelli di check_availability. Se success è "
        'false: con "unavailable" proponi gli orari in "alternatives", con "invalid_request" correggi i '
        'dati e riprova. Se "deposit_amount" è maggiore di zero, di\' che riceverà un messaggio con il '
        "link per pagare la caparra.",
        {
            "type": "object",
            "properties": {
                "date": _DATE,
                "time": {"type": "string", "description": "Orario HH:MM, es. 15:30: uno di quelli restituiti da check_availability"},
                "services": _SERVICES,
                "customer_name": {"type": "string", "description": "Nome e cognome della cliente"},
                "customer_phone": {
                    "type": "string",
                    "description": "Telefono della cliente in formato internazionale, es. +393331234567. "
                    "Se è d'accordo usa il numero da cui chiama",
                },
                "notes": {"type": "string", "description": "Richieste particolari della cliente, se ne fa"},
            },
            "required": ["date", "time", "services", "customer_name", "customer_phone"],
        },
    ),
    (
        "find_appointments", "Appuntamenti della cliente", "GET", "query", "appointments",
        "Elenca i prossimi appuntamenti della cliente dal suo numero di telefono, con id, data "
        '("date_label"), orario, servizi e operatrice. Usalo quando la cliente vuole spostare o '
        "annullare: se ne ha più di uno chiedile quale. Se l'elenco è vuoto il numero non ha "
        "appuntamenti: chiedi se ha prenotato con un altro numero.",
        {"type": "object", "properties": {"customer_phone": _PHONE}, "required": ["customer_phone"]},
    ),
    (
        "reschedule_appointment", "Sposta appuntamento", "POST", "body", "appointments/reschedule",
        "Sposta un appuntamento della cliente a un nuovo giorno e orario, con gli stessi servizi. "
        'Prima trova gli orari liberi con check_availability passando "appointment_id". Chiamalo SOLO '
        "dopo aver letto alla cliente il nuovo giorno e orario e aver ricevuto un sì. Se success è "
        'false: con "unavailable" proponi gli orari in "alternatives"; con "too_late" spiega che a '
        "ridosso dell'appuntamento deve parlarne con il salone; con \"invalid_request\" correggi i "
        "dati e riprova.",
        {
            "type": "object",
            "properties": {
                "appointment_id": _APPOINTMENT,
                "customer_phone": _PHONE,
                "date": _DATE,
                "time": {"type": "string", "description": "Nuovo orario HH:MM, es. 15:30: uno di quelli di check_availability"},
            },
            "required": ["appointment_id", "customer_phone", "date", "time"],
        },
    ),
    (
        "cancel_appointment", "Annulla appuntamento", "POST", "body", "appointments/cancel",
        "Annulla un appuntamento della cliente. Chiamalo SOLO dopo aver letto alla cliente quale "
        "appuntamento (giorno, orario, servizi) e aver ricevuto un sì. Proponi prima di spostarlo, "
        'se le va. Se success è false: con "too_late" spiega che a ridosso dell\'appuntamento deve '
        'parlarne con il salone; con "invalid_request" correggi i dati e riprova.',
        {
            "type": "object",
            "properties": {"appointment_id": _APPOINTMENT, "customer_phone": _PHONE},
            "required": ["appointment_id", "customer_phone"],
        },
    ),
)
TOOL_NAMES = tuple(tool[0] for tool in _TOOLS)
# Chi scrive ha bisogno di leggere: senza gli id dei servizi o dell'appuntamento
# l'agente non prenota, non sposta e non annulla.
NEEDS = {
    "create_appointment": ("list_services", "check_availability"),
    "reschedule_appointment": ("find_appointments", "check_availability"),
    "cancel_appointment": ("find_appointments",),
}
NOT_ALLOWED = {
    "success": False,
    "error": "not_allowed",
    "message": "Il salone non permette all'assistente di farlo: proponi alla cliente di contattare il salone",
}


def enabled_tools(salon) -> list[str]:
    """Gli strumenti che il salone permette all'agente (di serie tutti)."""
    off = set(salon.voice_disabled_tools or ())
    on = [name for name in TOOL_NAMES if name not in off]
    return [name for name in on if all(need in on for need in NEEDS.get(name, ()))]


def refused(salon, tool: str) -> dict | None:
    """La risposta per l'agente se lo strumento non è permesso, altrimenti None."""
    return None if tool in enabled_tools(salon) else NOT_ALLOWED


def set_tools(salon, tools, actor) -> None:
    """Salva cosa l'agente può fare e, se l'assistente è attivo, lo riporta su Yourang.

    Le rotte controllano comunque il permesso: se Yourang non risponde, uno
    strumento spento resta installato ma risponde «non permesso».
    """
    wanted = set(tools) & set(TOOL_NAMES)
    for name in list(wanted):
        wanted.update(NEEDS.get(name, ()))
    salon.voice_disabled_tools = [name for name in TOOL_NAMES if name not in wanted]
    salon.save(update_fields=["voice_disabled_tools"])
    log_activity(
        salon, "integration.voice_tools", "Permessi dell'assistente Yourang aggiornati",
        actor=actor, payload={"tools": enabled_tools(salon)},
    )
    if salon.voice_api_key_hash:
        install(salon, actor)

RECONNECT = "Ricollega Yourang dalle Impostazioni per attivare l'assistente vocale"


class VoiceSetupError(Exception):
    """L'installazione non è riuscita; il messaggio è per il titolare."""


def tool_specs(base_url: str, key: str, names=TOOL_NAMES) -> list[dict]:
    """Gli strumenti nel formato dell'external API Yourang (PUT /external-tools/{nome}).

    Il routing dei parametri va scritto: Yourang manda nel corpo ciò che non ha
    routing, e una GET il corpo non lo invia.
    """
    return [
        {
            "tool_name": name,
            "display_name": display,
            "description": description,
            "category": "external",
            "category_display_name": "Prenotazioni",
            "webhook_url": f"{base_url}/api/integrations/voice/{path}",
            "webhook_method": method,
            "timeout_seconds": 15,
            "auth_method": "bearer",
            "auth_config": {"token": key},
            "custom_headers": {},
            "parameters_schema": schema,
            "parameter_routing": {param: {"location": where} for param in schema["properties"]},
            "is_enabled": True,
        }
        for name, display, method, where, path, description, schema in _TOOLS
        if name in names
    ]


def _connection(salon) -> YourangConnection:
    conn = YourangConnection.objects.filter(
        salon=salon, status=YourangConnection.Status.CONNECTED
    ).first()
    if conn is None:
        raise VoiceSetupError("Collega prima Yourang dalle Impostazioni")
    return conn


def needs_reconnect(conn: YourangConnection | None) -> bool:
    """Connessione nata prima degli scope `agents:*`: il token non può installare."""
    return conn is not None and "agents:write" not in (conn.scope or "").split()


def status(salon) -> dict:
    """Lo stato che mostra il cassetto (VoiceStatusOut)."""
    conn = YourangConnection.objects.filter(
        salon=salon, status=YourangConnection.Status.CONNECTED
    ).first()
    return {
        "active": bool(salon.voice_api_key_hash),
        "created_at": salon.voice_api_key_created_at,
        "connected": conn is not None,
        "needs_reconnect": needs_reconnect(conn),
        "tools": enabled_tools(salon),
    }


def _yourang_failure(exc: Exception) -> VoiceSetupError:
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (401, 403):
        return VoiceSetupError(RECONNECT)
    return VoiceSetupError("Yourang non ha completato l'installazione: riprova tra qualche minuto")


def install(salon, actor) -> None:
    """Attiva l'assistente vocale: chiave nuova, strumenti su Yourang, prenotazione interna spenta.

    La chiave si salva solo dopo che gli strumenti l'hanno ricevuta: salvata
    prima, un'installazione a metà lasciava l'agente con la chiave vecchia,
    che non vale più. Ripeterla è innocuo (PUT per nome).
    """
    conn = _connection(salon)
    if needs_reconnect(conn):
        raise VoiceSetupError(RECONNECT)
    if not settings.PUBLIC_API_URL:
        raise VoiceSetupError("Manca l'indirizzo pubblico del backend (PUBLIC_API_URL) sul server")
    key = generate_key()
    with YourangClient(conn) as client:
        try:
            allowed = enabled_tools(salon)
            for tool in tool_specs(settings.PUBLIC_API_URL, key, allowed):
                client.upsert_external_tool(tool)
            for name in TOOL_NAMES:
                if name not in allowed:
                    client.delete_external_tool(name)
        except Exception as exc:  # noqa: BLE001 — qualunque guasto è un'installazione da ripetere
            raise _yourang_failure(exc) from exc
        rotate_key(salon, actor, key)
        try:
            for agent in client.list_inbound_agents():
                client.disable_builtin_booking(agent["id"])
        except Exception as exc:  # noqa: BLE001
            # Gli strumenti funzionano già: resta da spegnere a mano la
            # prenotazione interna, o la stessa prenotazione arriva due volte.
            raise VoiceSetupError(
                "Assistente attivo, ma non è stato possibile spegnere la prenotazione interna "
                "dell'agente Yourang: spegnila su Yourang (agente → Strumenti)"
            ) from exc
    log_activity(salon, "integration.voice_installed", "Assistente vocale installato su Yourang", actor=actor)


def uninstall(salon, actor) -> None:
    """Spegne l'assistente: via la chiave (subito) e gli strumenti da Yourang (se raggiungibile).

    La chiave si revoca comunque: senza, gli strumenti rimasti su Yourang
    rispondono 401 e l'agente non prenota più. La prenotazione interna di
    Yourang resta spenta: riaccenderla è una scelta del titolare su Yourang.
    """
    revoke_key(salon, actor)
    conn = YourangConnection.objects.filter(salon=salon).first()
    if conn is None or needs_reconnect(conn):
        return
    try:
        with YourangClient(conn) as client:
            for name in TOOL_NAMES:
                client.delete_external_tool(name)
    except Exception:  # noqa: BLE001
        logger.warning("Yourang: strumenti vocali non rimossi (salone %s)", salon.id, exc_info=True)


def auto_install(conn_id: int) -> None:
    """Dopo il collegamento: l'assistente si attiva da solo, senza che il titolare faccia nulla.

    Best effort: un'org che non lo permette (scope mancanti, Yourang giù) lascia
    il cassetto su «Non attivo» con il motivo al primo «Attiva».
    """
    conn = YourangConnection.objects.select_related("salon").filter(pk=conn_id).first()
    if conn is None:
        return
    try:
        install(conn.salon, None)
    except VoiceSetupError as exc:  # motivo già leggibile: niente traceback, la causa basta
        logger.warning(
            "Yourang: assistente vocale non installato (salone %s): %s %r", conn.salon_id, exc, exc.__cause__
        )
    except Exception:  # noqa: BLE001
        logger.warning("Yourang: assistente vocale non installato (salone %s)", conn.salon_id, exc_info=True)


def date_label(day: dt.date) -> str:
    """«sabato 3 ottobre»: l'agente legge questa, la conversione delle date la sbagliava da sé (food)."""
    return f"{WEEKDAYS[day.weekday()]} {day.day} {MONTHS[day.month - 1]}"


def services_reply(salon) -> list[dict]:
    """Il listino pubblico in una lista piatta, quella che l'agente legge.

    `addon` = aggiuntivo (nail art, scrub): si fa durante un altro servizio e
    non si prenota da solo. Senza saperlo l'agente lo proponeva come un
    trattamento a sé, e la prenotazione tornava indietro col motivo.
    """
    from apps.catalog.services import public_price_list

    return [
        {
            "id": service.id,
            "name": service.name_it,
            "category": category["name_it"],
            "duration_min": service.duration_min,
            "price": str(service.price),
            "addon": service.is_addon,
        }
        for category in public_price_list(salon)
        for service in category["services"]
    ]


def availability_reply(salon, date: str, services, appointment_id="") -> dict:
    try:
        day = _parse_day(date)
        if str(appointment_id or "").strip():
            times = list(_move_slots(salon, _open_appointment(salon, appointment_id), day))
        else:
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
        phone = _phone(data.customer_phone)
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
    return _closest(_free_slots(salon, day, service_ids), time)


def _closest(times, time) -> list[str]:
    def minutes(hhmm):
        hours, mins = hhmm.split(":")
        return int(hours) * 60 + int(mins)

    return sorted(sorted(times, key=lambda t: abs(minutes(t) - minutes(time)))[:MAX_ALTERNATIVES])


# ---- Spostare e annullare: la cliente al telefono o in chat -------------------
# Le regole dell'app cliente: solo gli appuntamenti di chi chiama (dal numero,
# l'id da solo non basta) e solo con CLIENT_MOVE_CANCEL_MIN_HOURS ore di
# preavviso. Sotto la soglia decide il salone, come quando l'app rimanda a lui.

AGENT_CANCEL_REASON = "Disdetta dalla cliente con l'assistente Yourang"
MAX_LISTED = 10


def appointments_reply(salon, customer_phone) -> dict:
    try:
        client_ids = _caller_client_ids(salon, _phone(customer_phone))
    except HttpError as err:
        return _invalid(err)
    upcoming = (
        Appointment.objects.filter(
            salon=salon, client_id__in=client_ids,
            status__in=Appointment.OPEN_STATUSES, start__gte=timezone.now(),
        )
        .select_related("operator", "client")
        .order_by("start")[:MAX_LISTED]
    )
    return {"success": True, "appointments": [_appointment_out(a) for a in upcoming]}


def reschedule_reply(salon, data) -> dict:
    from apps.agenda.services.appointments import move_appointment
    from apps.agenda.services.availability import _client_move_reassignment
    from apps.agenda.services.transitions import client_notice_ok

    try:
        appointment = _callers_appointment(salon, data.appointment_id, data.customer_phone)
        day = _parse_day(data.date)
        time = _parse_time(data.time)
        current = timezone.localtime(appointment.start)
        if current.date() == day and f"{current:%H:%M}" == time:
            # ritentativo dell'agente (risposta persa): è già lì
            return {"success": True, **_appointment_out(appointment)}
        if not client_notice_ok(appointment):
            return _too_late("spostare")
        slots = _move_slots(salon, appointment, day)
        if time not in slots:
            raise HttpError(409, "Orario non disponibile")
        start = dt.datetime.fromisoformat(slots[time]["start"])
        operator, from_operator = _client_move_reassignment(salon, appointment, start)
        appointment = move_appointment(
            appointment, start, operator=operator, from_operator=from_operator, allow_past=False,
        )
    except HttpError as err:
        if err.status_code != 409:
            return _invalid(err)
        return {
            "success": False,
            "error": "unavailable",
            "message": str(err),
            "alternatives": _closest(_move_slots(salon, appointment, day), time),
        }
    return {"success": True, **_appointment_out(appointment)}


def cancel_reply(salon, data) -> dict:
    from apps.agenda.services.transitions import cancel_appointment, client_notice_ok

    try:
        appointment = _callers_appointment(
            salon, data.appointment_id, data.customer_phone,
            statuses=(*Appointment.OPEN_STATUSES, Appointment.Status.CANCELLED),
        )
    except HttpError as err:
        return _invalid(err)
    if appointment.status != Appointment.Status.CANCELLED:  # già annullato: ritentativo
        if not client_notice_ok(appointment):
            return _too_late("annullare")
        appointment = cancel_appointment(appointment, reason=AGENT_CANCEL_REASON, by_client=True)
    return {"success": True, "cancelled": True, **_appointment_out(appointment)}


def _caller_client_ids(salon, phone) -> list[int]:
    """La cliente del numero e chi in rubrica si contatta tramite lei (la figlia col numero della mamma)."""
    from apps.clients.models import Client

    holder = find_client_by_phone(salon, phone)
    if holder is None:
        return []
    dependents = Client.objects.filter(salon=salon, contact_client=holder).values_list("id", flat=True)
    return [holder.id, *dependents]


def _callers_appointment(salon, appointment_id, phone, statuses=Appointment.OPEN_STATUSES) -> Appointment:
    appointment = Appointment.objects.filter(
        salon=salon, pk=_appointment_id(appointment_id),
        client_id__in=_caller_client_ids(salon, _phone(phone)), status__in=statuses,
    ).select_related("operator", "client").first()
    if appointment is None:
        raise HttpError(400, "Appuntamento non trovato per questo numero: cercalo con find_appointments")
    return appointment


def _open_appointment(salon, appointment_id) -> Appointment:
    appointment = Appointment.objects.filter(
        salon=salon, pk=_appointment_id(appointment_id), status__in=Appointment.OPEN_STATUSES,
    ).first()
    if appointment is None:
        raise HttpError(400, "Appuntamento non trovato: usa l'id di find_appointments")
    return appointment


def _move_slots(salon, appointment, day) -> dict:
    """{"HH:MM": slot} per spostare la visita: gli stessi orari che l'app propone spostando."""
    from apps.agenda.services import availability

    parsed, keep_service_ids = availability._visit_plan(appointment)
    location = availability._client_move_location(salon, appointment)
    if len(availability._unbookable_operator_ids(salon, parsed, location)) > 1:
        raise HttpError(400, availability.CLIENT_MOVE_NEEDS_SALON_MESSAGE)
    slots = availability.smart_slots(
        salon,
        availability.get_free_slots(
            salon, day, parsed, location,
            exclude_appointment_id=appointment.id, keep_service_ids=keep_service_ids,
        ),
    )
    return {
        f"{timezone.localtime(dt.datetime.fromisoformat(slot['start'])):%H:%M}": slot
        for slot in slots
    }


def _appointment_out(appointment) -> dict:
    start = timezone.localtime(appointment.start)
    return {
        "appointment_id": appointment.id,
        "date": start.date().isoformat(),
        "date_label": date_label(start.date()),
        "time": f"{start:%H:%M}",
        "services": [row.service.name_it for row in appointment.items.select_related("service")],
        "operator": appointment.operator.first_name if appointment.operator_id else "",
        "client_name": appointment.client.first_name,
    }


def _too_late(action: str) -> dict:
    return {
        "success": False,
        "error": "too_late",
        "message": f"Mancano meno di {settings.CLIENT_MOVE_CANCEL_MIN_HOURS} ore all'appuntamento: "
        f"per {action}lo serve il salone",
    }


def _phone(value) -> str:
    phone = normalize_phone(str(value or ""))
    if not phone:
        raise HttpError(400, "Telefono non valido: serve quello della cliente, es. +393331234567")
    return phone


def _appointment_id(value) -> int:
    text = str(value or "").strip()
    if not text.isdigit() or int(text) <= 0:
        raise HttpError(400, "Appuntamento non valido: usa l'id di find_appointments")
    return int(text)


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
