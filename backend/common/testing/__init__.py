"""Aiuti condivisi dai test di tutte le app.

Solo le funzioni piccole che più app riscrivevano identiche. Niente fabbriche
di dati «intelligenti»: nei dati di prova i dettagli cambiano il comportamento
sotto test (un ruolo chiamato «Manager» viene adottato come ruolo di sistema
da `ensure_default_roles`, un telefono uguale fa scattare il vincolo di
unicità), quindi restano scritti nei test che li usano, o nel `base.py` dei
test di quell'app.

Il package non si chiama `testing.py` né `test_*.py`: il runner di Django
tratta come modulo di test ogni file che corrisponde a `test*.py`, e qui dentro
non ci sono test da eseguire.
"""

import datetime as dt
import json

from django.utils import timezone

from common.auth import StaffContext, create_client_tokens, create_staff_tokens


def aware(day: dt.date, hour: int, minute: int = 0) -> dt.datetime:
    """Data e ora nel fuso del progetto (TIME_ZONE), come le scrive un salone."""
    return timezone.make_aware(dt.datetime.combine(day, dt.time(hour, minute)))


def post_json(client, url, data, **extra):
    """POST con corpo JSON dal client di test di Django."""
    return client.post(url, data=json.dumps(data), content_type="application/json", **extra)


def put_json(client, url, data, **extra):
    """PUT con corpo JSON dal client di test di Django."""
    return client.put(url, data=json.dumps(data), content_type="application/json", **extra)


def bearer(user, salon) -> dict:
    """Header di un membro staff autenticato.

    Conia i token con `create_staff_tokens`, quindi registra anche la sessione
    (una riga di StaffRefreshToken), esattamente come il login.
    """
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


def client_bearer(client) -> dict:
    """Header di una cliente autenticata nella web app."""
    return {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client)['access']}"}


def staff_context(salon, scopes=(), *, is_owner: bool = False, user=None, membership=None) -> StaffContext:
    """Il contesto che l'autenticazione staff mette in `request.auth`.

    Serve ai test che chiamano una vista o un servizio direttamente, senza
    passare dall'HTTP.
    """
    return StaffContext(user=user, salon=salon, membership=membership, scopes=set(scopes), is_owner=is_owner)
