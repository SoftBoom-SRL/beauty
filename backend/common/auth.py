"""JWT auth per le due popolazioni: staff (dashboard) e clienti (web app).

Uso negli endpoint ninja:

    from common.auth import staff_auth, client_auth

    @router.get("/qualcosa", auth=staff_auth)
    def view(request):
        ctx = request.auth  # StaffContext
"""

import datetime as dt
import secrets
from dataclasses import dataclass, field

import jwt
from django.conf import settings
from ninja.security import HttpBearer

ALGO = "HS256"


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _encode(claims: dict, ttl: dt.timedelta) -> str:
    payload = {
        **claims,
        "iat": int(_now().timestamp()),
        "exp": int((_now() + ttl).timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=ALGO)


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=[ALGO])
    except jwt.PyJWTError:
        return None


def create_staff_tokens(user, salon) -> dict:
    """Coppia access/refresh per un membro staff, con la sessione registrata.

    Il refresh porta un `jti` che corrisponde a una riga di
    `accounts.StaffRefreshToken`: è quella riga a renderlo revocabile (uscita
    lato server) e a permettere la rotazione al rinnovo. La registrazione sta
    qui e non nell'endpoint di login perché i token staff si coniano anche
    altrove (accettazione invito, login Yourang): se fosse nel chiamante,
    prima o poi nascerebbe una sessione non tracciata, cioè non revocabile.
    """
    from apps.accounts.models import StaffRefreshToken  # lazy: evita cicli in fase di load

    refresh_ttl = dt.timedelta(days=settings.JWT_REFRESH_TTL_DAYS)
    jti = secrets.token_urlsafe(32)
    # sub come stringa: PyJWT >= 2.10 rifiuta in decodifica i sub non-stringa
    base = {"sub": str(user.id), "salon": salon.id, "tv": user.token_version or 0}
    now = _now()
    # Le righe già scadute di questo utente non servono più a nessuno: né a
    # rinnovare né a riconoscere un token revocato, perché il JWT corrispondente
    # è scaduto lo stesso giorno.
    StaffRefreshToken.objects.filter(user=user, expires_at__lte=now).delete()
    StaffRefreshToken.objects.create(
        user=user, salon=salon, jti=jti, expires_at=now + refresh_ttl
    )
    return {
        "access": _encode(
            {**base, "typ": "staff"},
            dt.timedelta(minutes=settings.JWT_ACCESS_TTL_MIN),
        ),
        "refresh": _encode({**base, "typ": "staff_refresh", "jti": jti}, refresh_ttl),
    }


def create_client_tokens(client) -> dict:
    # Durata propria (JWT_CLIENT_TTL_DAYS) e non quella del refresh staff: sono
    # due sessioni diverse, e prima toccare il TTL del gestionale cambiava in
    # silenzio anche quello della web app cliente.
    return {
        "access": _encode(
            {"sub": str(client.id), "salon": client.salon_id, "typ": "client"},
            dt.timedelta(days=settings.JWT_CLIENT_TTL_DAYS),
        )
    }


@dataclass
class StaffContext:
    user: object
    salon: object
    membership: object
    scopes: set = field(default_factory=set)
    is_owner: bool = False


@dataclass
class ClientContext:
    client: object
    salon: object


class StaffAuth(HttpBearer):
    def authenticate(self, request, token):
        payload = decode_token(token)
        if not payload or payload.get("typ") != "staff":
            return None
        # lazy: evita cicli in fase di load. Le regole della sessione (membership
        # viva, versione della password, permessi del ruolo) sono quelle di
        # accounts.sessions, le stesse del rinnovo e dello stream live.
        from apps.accounts.sessions import find_membership, membership_scopes, tv_matches

        membership = find_membership(payload["sub"], payload["salon"])
        if membership is None:
            return None
        # Password cambiata dopo l'emissione del token → sessione non più valida.
        # I token emessi prima di questa modifica non hanno "tv": valgono 0, come
        # il default sull'utente, quindi restano validi e nessuno viene sloggato
        # al deploy.
        if not tv_matches(membership, payload.get("tv", 0)):
            return None
        scopes = set(membership_scopes(membership))
        return StaffContext(
            user=membership.user,
            salon=membership.salon,
            membership=membership,
            scopes=scopes,
            is_owner=membership.is_owner,
        )


class ClientAuth(HttpBearer):
    def authenticate(self, request, token):
        payload = decode_token(token)
        if not payload or payload.get("typ") != "client":
            return None
        from apps.clients.models import Client  # lazy

        client = (
            Client.objects.select_related("salon")
            .filter(id=payload["sub"], is_active=True)
            .first()
        )
        if client is None:
            return None
        return ClientContext(client=client, salon=client.salon)


staff_auth = StaffAuth()
client_auth = ClientAuth()
