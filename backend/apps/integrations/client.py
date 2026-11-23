"""Client HTTP verso Yourang attraverso il proxy connect.yourang.ai.

Il proxy è l'OAuth client di tutti i portali: custodisce i token di ogni org e
li rinnova sotto mutex (Yourang ruota il refresh token a ogni uso e brucia la
famiglia quando due refresh corrono insieme: un solo posto può farlo, ed è il
proxy). Qui restano l'URL di login, il riscatto del link code e i wrapper delle
rotte external API che servono al sync e all'assistente vocale.

Le colonne dei token su YourangConnection restano (espansione soltanto): un
rollback al flusso diretto le ritrova. Questo codice non le legge più.
"""

from urllib.parse import quote, urlencode

import httpx
from django.conf import settings

from .models import YourangConnection

TIMEOUT = 20.0


def _proxy_base() -> str:
    """Base del portale sul proxy: https://connect.yourang.ai/v/<slug>."""
    return f"{settings.YOURANG_PROXY_URL.rstrip('/')}/v/{settings.YOURANG_PROXY_SLUG}"


def _api_base() -> str:
    # Il proxy inoltra /v/<slug>/api/<path> a /api/external/v1/<path>.
    return f"{_proxy_base()}/api"


def proxy_login_url(return_to: str) -> str:
    """Dove mandare il browser per consenso e login; il proxy torna su
    `return_to` aggiungendo ?yr_link=. `return_to` deve stare sull'origine del
    portale registrata nel proxy (portal_origin), o il proxy risponde 400."""
    return f"{_proxy_base()}/auth/login?{urlencode({'return_to': return_to})}"


def redeem_link_code(code: str) -> dict:
    """Scambia il codice monouso (?yr_link=) con l'identità dietro di esso.

    Server-to-server con l'API key, che non tocca mai il browser. Ritorna
    {sub, email, email_verified, name, org_id}.
    """
    resp = httpx.post(
        f"{_proxy_base()}/auth/link",
        json={"code": code},
        headers={"Authorization": f"Bearer {settings.YOURANG_PROXY_API_KEY}"},
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()


# ---- Client autenticato ----------------------------------------------------


class YourangClient:
    def __init__(self, conn: YourangConnection):
        self.conn = conn
        self._http: httpx.Client | None = None

    # `with YourangClient(conn) as client:` apre UN client httpx per tutto il
    # giro e ne riusa le connessioni. Prima ogni chiamata ne apriva una nuova
    # (httpx.request crea e chiude un client ogni volta): un giro di sync con
    # qualche migliaio di schede erano migliaia di handshake TLS verso Yourang.
    # Fuori da un `with` si resta alla chiamata singola, che per un evento o un
    # contatto basta.
    def __enter__(self):
        self._http = httpx.Client(timeout=TIMEOUT)
        return self

    def __exit__(self, *exc_info):
        http, self._http = self._http, None
        if http is not None:
            http.close()

    def _request(self, method: str, path: str, **kwargs) -> httpx.Response:
        # X-Yourang-Org è un selettore, non un'asserzione: il proxy usa solo un
        # grant che quell'org ha già concesso, un'org mai collegata riceve 401.
        if not self.conn.yourang_org_id:
            raise RuntimeError("Connessione Yourang senza organizzazione: ricollegare")
        headers = {
            "Authorization": f"Bearer {settings.YOURANG_PROXY_API_KEY}",
            "X-Yourang-Org": self.conn.yourang_org_id,
        }
        send = self._http.request if self._http is not None else httpx.request
        resp = send(
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

    def get_contact(self, contact_id: str) -> dict:
        # L'id arriva dal webhook, non è nostro: percent-encodato come gli altri.
        resp = self._request("GET", f"/contacts/{quote(str(contact_id), safe='')}")
        return self._data(resp) or {}

    def create_or_get_contact(self, phone: str, payload: dict) -> dict:
        """Crea il contatto; se il telefono esiste già lo recupera e basta.

        L'external API NON ha un upsert by-phone (solo GET/PATCH/DELETE; il PUT
        vive su /contacts/{id}), e il telefono è univoco per org → la create
        risponde 400 quando c'è già. Il '+' va percent-encodato nel path o
        verrebbe letto come spazio.
        """
        try:
            resp = self._request(
                "POST", "/contacts", json={**payload, "phone_number": phone}
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 400:
                raise
            resp = self._request("GET", f"/contacts/by-phone/{quote(phone, safe='')}")
        return self._data(resp) or {}

    # -- cataloghi --
    def create_catalogue(self, name: str) -> dict:
        resp = self._request("POST", "/catalogues", json={"name": name})
        return self._data(resp) or {}

    def upsert_catalogue_item(self, item_id: str | None, payload: dict) -> dict:
        if item_id:
            # L'id remoto va percent-encodato: httpx normalizza i dot-segment,
            # quindi un id come "1/../../contacts" cambierebbe rotta alla
            # chiamata (.../catalogues/items/… diventa .../contacts).
            resp = self._request(
                "PUT", f"/catalogues/items/{quote(str(item_id), safe='')}", json=payload
            )
        else:
            resp = self._request("POST", "/catalogues/items", json=payload)
        return self._data(resp) or {}

    # -- eventi --
    def get_event(self, event_id: str) -> dict:
        # Stesso motivo dell'upsert: l'id arriva dal webhook, non è nostro.
        resp = self._request("GET", f"/events/{quote(str(event_id), safe='')}")
        return self._data(resp) or {}

    # -- assistente vocale: strumenti esterni e agenti --
    def upsert_external_tool(self, tool: dict) -> dict:
        """Crea o aggiorna, per nome, uno strumento esterno dell'org (tutti gli agenti)."""
        name = quote(tool["tool_name"], safe="")
        resp = self._request("PUT", f"/external-tools/{name}", json=tool)
        return self._data(resp) or {}

    def delete_external_tool(self, tool_name: str) -> None:
        try:
            self._request("DELETE", f"/external-tools/{quote(tool_name, safe='')}")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:  # già tolto da Yourang: va bene così
                raise

    def list_inbound_agents(self) -> list[dict]:
        # ponytail: una pagina da 100, un salone non ha più agenti al telefono
        resp = self._request("GET", "/agents/?agent_type=inbound&limit=100")
        return self._data(resp) or []

    def disable_builtin_booking(self, agent_id: str) -> None:
        """Spegne `make_reservation`, lo strumento di prenotazione interno di Yourang.

        Acceso insieme agli strumenti del salone, la stessa prenotazione arrivava
        due volte: una dall'agenda, una come evento Yourang importato dal webhook.
        """
        try:
            self._request(
                "PATCH",
                f"/agents/{quote(str(agent_id), safe='')}/tools/make-reservation",
                json={"is_enabled": False},
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 404:  # agente senza quello strumento
                raise
