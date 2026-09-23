from datetime import datetime
from typing import Optional

from ninja import Schema


class AuthorizeOut(Schema):
    authorize_url: str
    # Da tenere nel sessionStorage della finestra che avvia il flusso e da
    # rimandare all'exchange: lega il codice a chi ha iniziato (vedi api.py).
    nonce: str


class ExchangeIn(Schema):
    """Link code monouso restituito dal proxy in ?yr_link=, più il flusso.

    PKCE e state verso Yourang restano del proxy; `state` qui è NOSTRO: firmato
    all'avvio, torna nel return_to e insieme al `nonce` dimostra che il codice
    è stato chiesto da questa finestra, per questa sessione. Facoltativi nello
    schema solo perché la loro assenza abbia un 400 con un messaggio, non un 422.
    """

    code: str
    mode: str = "login"
    state: str = ""
    nonce: str = ""


class StatusOut(Schema):
    connected: bool
    status: str = "disconnected"
    connected_at: Optional[datetime] = None
    last_sync_at: Optional[datetime] = None
    yourang_org_id: str = ""
    # Ultimo errore di sincronizzazione ("" se nessuno): la riga diceva
    # «Connesso · sincronizzati» anche con la sync ferma o parziale.
    last_error: str = ""


class OkOut(Schema):
    ok: bool = True
