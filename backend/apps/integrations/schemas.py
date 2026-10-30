from datetime import datetime
from typing import Optional, Union

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


class VoiceStatusOut(Schema):
    """Stato dell'assistente vocale.

    `active`: gli strumenti sono installati su Yourang e la chiave vale.
    `connected`: il salone è collegato a Yourang (senza, non si può attivare).
    `needs_reconnect`: collegato prima che servissero gli scope `agents:*`;
    va ricollegato per attivarlo.
    """

    active: bool
    created_at: Optional[datetime] = None
    connected: bool
    needs_reconnect: bool


class AutomationKeyOut(Schema):
    """Stato della chiave per gli strumenti esterni (n8n, Make, Zapier).

    `key` c'è solo nella risposta che la genera: dopo non la si rilegge più.
    """

    active: bool
    created_at: Optional[datetime] = None
    key: Optional[str] = None


class VoiceAppointmentIn(Schema):
    """Prenotazione dell'agente vocale.

    Campi tutti facoltativi e di tipo largo per scelta: un campo mancante o del
    tipo sbagliato deve arrivare all'agente come `success: false` con un
    messaggio che sa correggere, non come un 422 che Yourang gli nasconde.
    `services` sono gli id di `list_services`, separati da virgola («12,15»).
    """

    date: str = ""
    time: str = ""
    services: Union[str, int, list[Union[int, str]]] = ""
    customer_name: str = ""
    customer_phone: Union[str, int] = ""
    notes: str = ""


class VoiceRescheduleIn(Schema):
    """Spostamento dell'agente vocale: tipi larghi come in VoiceAppointmentIn."""

    appointment_id: Union[str, int] = ""
    customer_phone: Union[str, int] = ""
    date: str = ""
    time: str = ""


class VoiceCancelIn(Schema):
    appointment_id: Union[str, int] = ""
    customer_phone: Union[str, int] = ""
