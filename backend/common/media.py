"""Download dei file caricati sotto /media/.

I file pubblici (logo del salone, immagini delle comunicazioni) si servono così
come sono. Quelli riservati — allegati delle note cliente, foto delle schede
tecniche, fatture fornitore — solo con un token firmato e a scadenza nell'URL:
le API restituiscono già l'URL firmato (`signed_media_url`), così il browser
può aprire <img>/<a> senza header Authorization, mentre chi conosce soltanto il
percorso non scarica nulla. Prima chiunque avesse l'URL scaricava il file.
"""

import posixpath

from django.conf import settings
from django.core import signing
from django.http import HttpResponseForbidden
from django.views.static import serve

PRIVATE_PREFIXES = ("client_notes/", "technical_sheets/", "inventory/invoices/")
TOKEN_MAX_AGE = 4 * 3600  # secondi: la scheda cliente ricarica gli URL a ogni apertura
TOKEN_PARAM = "t"
_SALT = "youty.media"


def canonical_path(path: str) -> str:
    """Forma canonica del percorso richiesto, la stessa che userà `serve`.

    `django.views.static.serve` normalizza il percorso DOPO di noi: decidere
    sulla stringa grezza lasciava passare `/media/./client_notes/…`,
    `/media/x/../client_notes/…` e le varianti codificate, che collassano su un
    percorso riservato solo dopo la normalizzazione. Si normalizza prima, e la
    stessa forma vale per il controllo e per la verifica della firma.
    """
    return posixpath.normpath("/" + str(path or "").replace("\\", "/")).lstrip("/")


def is_private(path: str) -> bool:
    return canonical_path(path).startswith(PRIVATE_PREFIXES)


def sign_media_path(path: str) -> str:
    """Token «timestamp:firma» per il percorso relativo (senza il prefisso /media/)."""
    signed = signing.TimestampSigner(salt=_SALT).sign(path)
    return signed[len(path) + 1:]


def verify_media_token(path: str, token: str) -> bool:
    if not token:
        return False
    try:
        signing.TimestampSigner(salt=_SALT).unsign(f"{path}:{token}", max_age=TOKEN_MAX_AGE)
    except (signing.BadSignature, signing.SignatureExpired):
        return False
    return True


def signed_media_url(field_file) -> str:
    """URL del file; per i percorsi riservati porta il token firmato in query string."""
    try:
        url = field_file.url
    except ValueError:
        return ""
    name = field_file.name or ""
    if not is_private(name):
        return url
    return f"{url}?{TOKEN_PARAM}={sign_media_path(name)}"


def serve_media(request, path: str):
    """Vista per /media/<path>: verifica il token sui percorsi riservati, poi serve il file.

    Il percorso viene normalizzato prima di ogni decisione, e a `serve` si passa
    la forma canonica: così non esiste una scrittura alternativa dello stesso
    file che salti il controllo della firma.
    """
    canonical = canonical_path(path)
    if canonical.startswith(PRIVATE_PREFIXES) and not verify_media_token(
        canonical, request.GET.get(TOKEN_PARAM, "")
    ):
        return HttpResponseForbidden("Accesso al file non autorizzato o link scaduto")
    return serve(request, canonical, document_root=settings.MEDIA_ROOT)
