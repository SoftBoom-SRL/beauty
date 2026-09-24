"""Orologio fermo e caso ripetibile per i processi Python dello smoke test.

Importato da seed.py e serve.py PRIMA di Django: così ogni `datetime.now()`,
`timezone.now()`, `date.today()` e `time.time()` del backend vede lo stesso
istante del browser (SMOKE_NOW, oggi alle 10:30 ora del salone) e i timestamp
scritti nel database (created_at, scadenze, cursori del feed live) sono
identici da un'esecuzione all'altra. `time.monotonic()` e `time.sleep()` restano
veri: lo stream SSE e i timeout continuano a funzionare.

L'orologio è fermo (tick=False), non solo spostato: con un orologio che scorre
le fasce orarie di oggi proposte dalla disponibilità, i «x min fa» e i
created_at cambierebbero a seconda di quanto dura l'esecuzione.
"""

import base64
import datetime as dt
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PYLIB = os.path.join(HERE, "pylib")
if PYLIB not in sys.path:
    sys.path.insert(0, PYLIB)


def start_clock():
    """Ferma l'orologio a SMOKE_NOW (ISO 8601 con fuso). Senza variabile: niente."""
    now = os.environ.get("SMOKE_NOW", "").strip()
    if not now:
        return None
    import time_machine  # dal venv (requirements-dev.txt) o da tools/smoke/pylib (vedi README)

    dest = dt.datetime.fromisoformat(now)
    traveller = time_machine.travel(dest, tick=False)
    traveller.start()
    return traveller


def seed_rng(seed: int):
    """Sostituisce le fonti di caso del backend con un generatore a seme fisso.

    Va chiamata PRIMA di `django.setup()`: i modelli catturano `uuid.uuid4` come
    default dei campi (Automation.webhook_token, Invitation.token) quando la
    classe viene definita, e una sostituzione successiva non li toccherebbe.
    Copre `secrets` (codici gift card/coupon via common.utils.human_code, sali
    delle password, jti, ticket SSE, OTP), `random` e `uuid.uuid4`.
    """
    import secrets
    import uuid

    rng = random.Random(seed)
    random.seed(seed)

    def token_bytes(nbytes=None):
        return rng.randbytes(32 if nbytes is None else nbytes)

    def token_hex(nbytes=None):
        return token_bytes(nbytes).hex()

    def token_urlsafe(nbytes=None):
        return base64.urlsafe_b64encode(token_bytes(nbytes)).rstrip(b"=").decode("ascii")

    secrets.token_bytes = token_bytes
    secrets.token_hex = token_hex
    secrets.token_urlsafe = token_urlsafe
    secrets.choice = rng.choice
    secrets.randbelow = lambda n: rng.randrange(n)
    secrets.randbits = rng.getrandbits
    uuid.uuid4 = lambda: uuid.UUID(bytes=rng.randbytes(16), version=4)
    return rng


def django_env(backend_dir: str):
    """Rende importabile il backend indicato e ne seleziona i settings."""
    backend_dir = os.path.abspath(backend_dir)
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    os.chdir(backend_dir)
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    return backend_dir
