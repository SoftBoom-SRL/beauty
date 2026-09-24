"""Servizi accounts: ruoli di default del salone + generazione/verifica OTP clienti.

L'invio effettivo dell'OTP via WhatsApp è delegato a Yourang: qui viene solo
accodato l'evento `client.otp` in core.OutboxEvent (in DEBUG il codice è loggato).
"""

import logging
import secrets

from django.conf import settings
from django.db.models import F
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event
from common import ratelimit

from .models import ClientOTP, Role

logger = logging.getLogger("youty.accounts")

DEFAULT_ROLES = [
    ("Manager", ["agenda", "clients", "sales", "inventory", "pricing", "marketing"]),
    ("Front desk", ["agenda", "clients", "sales"]),
    ("Operatrice", ["agenda", "clients"]),
]

MAX_ACTIVE_OTP = 3
# Verifiche sbagliate tollerate per i codici attivi di un cliente: alla soglia i
# codici vengono invalidati e serve richiederne uno nuovo (niente forza bruta
# sulle 6 cifre di un codice già emesso).
MAX_OTP_ATTEMPTS = 5
# Richieste di codice per cliente nella finestra (cache su database, condivisa
# fra i worker): limita anche il ciclo "brucio i codici → ne chiedo altri".
OTP_ISSUE_WINDOW_SECONDS = 15 * 60
OTP_ISSUE_MAX_PER_WINDOW = 5
# Tentativi di verifica sbagliati per cliente, indipendenti da quanti codici ha
# chiesto: senza questo tetto bastava richiedere un codice nuovo per azzerare.
OTP_VERIFY_WINDOW_SECONDS = 15 * 60
OTP_VERIFY_MAX_PER_WINDOW = 8


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
    ratelimit.enforce(
        f"otp-issue:{client.id}", OTP_ISSUE_MAX_PER_WINDOW, OTP_ISSUE_WINDOW_SECONDS,
        "Troppi codici richiesti: riprova tra qualche minuto",
    )

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
    """Verifica un OTP non usato e non scaduto; lo marca come usato.

    Un codice sbagliato conta come tentativo su tutti i codici attivi del
    cliente; raggiunta MAX_OTP_ATTEMPTS vengono invalidati (429) e il cliente
    deve richiederne uno nuovo.
    """
    # Tetto sui tentativi del CLIENTE, non del singolo codice: il contatore per
    # codice riparte a ogni nuovo invio, così chi ne chiede cinque in quindici
    # minuti ottiene venticinque tentativi invece di cinque.
    attempts_key = f"otp-verify:{client.id}"
    if ratelimit.peek(attempts_key) >= OTP_VERIFY_MAX_PER_WINDOW:
        raise HttpError(429, "Troppi tentativi errati: riprova tra qualche minuto")

    active = ClientOTP.objects.filter(client=client, used=False, expires_at__gt=timezone.now())
    otp = active.filter(code=code).order_by("-created_at").first()
    if otp is None:
        within_cap = ratelimit.hit(
            attempts_key, OTP_VERIFY_MAX_PER_WINDOW, OTP_VERIFY_WINDOW_SECONDS
        )
        active.update(attempts=F("attempts") + 1)
        if not within_cap or active.filter(attempts__gte=MAX_OTP_ATTEMPTS).exists():
            active.update(used=True)
            raise HttpError(429, "Troppi tentativi errati: richiedi un nuovo codice")
        raise HttpError(400, "Codice non valido o scaduto")
    otp.used = True
    otp.save(update_fields=["used"])
    return otp
