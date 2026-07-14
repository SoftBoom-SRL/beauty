"""Servizi accounts: ruoli di default del salone + generazione/verifica OTP clienti.

L'invio effettivo dell'OTP via WhatsApp è delegato a Yourang: qui viene solo
accodato l'evento `client.otp` in core.OutboxEvent (in DEBUG il codice è loggato).
"""

import logging
import secrets

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


def issue_otp(client) -> ClientOTP:
    """Genera un OTP a 6 cifre per il cliente e lo accoda a Yourang per la consegna.

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
    if settings.DEBUG:
        logger.info("OTP per %s: %s", client.phone, otp.code)
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
