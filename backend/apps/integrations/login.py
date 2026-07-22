"""Login con Yourang: da un'identità Yourang (OAuth) a una sessione staff beauty.

Porta il pattern di food (`provisionOrLinkYourangUser`) su Django: risolve o
provisiona Salone + Utente + Membership a partire dal claim `org` del token e
dall'id_token OIDC, poi conia i token staff e (best-effort) collega+sincronizza.

Precedenza:
  A. `org` già mappata su un salone (login precedente / connect) → entra lì.
  B. utente noto per email VERIFICATA → adotta un suo salone senza connessione.
  C. altrimenti → provisiona utente (se serve) + salone nuovo.
"""

import logging

from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.utils.text import slugify

from apps.accounts.models import Membership, User
from apps.core.models import Location, Salon, SalonSettings
from common.auth import create_staff_tokens

from . import client as yc
from . import crypto
from .models import YourangConnection
from .sync import _split_name, sync_clients, sync_services

logger = logging.getLogger("youty.integrations")

WEBHOOK_EVENT_TYPES = ["contact.*", "event.*"]


def _unique_salon_slug(seed: str) -> str:
    base = slugify(seed)[:40] or "salone"
    slug, i = base, 1
    while Salon.objects.filter(slug=slug).exists():
        i += 1
        slug = f"{base}-{i}"[:50]
    return slug


def _get_or_create_user(email: str, name: str) -> User:
    user = User.objects.filter(email__iexact=email).first()
    if user:
        return user
    first, last = _split_name(name)
    # password=None → set_unusable_password: l'accesso avviene solo via Yourang.
    return User.objects.create_user(email=email, password=None, first_name=first, last_name=last)


def _membership_for(salon: Salon, user: User) -> Membership | None:
    return (
        Membership.objects.select_related("user", "salon", "role")
        .filter(salon=salon, user=user)
        .first()
    )


def _primary_membership(salon: Salon) -> Membership | None:
    return (
        Membership.objects.select_related("user", "salon", "role")
        .filter(salon=salon)
        .order_by("-is_owner", "id")
        .first()
    )


@transaction.atomic
def _provision_salon(user: User, display_name: str) -> Salon:
    salon = Salon.objects.create(name=display_name, slug=_unique_salon_slug(display_name))
    SalonSettings.objects.get_or_create(salon=salon)
    Location.objects.create(salon=salon, name=display_name, is_default=True)
    Membership.objects.create(user=user, salon=salon, is_owner=True)
    return salon


def _session_payload(membership: Membership, tokens: dict) -> dict:
    salon, user = membership.salon, membership.user
    return {
        "user": {"id": user.id, "email": user.email, "name": user.get_full_name() or user.email},
        "salon": {"id": salon.id, "name": salon.name, "slug": salon.slug},
        "scopes": sorted(membership.role.scopes or []) if membership.role else [],
        "is_owner": membership.is_owner,
        **tokens,
    }


def _resolve_salon(org: str, email: str, email_verified: bool) -> tuple[Salon | None, User | None]:
    # A. org già collegata a un salone
    if org:
        conn = YourangConnection.objects.select_related("salon").filter(yourang_org_id=org).first()
        if conn:
            m = _primary_membership(conn.salon)
            return conn.salon, (m.user if m else None)
    # B. utente noto (email verificata) → adotta un salone senza connessione
    if email_verified:
        user = User.objects.filter(email__iexact=email).first()
        if user:
            for m in Membership.objects.filter(user=user).select_related("salon").order_by("id"):
                if not YourangConnection.objects.filter(salon=m.salon).exists():
                    return m.salon, user
            return None, user  # ha solo saloni già collegati → provisiona un nuovo salone
    return None, None


def login_with_yourang(code: str, code_verifier: str) -> dict:
    token_resp = yc.exchange_code(code, code_verifier)
    org = yc.org_id_from_access_token(token_resp["access_token"])
    idc = yc.claims_from_token(token_resp.get("id_token"))
    email = (idc.get("email") or "").strip()
    if not email:
        raise ValueError("Email non disponibile dal token Yourang")
    email_verified = bool(idc.get("email_verified"))
    name = (idc.get("name") or "").strip() or email.split("@")[0]

    salon, user = _resolve_salon(org, email, email_verified)

    if salon is None:
        user = user or _get_or_create_user(email, name)
        salon = _provision_salon(user, name)
    elif user is None:
        user = _get_or_create_user(email, name)

    membership = _membership_for(salon, user)
    if membership is None:
        membership = Membership.objects.create(
            user=user, salon=salon,
            is_owner=not Membership.objects.filter(salon=salon).exists(),
        )

    # Connessione Yourang del salone: token + webhook + primo sync (best-effort).
    conn, _ = YourangConnection.objects.get_or_create(salon=salon)
    yc.store_tokens(conn, token_resp)
    conn.yourang_org_id = org
    conn.connected_by = user
    conn.status = YourangConnection.Status.CONNECTED
    conn.last_error = ""
    if settings.YOURANG_WEBHOOK_RECEIVER_URL and not conn.webhook_secret_enc:
        try:
            secret = yc.YourangClient(conn).register_webhook(
                settings.YOURANG_WEBHOOK_RECEIVER_URL, WEBHOOK_EVENT_TYPES
            )
            conn.webhook_secret_enc = crypto.encrypt(secret)
        except Exception:
            logger.exception("Yourang webhook registration failed (login)")
    conn.save()
    try:
        sync_clients(conn)
        sync_services(conn)
        conn.last_sync_at = timezone.now()
        conn.save(update_fields=["last_sync_at"])
    except Exception as exc:  # noqa: BLE001
        logger.exception("Yourang initial sync failed (login)")
        conn.last_error = str(exc)
        conn.save(update_fields=["last_error"])

    tokens = create_staff_tokens(user, salon)
    return _session_payload(_membership_for(salon, user), tokens)
