"""Note interne, allegati e schede tecniche della cliente: uscita e file.

Note e schede escono come dizionari (`note_out`, `sheet_out`) con gli URL dei
file già firmati: allegati e foto stanno sotto prefissi riservati di /media/ e
si scaricano solo con il token (common.media). Gli upload passano dalla regola
unica di common.media: tipo dichiarato nella whitelist, estensione coerente col
tipo, nome del file generato dal server.
"""

from ninja.errors import HttpError
from ninja.files import UploadedFile

from common.media import signed_media_url, stored_upload_name, validate_upload

from .models import Client, ClientNote, ClientNoteAttachment, TechnicalSheet


def note_out(note: ClientNote) -> dict:
    author = getattr(note, "author", None)
    return {
        "id": note.id,
        "client_id": note.client_id,
        "appointment_id": note.appointment_id,
        "text": note.text,
        "visibility": note.visibility,
        "author_id": note.author_id,
        "author_name": (author.get_full_name() or author.email) if author else "",
        "attachments": [attachment_out(a) for a in note.attachments.all()],
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


def attachment_out(att: ClientNoteAttachment) -> dict:
    # URL firmato e a scadenza: gli allegati delle note sono riservati e il
    # download sotto /media/ non passa dall'autenticazione delle API.
    return {
        "id": att.id,
        "name": att.name,
        "url": signed_media_url(att.file),
        "content_type": att.content_type,
        "size": att.size,
        "is_image": att.is_image,
        "created_at": att.created_at,
    }


def sheet_out(sheet: TechnicalSheet) -> dict:
    author = getattr(sheet, "author", None)
    return {
        "id": sheet.id,
        "client_id": sheet.client_id,
        "appointment_id": sheet.appointment_id,
        "category": sheet.category,
        "treatment": sheet.treatment,
        "zone": sheet.zone,
        "products": sheet.products,
        "params": sheet.params,
        "outcome": sheet.outcome,
        "duration_hold": sheet.duration_hold,
        "advice": sheet.advice,
        "protocol": sheet.protocol,
        "next_step": sheet.next_step,
        "photo": signed_media_url(sheet.photo) if sheet.photo else None,
        "author_id": sheet.author_id,
        "author_name": (author.get_full_name() or author.email) if author else "",
        "created_at": sheet.created_at,
    }


def appointment_for(ctx, client: Client, appointment_id):
    """L'appuntamento di QUESTA cliente nel salone, None senza id, 404 se non è suo."""
    if not appointment_id:
        return None
    from apps.agenda.models import Appointment  # lazy

    appointment = Appointment.objects.filter(salon=ctx.salon, client=client, id=appointment_id).first()
    if appointment is None:
        raise HttpError(404, "Appuntamento non trovato per questo cliente")
    return appointment


# Tipi ammessi negli allegati di una nota: quelli del modello, che l'interfaccia
# già dichiara. Il controllo vero (estensione coerente col tipo e nome generato
# dal server) sta in common.media, unico posto dove vive questa regola.
ATTACHMENT_TYPES = ClientNoteAttachment.IMAGE_TYPES + ClientNoteAttachment.DOC_TYPES


def validate_attachment(f: UploadedFile) -> None:
    """Controlla un allegato prima di scrivere qualunque cosa su disco.

    Guardava solo il tipo DICHIARATO dal client — che si falsifica cambiando una
    riga della richiesta — e salvava il file col nome scelto da chi caricava: un
    «foto.png.html» spacciato per image/png finiva su /media/ con estensione
    .html, sullo stesso origin di /admin/.
    """
    validate_upload(f, allowed_types=ATTACHMENT_TYPES, max_bytes=ClientNoteAttachment.MAX_BYTES)


def attach_files(note: ClientNote, files: list[UploadedFile]) -> None:
    # Prima tutti i controlli, poi le scritture: un file rifiutato a metà elenco
    # lasciava a terra gli allegati già salvati.
    names = [
        stored_upload_name(f, allowed_types=ATTACHMENT_TYPES, max_bytes=ClientNoteAttachment.MAX_BYTES)
        for f in files
    ]
    for f, stored in zip(files, names):
        # Il nome originale resta nel campo descrittivo (è quello che
        # l'operatrice ha scritto e riconosce); sul disco ci va quello nostro.
        att = ClientNoteAttachment(
            note=note,
            name=(f.name or "")[:200],
            content_type=(f.content_type or "")[:100],
            size=f.size,
        )
        att.file.save(stored, f, save=True)


def replace_sheet_photo(sheet: TechnicalSheet, photo: UploadedFile) -> None:
    """Sostituisce la foto della scheda: la vecchia si cancella dal disco."""
    # Stessa regola degli allegati: tipo dichiarato nella whitelist, estensione
    # coerente e nome generato dal server. La foto finisce sotto
    # technical_sheets/, servito dallo stesso origin di /admin/.
    stored = stored_upload_name(
        photo,
        allowed_types=ClientNoteAttachment.IMAGE_TYPES,
        max_bytes=ClientNoteAttachment.MAX_BYTES,
    )
    if sheet.photo:
        sheet.photo.delete(save=False)
    sheet.photo.save(stored, photo, save=True)
