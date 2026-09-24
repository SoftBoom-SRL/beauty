"""Endpoint /api/auth della web app cliente: registrazione, accesso con OTP, profilo.

Registrazione e richiesta del codice rispondono allo stesso modo per i numeri
in rubrica e per quelli sconosciuti: vedi `client_request_otp`.
"""

import logging

from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import emit_event, get_salon_by_slug, log_activity
from common import ratelimit
from common.auth import client_auth, create_client_tokens
from common.phone import canonical_phone, find_client_by_phone
from common.schemas import OkOut

from ..schemas import (
    ClientAuthOut,
    ClientMeIn,
    ClientMeOut,
    ClientRegisterIn,
    OTPRequestIn,
    OTPVerifyIn,
)
from ..services import issue_otp, verify_otp

# Il nome è quello di quando gli endpoint stavano tutti in apps/accounts/api.py:
# i test lo leggono con assertLogs, e cambiarlo cambierebbe anche i log.
logger = logging.getLogger("apps.accounts.api")

router = Router()


def _active_client_by_phone(salon, phone: str):
    """Cliente attivo con quel numero, comunque scritto («+39 333…», «333…», «0039…»).

    Restituisce None se non esiste: chi chiama NON deve trasformarlo in un 404,
    perché la differenza fra «numero in anagrafica» e «numero sconosciuto» è la
    rubrica clienti del salone.
    """
    return find_client_by_phone(salon, phone, active_only=True)


def _client_profile(client) -> dict:
    return {
        "id": client.id,
        "first_name": client.first_name,
        "last_name": client.last_name,
        "phone": client.phone,
        "email": client.email or "",
        "lang": client.lang,
        "whatsapp_reminders": client.whatsapp_reminders,
        # Il consenso dato dal form o in salone si revoca dall'app
        # (POST /api/marketing/client/marketing-consent): senza leggerlo qui
        # l'app non sapeva nemmeno se c'era qualcosa da revocare (06-17).
        "marketing_consent": bool((client.consents or {}).get("marketing")),
    }


# Una segnalazione al salone per scheda archiviata al giorno: vedi
# `_notify_archived_client`.
ARCHIVED_NOTICE_WINDOW_SECONDS = 24 * 3600


def _notify_archived_client(salon, client) -> None:
    """Avvisa il salone se `client` è una scheda archiviata che prova a entrare.

    Alla cliente archiviata l'app non può dire nulla di diverso da un numero
    sconosciuto — la risposta rivelerebbe la rubrica — e il codice non le parte:
    restava fuori senza che nessuno lo sapesse. Il salone invece deve saperlo:
    la segnalazione arriva nel feed (scope clienti) con la scheda da aprire e
    riattivare, e l'app intanto le dice di contattare il salone. Non la si
    riattiva da sola: il numero potrebbe essere passato a un'altra persona, che
    entrerebbe nello storico di chi non è più cliente.
    """
    if client is None or client.is_active:
        return
    if not ratelimit.hit(
        f"archived-notice:{client.id}", 1, ARCHIVED_NOTICE_WINDOW_SECONDS
    ):
        return
    log_activity(
        salon,
        "client.reactivation_requested",
        f"{client.full_name}: scheda archiviata, ha provato ad accedere dall'app. "
        "Riattivala se vuoi che entri.",
        payload={"client_id": client.id},
    )


# ---- Registrazione e accesso con OTP -------------------------------------------

# Registrazioni accettate per finestra. Sono numeri generosi per una persona
# vera (che si registra una volta) e stretti per uno script. Il tetto per
# salone conta solo le schede create davvero: vedi client_register.
REGISTER_WINDOW_SECONDS = 3600
REGISTER_MAX_PER_IP = 5
REGISTER_MAX_PER_SALON = 120


@router.post("/client/register", response=OkOut)
def client_register(request, data: ClientRegisterIn):
    salon = get_salon_by_slug(data.salon_slug)
    from apps.clients.models import Client  # lazy: evita cicli in fase di load

    phone = canonical_phone(data.phone)
    if not phone:
        raise HttpError(400, "Il numero di telefono è obbligatorio")

    # L'endpoint è pubblico e ogni chiamata riuscita accoda un messaggio a spese
    # del salone: senza tetto uno script crea schede a raffica e fa partire un
    # SMS verso qualunque numero. Due limiti perché nessuno dei due basta da
    # solo: quello per IP ferma il singolo chiamante, quello per salone ferma
    # la botnet che li distribuisce.
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"register-ip:{ip}", REGISTER_MAX_PER_IP, REGISTER_WINDOW_SECONDS):
        logger.warning("register: tetto per IP superato (salone=%s, ip=%s)", salon.slug, ip)
        raise HttpError(429, "Troppe registrazioni: riprova tra qualche minuto")
    existing = find_client_by_phone(salon, phone)
    if existing is not None:
        # Stessa risposta per la scheda attiva e per quella archiviata: l'app
        # mostra la schermata che spiega entrambi i casi e offre di chiamare.
        _notify_archived_client(salon, existing)
        raise HttpError(400, "Numero di telefono già registrato")
    # Il tetto per salone si conta DOPO il controllo sul numero: contato prima,
    # lo riempivano anche i tentativi respinti (numeri già in rubrica, che non
    # costano nulla) e da poche reti si bloccava per un'ora l'iscrizione di
    # tutte le clienti nuove del salone (10-04). Ora lo consuma solo chi crea
    # una scheda davvero, e il valore è più largo di un picco di campagna.
    if not ratelimit.hit(
        f"register-salon:{salon.id}", REGISTER_MAX_PER_SALON, REGISTER_WINDOW_SECONDS
    ):
        logger.warning("register: tetto per salone superato (salone=%s)", salon.slug)
        raise HttpError(429, "Troppe registrazioni: riprova tra qualche minuto")

    try:
        # Il controllo qui sopra e l'inserimento non sono atomici: il doppio
        # tocco su «Registrati» (o un ritentativo di rete) li superava entrambi
        # e il secondo moriva sul vincolo unico del telefono con un 500 — dopo
        # che il primo aveva già emesso il codice (10-14, 18-12).
        with transaction.atomic():
            client = Client.objects.create(
                salon=salon,
                first_name=data.first_name.strip(),
                last_name=data.last_name.strip(),
                phone=phone,
                email=(data.email or "").strip(),
                lang=data.lang if data.lang in ("it", "en") else "it",
                # Data di prima iscrizione: è l'unico campo su cui si appoggia il KPI
                # «nuovi clienti» del cruscotto, e nessuno lo valorizzava — il numero
                # restava zero per sempre, anche con la web app piena di iscrizioni.
                since=timezone.localdate(),
            )
    except IntegrityError:
        raise HttpError(400, "Numero di telefono già registrato")
    emit_event(
        salon,
        "client.created",
        {
            "client_id": client.id,
            "name": client.full_name,
            "phone": client.phone,
            "lang": client.lang,
        },
    )
    log_activity(
        salon,
        "client.created",
        f"Nuovo cliente dalla web app: {client.first_name} {client.last_name}",
        payload={"client_id": client.id},
    )
    issue_otp(client)
    return OkOut()


# Richieste di codice accettate per finestra. Ogni codice emesso fa partire un
# WhatsApp a spese del salone. Il tetto per IP vale per ogni richiesta ed è
# generoso per una persona che entra nella web app e stretto per uno script che
# cicla i numeri. Quello per salone conta solo i codici EMESSI davvero (vedi
# client_request_otp); le richieste nel loro insieme sono solo un segnale.
OTP_WINDOW_SECONDS = 15 * 60
OTP_MAX_PER_IP = 20
OTP_MAX_ISSUED_PER_SALON = 200
OTP_ALERT_PER_SALON = 60
OTP_VERIFY_MAX_PER_IP = 30


@router.post("/client/request-otp", response=OkOut)
def client_request_otp(request, data: OTPRequestIn):
    """Chiede il codice di accesso. Risponde SEMPRE allo stesso modo.

    Rispondere 404 sui numeri sconosciuti e 200 su quelli in anagrafica
    trasformava l'endpoint in un interrogatorio: uno script che cicla i numeri
    italiani si ricavava l'intera rubrica del salone, e sui numeri validi
    faceva partire cinque WhatsApp ogni quarto d'ora a spese del titolare,
    saturando per giunta i tre codici attivi e tenendo fuori la cliente vera.
    Ora il risultato non dipende dal numero: nemmeno il tetto per cliente
    trapela fuori, altrimenti basterebbe contare i 429 per sapere chi esiste.
    """
    salon = get_salon_by_slug(data.salon_slug)
    # Il tetto per IP si applica PRIMA della ricerca: vale anche per i numeri
    # che non esistono, che sono quelli che interessano a chi sta enumerando.
    ip = ratelimit.client_ip(request)
    if not ratelimit.hit(f"otp-ip:{ip}", OTP_MAX_PER_IP, OTP_WINDOW_SECONDS):
        logger.warning("request-otp: tetto per IP superato (salone=%s, ip=%s)", salon.slug, ip)
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")
    # Il tetto per salone contava ogni richiesta, anche sui numeri inventati:
    # da tre reti, venti richieste ciascuna, si teneva fuori dall'app ogni
    # cliente del salone per quindici minuti alla volta, e bastava una
    # campagna «prenota dall'app» per chiuderlo senza nessun attacco (16-01,
    # 10-04). Contate tutte, le richieste restano solo un segnale nei log.
    if not ratelimit.hit(f"otp-salon:{salon.id}", OTP_ALERT_PER_SALON, OTP_WINDOW_SECONDS):
        logger.warning("request-otp: molte richieste per il salone (salone=%s)", salon.slug)
    # Il blocco vero conta solo i codici partiti, cioè il costo: i numeri
    # inventati non lo toccano, e riempirlo richiede decine di numeri veri
    # (ognuno ha il suo tetto di cinque). Una volta pieno vale per tutti allo
    # stesso modo, così la risposta non dice nulla del numero.
    issued_key = f"otp-issued-salon:{salon.id}"
    if ratelimit.peek(issued_key) >= OTP_MAX_ISSUED_PER_SALON:
        logger.warning("request-otp: tetto dei codici emessi per salone (salone=%s)", salon.slug)
        raise HttpError(429, "Troppe richieste: riprova tra qualche minuto")

    client = _active_client_by_phone(salon, data.phone)
    if client is not None:
        try:
            issue_otp(client)
        except HttpError as exc:
            # Il tetto per cliente ha fatto il suo lavoro: nessun codice parte,
            # ma la risposta resta identica a quella di un numero sconosciuto.
            logger.info("request-otp: codice non inviato (cliente=%s): %s", client.id, exc)
        else:
            ratelimit.hit(issued_key, OTP_MAX_ISSUED_PER_SALON, OTP_WINDOW_SECONDS)
    else:
        _notify_archived_client(salon, find_client_by_phone(salon, data.phone))
    return OkOut()


@router.post("/client/verify-otp", response=ClientAuthOut)
def client_verify_otp(request, data: OTPVerifyIn):
    salon = get_salon_by_slug(data.salon_slug)
    # Anche qui un tetto per indirizzo: il numero sconosciuto non ha un cliente
    # su cui contare i tentativi, quindi senza questo l'endpoint resterebbe
    # l'unico punto senza limiti del flusso di accesso.
    ip = ratelimit.client_ip(request)
    ratelimit.enforce(
        f"otp-verify-ip:{ip}", OTP_VERIFY_MAX_PER_IP, OTP_WINDOW_SECONDS,
        "Troppi tentativi: riprova tra qualche minuto",
    )
    client = _active_client_by_phone(salon, data.phone)
    if client is None:
        # Stessa risposta del codice sbagliato: il numero inesistente non si
        # distingue da quello esistente con il codice errato.
        raise HttpError(400, "Codice non valido o scaduto")
    verify_otp(client, data.code.strip())
    tokens = create_client_tokens(client)
    return {
        "access": tokens["access"],
        "client": {"id": client.id, "first_name": client.first_name, "lang": client.lang},
    }


@router.get("/client/me", auth=client_auth, response=ClientMeOut)
def client_me(request):
    return _client_profile(request.auth.client)


@router.put("/client/me", auth=client_auth, response=ClientMeOut)
def client_update_me(request, data: ClientMeIn):
    client = request.auth.client
    updates = data.dict(exclude_unset=True)
    values = {}
    if "lang" in updates:
        if updates["lang"] not in ("it", "en"):
            raise HttpError(400, "Lingua non valida")
        values["lang"] = updates["lang"]
    if "email" in updates:
        values["email"] = (updates["email"] or "").strip()
    if "whatsapp_reminders" in updates:
        values["whatsapp_reminders"] = bool(updates["whatsapp_reminders"])
    changed = [name for name, value in values.items() if getattr(client, name) != value]
    for name in changed:
        setattr(client, name, values[name])
    if not changed:
        return _client_profile(client)
    # Solo le colonne toccate: il save() completo riscriveva la scheda letta
    # all'autenticazione, cioè riportava indietro nome, consensi, etichette o
    # dati Stripe cambiati nel frattempo dal salone o dal webhook (18-07).
    client.save(update_fields=changed)
    # La scheda aperta in dashboard si ricarica su `client.updated` con il suo
    # id: senza, la reception continuava a vedere lingua ed email di prima.
    log_activity(
        request.auth.salon,
        "client.updated",
        f"{client.full_name} ha aggiornato il profilo dall'app",
        payload={"client_id": client.id, "fields": changed},
    )
    return _client_profile(client)
