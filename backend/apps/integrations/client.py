"""Client HTTP verso Yourang: flusso OAuth (PKCE) + chiamate all'external API.

Yourang è già in piedi (Authorization Server OIDC + external API /api/external/v1).
Qui: PKCE/authorize URL, scambio/refresh token, e i wrapper delle rotte che ci
servono per il sync (contatti, cataloghi, eventi, registrazione webhook).
"""

import base64
import datetime as dt
import hashlib
import secrets
from urllib.parse import quote, urlencode

import httpx
import jwt
from django.conf import settings

from . import crypto
from .models import YourangConnection

TIMEOUT = 20.0
REFRESH_MARGIN = dt.timedelta(seconds=60)

# Scope OAuth richiesti (hardcoded come in food/real_estate auth.ts).
# `contacts:write` autorizza anche le scritture sul catalogo (qualsiasi scope
# :write rende il token READ_WRITE lato Yourang; non esiste `catalogues:write`).
SCOPES = "openid profile email offline_access contacts:read contacts:write events:read"


def _issuer() -> str:
    return settings.YOURANG_ISSUER_URL.rstrip("/")


def _api_base() -> str:
    return f"{_issuer()}/api/external/v1"


def redirect_uri() -> str:
    return f"{settings.FRONTEND_ORIGIN.rstrip('/')}/oauth-popup/done"


# OIDC discovery: gli endpoint authorize/token vanno letti dal documento, NON
# assunti (l'authorization_endpoint di Yourang sta sul frontend, non sull'issuer).
_discovery_cache: dict[str, dict] = {}


def _discovery() -> dict:
    issuer = _issuer()
    if issuer not in _discovery_cache:
        resp = httpx.get(f"{issuer}/.well-known/openid-configuration", timeout=TIMEOUT)
        resp.raise_for_status()
        _discovery_cache[issuer] = resp.json()
    return _discovery_cache[issuer]


# ---- PKCE + authorize URL --------------------------------------------------


def make_pkce() -> tuple[str, str]:
    """Ritorna (code_verifier, code_challenge) — challenge = base64url(sha256(verifier))."""
    verifier = secrets.token_urlsafe(64)[:96]
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def build_authorize_url(state: str, code_challenge: str, nonce: str) -> str:
    params = {
        "response_type": "code",
        "client_id": settings.YOURANG_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "scope": SCOPES,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{_discovery()['authorization_endpoint']}?{urlencode(params)}"


# ---- Token endpoint --------------------------------------------------------


def _token_request(data: dict) -> dict:
    data = {
        **data,
        "client_id": settings.YOURANG_CLIENT_ID,
        "client_secret": settings.YOURANG_CLIENT_SECRET,
    }
    resp = httpx.post(_discovery()["token_endpoint"], data=data, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


def exchange_code(code: str, code_verifier: str) -> dict:
    return _token_request(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri(),
            "code_verifier": code_verifier,
        }
    )


def _refresh(refresh_token: str) -> dict:
    return _token_request(
        {"grant_type": "refresh_token", "refresh_token": refresh_token}
    )


def claims_from_token(token: str | None) -> dict:
    """Decodifica i claim di un JWT SENZA verificarne la firma (token appena
    ottenuto dal token endpoint via TLS = canale fidato). Usato per `org`
    dall'access token e per sub/email/name dall'id_token OIDC."""
    if not token:
        return {}
    try:
        return jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError:
        return {}


def org_id_from_access_token(access_token: str) -> str:
    """Legge il claim `org` senza verificare la firma (token appena ottenuto via TLS)."""
    return str(claims_from_token(access_token).get("org") or "")


def store_tokens(conn: YourangConnection, token_resp: dict) -> None:
    """Persiste (cifrati) i token di una risposta del token endpoint."""
    conn.access_token_enc = crypto.encrypt(token_resp["access_token"])
    if token_resp.get("refresh_token"):  # rotation: aggiorna solo se presente
        conn.refresh_token_enc = crypto.encrypt(token_resp["refresh_token"])
    expires_in = int(token_resp.get("expires_in", 3600))
    conn.expires_at = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=expires_in)
    if token_resp.get("scope"):
        conn.scope = token_resp["scope"]


# ---- Client autenticato ----------------------------------------------------


class YourangClient:
    def __init__(self, conn: YourangConnection):
        self.conn = conn

    def _access_token(self) -> str:
        conn = self.conn
        expired = (
            conn.expires_at is None
            or dt.datetime.now(dt.timezone.utc) >= conn.expires_at - REFRESH_MARGIN
        )
        if expired:
            refresh_token = crypto.decrypt(conn.refresh_token_enc)
            if not refresh_token:
                raise RuntimeError("Nessun refresh token: riconnessione necessaria")
            store_tokens(conn, _refresh(refresh_token))
            conn.save(
                update_fields=["access_token_enc", "refresh_token_enc", "expires_at", "scope"]
            )
        return crypto.decrypt(conn.access_token_enc)

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self._access_token()}"}
        resp = httpx.request(
            method, f"{_api_base()}{path}", headers=headers, timeout=TIMEOUT, **kwargs
        )
        resp.raise_for_status()
        return resp

    @staticmethod
    def _data(resp: httpx.Response):
        return resp.json().get("data")

    # -- contatti --
    def list_contacts(self, limit: int = 100, offset: int = 0) -> list[dict]:
        resp = self._request("GET", f"/contacts?limit={limit}&offset={offset}")
        return self._data(resp) or []

    def upsert_contact_by_phone(self, phone: str, payload: dict) -> dict:
        # PUT by-phone: crea se manca, aggiorna se esiste (idempotente sul telefono).
        # Il '+' va percent-encodato o verrebbe letto come spazio nel path.
        resp = self._request(
            "PUT", f"/contacts/by-phone/{quote(phone, safe='')}", json=payload
        )
        return self._data(resp) or {}

    # -- cataloghi --
    def create_catalogue(self, name: str) -> dict:
        resp = self._request("POST", "/catalogues", json={"name": name})
        return self._data(resp) or {}

    def upsert_catalogue_item(self, item_id: str | None, payload: dict) -> dict:
        if item_id:
            resp = self._request("PUT", f"/catalogues/items/{item_id}", json=payload)
        else:
            resp = self._request("POST", "/catalogues/items", json=payload)
        return self._data(resp) or {}

    # -- eventi --
    def get_event(self, event_id: str) -> dict:
        resp = self._request("GET", f"/events/{event_id}")
        return self._data(resp) or {}

    # -- webhook --
    def register_webhook(self, target_url: str, event_types: list[str]) -> str:
        resp = self._request(
            "PUT",
            "/webhook-subscription",
            json={"target_url": target_url, "event_types": event_types},
        )
        data = self._data(resp) or {}
        return data.get("signing_secret", "")
