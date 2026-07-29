"""Gate d'accesso agli strumenti Yourang.

Il modello non è "piano gratuito / piano premium" ma **disponibilità dello
strumento**: uno strumento Yourang è usabile solo se il salone è collegato E ha
credito. I due motivi di blocco portano l'utente in due posti diversi, quindi
devono restare distinguibili fin dalla risposta HTTP:

    412 Precondition Failed  → collegamento non attivo
                               → l'utente va rimandato a Yourang per attivare il
                                 piano e fare il setting con gli specialisti
    402 Payment Required     → credito Yourang esaurito
                               → l'utente va rimandato a Yourang per ricaricare

Il frontend mappa lo status sul popup corretto (vedi `yourangGate` lato app):
il codice è il canale che porta il motivo, perché HttpError di Ninja trasporta
solo un messaggio.

Uso:

    from apps.integrations.gate import require_yourang
    require_yourang(salon)          # alza 412/402, oppure passa
"""

from ninja.errors import HttpError

from .models import YourangConnection

ACTIVE = "active"
NO_CREDIT = "no_credit"
NOT_CONNECTED = "not_connected"

# Messaggi user-facing: il popup lato UI ha il suo testo, questi servono ai
# client non-UI (curl, integrazioni) e come fallback.
MSG_NOT_CONNECTED = (
    "Collegamento a Yourang non attivo: attiva il piano su Yourang per usare "
    "questo strumento."
)
MSG_NO_CREDIT = (
    "Credito Yourang esaurito: ricarica su Yourang per continuare a usare "
    "questo strumento."
)


def connection_for(salon) -> YourangConnection | None:
    return YourangConnection.objects.filter(salon=salon).first()


def feature_state(salon) -> str:
    """Stato degli strumenti Yourang per il salone, senza alzare eccezioni."""
    conn = connection_for(salon)
    return conn.feature_state if conn else NOT_CONNECTED


def yourang_available(salon) -> bool:
    return feature_state(salon) == ACTIVE


def require_yourang(salon) -> YourangConnection:
    """Pretende uno strumento Yourang utilizzabile. Alza 412 o 402 col motivo."""
    conn = connection_for(salon)
    state = conn.feature_state if conn else NOT_CONNECTED
    if state == NOT_CONNECTED:
        raise HttpError(412, MSG_NOT_CONNECTED)
    if state == NO_CREDIT:
        raise HttpError(402, MSG_NO_CREDIT)
    return conn
