from datetime import datetime
from typing import Optional

from ninja import Schema


class AuthorizeOut(Schema):
    authorize_url: str
    # Da tenere nel sessionStorage della finestra che avvia il flusso e da
    # rimandare all'exchange: lega il codice a chi ha iniziato (vedi oauth.py).
    nonce: str


class ExchangeIn(Schema):
    """Il `code` e lo `state` che Yourang rimanda al popup, più il `nonce`.

    Lo `state` sta a database con il verifier PKCE (YourangOAuthState); il
    `nonce` lo tiene solo la finestra che ha avviato il flusso, e dimostra che
    il codice torna a chi l'ha chiesto (vedi oauth.py). Facoltativo nello schema
    solo perché la sua assenza abbia un 400 con un messaggio, non un 422.
    """

    code: str
    state: str
    nonce: str = ""


class StatusOut(Schema):
    connected: bool
    status: str = "disconnected"
    connected_at: Optional[datetime] = None
    last_sync_at: Optional[datetime] = None
    scope: str = ""
    yourang_org_id: str = ""
    # Ultimo errore di sincronizzazione ("" se nessuno): la riga diceva
    # «Connesso · sincronizzati» anche con la sync ferma o parziale.
    last_error: str = ""
