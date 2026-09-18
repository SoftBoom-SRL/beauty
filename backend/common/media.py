"""Download dei file caricati sotto /media/.

I file pubblici (logo del salone, immagini delle comunicazioni) si servono così
come sono. Quelli riservati — allegati delle note cliente, foto delle schede
tecniche, fatture fornitore — solo con un token firmato e a scadenza nell'URL:
le API restituiscono già l'URL firmato (`signed_media_url`), così il browser
può aprire <img>/<a> senza header Authorization, mentre chi conosce soltanto il
percorso non scarica nulla. Prima chiunque avesse l'URL scaricava il file.
"""

import posixpath
import uuid

from django.conf import settings
from django.core import signing
from django.http import HttpResponseForbidden
from django.views.static import serve
from ninja.errors import HttpError

PRIVATE_PREFIXES = ("client_notes/", "technical_sheets/", "inventory/invoices/")
TOKEN_MAX_AGE = 4 * 3600  # secondi: la scheda cliente ricarica gli URL a ogni apertura
TOKEN_PARAM = "t"
_SALT = "youty.media"

# ---------------------------------------------------------------------------
# Validazione degli upload
# ---------------------------------------------------------------------------
# Il Content-Type di un upload lo dichiara il client: si falsifica cambiando una
# riga della richiesta. Da solo non dice NIENTE sul contenuto del file, e il
# nome originale non dice niente sul tipo. Quello che conta davvero è
# l'estensione con cui il file finisce sul disco, perché è da lì che
# `django.views.static.serve` deduce il Content-Type in uscita: un evil.html
# caricato come "image/png" veniva riservito come text/html sull'origin
# dell'API, dove vive anche /admin/. Quindi: tipo dichiarato nella whitelist,
# estensione coerente col tipo dichiarato, e nome del file generato da noi.
UPLOAD_EXTENSIONS = {
    "image/jpeg": (".jpg", ".jpeg"),
    "image/png": (".png",),
    "image/webp": (".webp",),
    "image/gif": (".gif",),
    "image/heic": (".heic",),
    "image/heif": (".heif",),
    "application/pdf": (".pdf",),
    "text/plain": (".txt",),
    "application/msword": (".doc",),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": (".docx",),
}

IMAGE_CONTENT_TYPES = (
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
)
DOCUMENT_CONTENT_TYPES = (
    "application/pdf",
    "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
)

# Estensioni che il browser può aprire nella pagina senza poter eseguire nulla.
# Tutto il resto (pdf, doc, txt, e qualunque file caricato prima di questa
# regola) esce con Content-Disposition: attachment.
INLINE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"})

# Tetto di default: lo stesso di ClientNoteAttachment.MAX_BYTES.
MAX_UPLOAD_BYTES = 15 * 1024 * 1024


def upload_extension(filename: str) -> str:
    """Estensione minuscola del nome file, punto compreso («.jpg»); «» se assente."""
    return posixpath.splitext(str(filename or "").replace("\\", "/"))[1].lower()


def validate_upload(uploaded, *, allowed_types, max_bytes: int = MAX_UPLOAD_BYTES) -> tuple[str, str]:
    """Valida un upload e restituisce `(content_type, estensione)` normalizzati.

    Solleva HttpError 400 con un messaggio leggibile dall'operatrice. Va chiamata
    PRIMA di scrivere qualunque cosa su disco.
    """
    name = str(getattr(uploaded, "name", "") or "file")
    ctype = (getattr(uploaded, "content_type", "") or "").lower().split(";")[0].strip()
    if ctype not in allowed_types or ctype not in UPLOAD_EXTENSIONS:
        raise HttpError(400, f"Formato non supportato: {name} (immagini, PDF, Word o testo)")
    ext = upload_extension(name)
    # L'estensione deve corrispondere al tipo dichiarato: un .html spacciato per
    # image/png si ferma qui, e un .png spacciato per application/pdf pure.
    if ext not in UPLOAD_EXTENSIONS[ctype]:
        attesi = " o ".join(UPLOAD_EXTENSIONS[ctype])
        raise HttpError(400, f"Estensione non coerente col formato: {name} (atteso {attesi})")
    size = getattr(uploaded, "size", 0) or 0
    if size > max_bytes:
        raise HttpError(400, f"File troppo grande: {name} (max {max_bytes // (1024 * 1024)} MB)")
    return ctype, ext


def stored_upload_name(uploaded, *, allowed_types, max_bytes: int = MAX_UPLOAD_BYTES) -> str:
    """Valida l'upload e restituisce il nome con cui salvarlo su disco.

    Il nome lo genera il server: quello del client può contenere percorsi, una
    doppia estensione («foto.png.html») o ripetere quello di un file già
    presente. Il nome originale, se serve mostrarlo, va tenuto in un campo del
    modello — non nel filesystem.
    """
    _ctype, ext = validate_upload(uploaded, allowed_types=allowed_types, max_bytes=max_bytes)
    return f"{uuid.uuid4().hex}{ext}"


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
    # Confronto in minuscolo: su un filesystem case-insensitive (macOS in
    # sviluppo, un volume SMB in produzione) «Client_notes/…» apre lo stesso
    # file di «client_notes/…», e con il confronto sensibile alle maiuscole
    # saltava la verifica della firma.
    return canonical_path(path).lower().startswith(PRIVATE_PREFIXES)


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
    if is_private(canonical) and not verify_media_token(
        canonical, request.GET.get(TOKEN_PARAM, "")
    ):
        return HttpResponseForbidden("Accesso al file non autorizzato o link scaduto")
    response = serve(request, canonical, document_root=settings.MEDIA_ROOT)
    # /media/ vive sull'origin dell'API, lo stesso di /admin/: un file servito
    # come pagina eseguirebbe il suo JavaScript lì dentro, con i cookie di
    # sessione dell'amministratore. Solo le immagini vere si aprono nella
    # pagina; tutto il resto si scarica e basta. `nosniff` chiude la strada al
    # browser che prova a indovinare il tipo ignorando il Content-Type.
    response["X-Content-Type-Options"] = "nosniff"
    if upload_extension(canonical) not in INLINE_EXTENSIONS:
        filename = posixpath.basename(canonical).replace('"', "").replace("\\", "")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response
