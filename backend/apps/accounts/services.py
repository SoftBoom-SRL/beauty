"""Servizi accounts: ruoli di default del salone + generazione/verifica OTP clienti.

L'invio effettivo dell'OTP via WhatsApp è delegato a Yourang: qui viene solo
accodato l'evento `client.otp` in core.OutboxEvent (in DEBUG il codice è loggato).
"""

import json
import logging
import secrets
import urllib.error
import urllib.request

from django.conf import settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event

from .models import ClientOTP, Role

logger = logging.getLogger("youty.accounts")

DEFAULT_ROLES = [
    ("Manager", ["agenda", "clients", "sales", "inventory", "pricing", "marketing"]),
    ("Front desk", ["agenda", "clients", "sales"]),
    ("Operatrice", ["agenda", "clients"]),
]

MAX_ACTIVE_OTP = 3


def ensure_default_roles(salon) -> list[Role]:
    """Crea (se assenti) i ruoli di sistema del salone. Idempotente."""
    roles = []
    for name, scopes in DEFAULT_ROLES:
        role, _ = Role.objects.get_or_create(
            salon=salon,
            name=name,
            defaults={"scopes": scopes, "is_system": True},
        )
        roles.append(role)
    return roles


def _send_otp_sms(phone: str, code: str, lang: str = "it") -> bool:
    """Invia il codice OTP via SMS con Infobip. Ritorna True se inviato.

    Se le credenziali Infobip (base URL / API key / mittente) non sono tutte
    configurate, non invia nulla e ritorna False → fallback: il codice resta nel
    log (DEBUG) e nell'outbox `client.otp`. Un errore d'invio non fa fallire l'OTP.
    """
    base = settings.INFOBIP_BASE_URL
    key = settings.INFOBIP_API_KEY
    sender = settings.INFOBIP_SMS_FROM
    if not (base and key and sender):
        return False
    text = (
        f"Your access code is {code}"
        if lang == "en"
        else f"Il tuo codice di accesso è {code}"
    )
    root = base if base.startswith("http") else f"https://{base}"
    url = root.rstrip("/") + "/sms/2/text/advanced"
    payload = json.dumps(
        {"messages": [{"destinations": [{"to": phone}], "from": sender, "text": text}]}
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"App {key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception:  # non far fallire l'OTP se l'SMS non parte
        logger.exception("Invio OTP via Infobip fallito per %s", phone)
        return False


def issue_otp(client) -> ClientOTP:
    """Genera un OTP a 6 cifre e lo invia via SMS (Infobip); resta accodato a
    Yourang nell'outbox `client.otp`.

    Se Infobip non è configurato, l'SMS non parte (in DEBUG il codice è nel log).
    Max 3 OTP validi contemporanei per cliente → HttpError 429.
    """
    active = ClientOTP.objects.filter(
        client=client, used=False, expires_at__gt=timezone.now()
    ).count()
    if active >= MAX_ACTIVE_OTP:
        raise HttpError(429, "Troppi codici richiesti: riprova tra qualche minuto")

    otp = ClientOTP.objects.create(client=client, code=f"{secrets.randbelow(10**6):06d}")
    emit_event(
        client.salon,
        "client.otp",
        {
            "client_id": client.id,
            "phone": client.phone,
            "code": otp.code,
            "lang": client.lang,
        },
    )
    sent = _send_otp_sms(client.phone, otp.code, client.lang)
    if settings.DEBUG:
        logger.info("OTP per %s: %s (sms=%s)", client.phone, otp.code, sent)
    return otp


def verify_otp(client, code: str) -> ClientOTP:
    """Verifica un OTP non usato e non scaduto; lo marca come usato."""
    otp = (
        ClientOTP.objects.filter(
            client=client, code=code, used=False, expires_at__gt=timezone.now()
        )
        .order_by("-created_at")
        .first()
    )
    if otp is None:
        raise HttpError(400, "Codice non valido o scaduto")
    otp.used = True
    otp.save(update_fields=["used"])
    return otp
