"""Aiuti condivisi dai moduli di test dell'integrazione Yourang.

Solo ciò che serve a più di un modulo: la chiave di cifratura dei test, la firma
dei webhook, le impostazioni del flusso diretto verso l'external API e il client
httpx finto con i suoi aiuti. Niente classi con test: un modulo che le
importasse le farebbe girare due volte.
"""

import hashlib
import hmac
from datetime import timedelta
from unittest import mock

import httpx
from django.utils import timezone

from apps.integrations import crypto
from apps.integrations.models import YourangConnection

# 32-byte hex key (openssl rand -hex 32) — stesso formato di food/real_estate.
TEST_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

API = "/api/external/v1"
# Il flusso diretto verso l'external API: emittente e chiave dei token cifrati.
# Da non confondere con OAUTH_SETTINGS di test_oauth (client OAuth, ricevitore
# del webhook, origin del frontend).
API_SETTINGS = dict(YOURANG_ISSUER_URL="https://yourang.invalid", ENCRYPTION_KEY=TEST_KEY)


def sign_webhook(body: bytes, ts: str, secret: str) -> str:
    """La firma che Yourang mette in x-yourang-signature: HMAC-SHA256 di «<ts>.<corpo>».

    È la ricetta che crypto.verify_signature controlla, scritta una volta sola
    per tutti i test che firmano un webhook.
    """
    return "sha256=" + hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()


def _connection(salon, org, **extra):
    """Connessione del flusso diretto, con un token ancora valido (niente refresh)."""
    return YourangConnection.objects.create(
        salon=salon,
        yourang_org_id=org,
        access_token_enc=crypto.encrypt("tok"),
        refresh_token_enc=crypto.encrypt("ref"),
        expires_at=timezone.now() + timedelta(hours=1),
        **extra,
    )


class FakeHttp:
    """httpx.Client finto: registra (metodo, path) e risponde come l'external API."""

    # Lo stato sta sulla classe, perché le istanze le crea il codice sotto test:
    # ogni test che lo usa lo riassegna nel suo setUp (o in testa al test).
    instances: list["FakeHttp"] = []
    contacts: dict = {}
    missing_route = False

    def __init__(self, *args, **kwargs):
        self.calls = []
        self.closed = False
        FakeHttp.instances.append(self)

    def request(self, method, url, headers=None, timeout=None, **kwargs):
        path = url.split(API, 1)[1]
        self.calls.append((method, path))
        status, data = 200, {}
        if method == "GET" and path.startswith("/contacts?"):
            data = list(FakeHttp.contacts.values())
        elif method == "GET" and path.startswith("/contacts/"):
            rid = path.rsplit("/", 1)[1]
            if FakeHttp.missing_route or rid not in FakeHttp.contacts:
                status = 404
            else:
                data = FakeHttp.contacts[rid]
        elif method == "POST" and path == "/contacts":
            status = 403  # scope contacts:write mancante
        elif method == "POST" and path == "/catalogues":
            data = {"id": "cat-new"}
        else:
            data = {"id": f"x-{len(self.calls)}"}
        resp = mock.Mock(status_code=status)
        resp.json.return_value = {"ok": status == 200, "data": data}
        if status >= 400:
            resp.raise_for_status.side_effect = httpx.HTTPStatusError(
                str(status), request=mock.Mock(), response=resp
            )
        return resp

    def close(self):
        self.closed = True


def _all_calls():
    return [call for http in FakeHttp.instances for call in http.calls]
