"""Flusso OAuth di Yourang (Authorization Code + PKCE): avvio e consumo dello state.

Due flussi usano gli stessi passi: «Collega Yourang» dalle Impostazioni (lo
state porta salone e utente) e «Accedi con Yourang» dalla pagina di login
(state senza salone). Stavano in mezzo agli endpoint di api.py; qui c'è la
parte che decide se il codice che torna da Yourang è davvero di chi ha
avviato il flusso, e da quale flusso viene.
"""

import secrets

from django.utils import timezone
from django.utils.crypto import constant_time_compare, salted_hmac
from ninja.errors import HttpError

from . import client as yc
from .models import YourangOAuthState

# Secondi di validità di uno state avviato e non ancora scambiato.
STATE_TTL_SECONDS = 600


# ---- Chi ha chiesto questo codice? ------------------------------------------
#
# Lo `state` sta a database con il verifier PKCE, e basta a legare il codice al
# flusso. Non lega però il flusso alla FINESTRA che l'ha avviato: chi avviava un
# «Accedi con Yourang» con la propria identità poteva mandare a un altro il link
# di ritorno (/oauth-popup/done?code=…&state=…), e chi lo apriva si ritrovava
# dentro il salone di chi l'aveva mandato, a scriverci dati (10-02). L'avvio
# restituisce quindi anche un `nonce`, che il popup tiene nel sessionStorage
# della sua finestra (un link aperto altrove non ce l'ha) e rimanda
# all'exchange. È l'HMAC dello state con la chiave del server: nessuna colonna
# in più, e nessuno può ricavarlo dallo state.
#
# Il sale ha la forma di un percorso di modulo ma è un valore fisso, che non
# segue il codice quando si sposta: cambiarlo cambierebbe il nonce, e i flussi
# avviati prima di un deploy verrebbero rifiutati al ritorno.

NONCE_SALT = "apps.integrations.yourang-oauth-window"
_BAD_FLOW = "Richiesta di collegamento non valida: riavvia «Yourang» da questa finestra"


def window_nonce(state: str) -> str:
    return salted_hmac(NONCE_SALT, state).hexdigest()


def start_flow(salon=None, user=None) -> dict:
    verifier, challenge = yc.make_pkce()
    state = secrets.token_urlsafe(24)
    YourangOAuthState.objects.create(state=state, code_verifier=verifier, salon=salon, user=user)
    return {
        "authorize_url": yc.build_authorize_url(state, challenge, nonce=secrets.token_urlsafe(16)),
        "nonce": window_nonce(state),
    }


def consume_state(data) -> tuple:
    """Verifica il nonce e consuma lo state: ritorna (verifier PKCE, salone, utente).

    Lo state vale una volta sola: si cancella appena letto, anche quando è
    scaduto. Salone e utente sono None nel flusso «Accedi con Yourang».
    """
    # Il nonce si controlla PRIMA di consumare lo state: un link di ritorno
    # aperto in un'altra finestra non deve né usarlo né bruciarlo.
    if not data.nonce or not constant_time_compare(data.nonce, window_nonce(data.state)):
        raise HttpError(400, _BAD_FLOW)

    st = (
        YourangOAuthState.objects.select_related("salon", "user")
        .filter(state=data.state)
        .first()
    )
    if st is None:
        raise HttpError(400, "Stato OAuth non valido o scaduto")
    age = (timezone.now() - st.created_at).total_seconds()
    verifier, salon, user = st.code_verifier, st.salon, st.user
    st.delete()
    if age > STATE_TTL_SECONDS:
        raise HttpError(400, "Stato OAuth scaduto: riprova")
    return verifier, salon, user
