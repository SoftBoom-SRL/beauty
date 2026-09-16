"""Anagrafica clienti: etichette, cliente, note interne, schede tecniche.

Letture base → solo `staff_auth`. Scritture → scope "clients" (vedi
common.permissions). Le schede tecniche sono uno storico immutabile: solo
GET (lista) e POST (creazione), nessun endpoint di update/delete.
"""

import logging
from typing import Optional

from django.core.cache import cache
from django.db.models import Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from apps.agenda.schemas import AppointmentOut
from apps.core.models import Salon, SalonSettings
from apps.core.services import emit_event, log_activity
from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from .models import Client, ClientCategory, ClientNote, ClientNoteAttachment, TechnicalSheet
from .schemas import (
    AttachmentOut,
    CategoryIn,
    CategoryOut,
    HookLeadIn,
    HookLeadOut,
    ClientDetailOut,
    ClientIn,
    ClientOut,
    ImportIn,
    ImportOut,
    NoteIn,
    NoteOut,
    NoteUpdateIn,
    OkOut,
    TechnicalSheetIn,
    TechnicalSheetOut,
)
from .services import client_stats, import_rows, normalize_gender, parse_birthday

logger = logging.getLogger("youty.clients")
router = Router(tags=["clients"])


# ---- Etichette (ClientCategory) ---------------------------------------------


@router.get("/categories", auth=staff_auth, response=list[CategoryOut])
def list_categories(request):
    return request.auth.salon.client_categories.all()


@router.post("/categories", auth=staff_auth, response=CategoryOut)
def create_category(request, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = ClientCategory.objects.create(salon=ctx.salon, **data.dict())
    log_activity(
        ctx.salon,
        "client_category.created",
        f"Etichetta creata: {category.name}",
        actor=ctx.user,
        payload={"category_id": category.id},
    )
    return category


@router.put("/categories/{int:category_id}", auth=staff_auth, response=CategoryOut)
def update_category(request, category_id: int, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = salon_get(ClientCategory, ctx, category_id)
    for name, value in data.dict().items():
        setattr(category, name, value)
    category.save()
    log_activity(
        ctx.salon,
        "client_category.updated",
        f"Etichetta aggiornata: {category.name}",
        actor=ctx.user,
        payload={"category_id": category.id},
    )
    return category


@router.delete("/categories/{int:category_id}", auth=staff_auth, response=OkOut)
def delete_category(request, category_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = salon_get(ClientCategory, ctx, category_id)
    name = category.name
    category.delete()
    log_activity(
        ctx.salon,
        "client_category.deleted",
        f"Etichetta eliminata: {name}",
        actor=ctx.user,
        payload={"category_id": category_id},
    )
    return OkOut()


# ---- Cliente ------------------------------------------------------------------


def _set_categories(client: Client, category_ids: list[int]) -> None:
    categories = ClientCategory.objects.filter(salon=client.salon_id, id__in=category_ids)
    client.categories.set(categories)


def _check_phone_unique(ctx, phone: str, *, exclude_id: Optional[int] = None) -> None:
    qs = Client.objects.filter(salon=ctx.salon, phone=phone)
    if exclude_id is not None:
        qs = qs.exclude(id=exclude_id)
    if qs.exists():
        raise HttpError(400, "Telefono già registrato per un altro cliente")


@router.get("/", auth=staff_auth, response=list[ClientOut])
@paginate(LimitOffsetPagination)
def list_clients(
    request,
    q: str = "",
    category_id: Optional[int] = None,
    reliability_min: Optional[int] = None,
    reliability_max: Optional[int] = None,
    is_active: Optional[bool] = None,
):
    ctx = request.auth
    qs = Client.objects.filter(salon=ctx.salon).prefetch_related("categories")
    if q:
        qs = qs.filter(
            Q(first_name__icontains=q)
            | Q(last_name__icontains=q)
            | Q(phone__icontains=q)
            | Q(email__icontains=q)
        )
    if category_id is not None:
        qs = qs.filter(categories__id=category_id)
    if reliability_min is not None:
        qs = qs.filter(reliability__gte=reliability_min)
    if reliability_max is not None:
        qs = qs.filter(reliability__lte=reliability_max)
    if is_active is not None:
        qs = qs.filter(is_active=is_active)
    return qs.distinct()


def _client_payload(data: ClientIn) -> tuple[dict, list[int]]:
    """ClientIn → kwargs del modello: compleanno (con/senza anno) e genere validati."""
    payload = data.dict()
    category_ids = payload.pop("category_ids")
    payload["phone"] = payload["phone"].strip()
    payload["gender"] = normalize_gender(payload.get("gender") or "")
    birthday, year_known = parse_birthday(payload.pop("birthday", None))
    payload["birthday"] = birthday
    payload["birthday_year_known"] = year_known
    if not payload["first_name"].strip():
        raise HttpError(400, "Il nome è obbligatorio")
    if not payload["phone"]:
        raise HttpError(400, "Il telefono è obbligatorio")
    return payload, category_ids


@router.post("/", auth=staff_auth, response=ClientOut)
def create_client(request, data: ClientIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    payload, category_ids = _client_payload(data)
    phone = payload["phone"]
    _check_phone_unique(ctx, phone)
    client = Client.objects.create(salon=ctx.salon, **payload)
    _set_categories(client, category_ids)
    log_activity(
        ctx.salon,
        "client.created",
        f"Cliente creato: {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id},
    )
    return client


@router.get("/{int:client_id}", auth=staff_auth, response=ClientDetailOut)
def get_client(request, client_id: int):
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)
    stats = client_stats(client)
    client.visits = stats["visits"]
    client.total_spent = stats["total_spent"]
    client.last_visit = stats["last_visit"]
    return client


@router.put("/{int:client_id}", auth=staff_auth, response=ClientOut)
def update_client(request, client_id: int, data: ClientIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    payload, category_ids = _client_payload(data)
    phone = payload["phone"]
    _check_phone_unique(ctx, phone, exclude_id=client.id)
    for name, value in payload.items():
        setattr(client, name, value)
    client.save()
    _set_categories(client, category_ids)
    log_activity(
        ctx.salon,
        "client.updated",
        f"Cliente aggiornato: {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id},
    )
    return client


@router.delete("/{int:client_id}", auth=staff_auth, response=OkOut)
def delete_client(request, client_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    client.is_active = False
    client.save(update_fields=["is_active"])
    log_activity(
        ctx.salon,
        "client.deleted",
        f"Cliente disattivato: {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id},
    )
    return OkOut()


@router.post("/import", auth=staff_auth, response=ImportOut)
def import_clients(request, data: ImportIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    result = import_rows(
        ctx.salon,
        [row.dict() for row in data.rows],
        update_existing=data.update_existing,
        actor=ctx.user,
    )
    log_activity(
        ctx.salon,
        "client.imported",
        f"Import clienti: {result['created']} creati, {result['updated']} aggiornati, {result['skipped']} saltati",
        actor=ctx.user,
        payload={k: result[k] for k in ("created", "updated", "skipped")},
    )
    return result


# ---- Storico appuntamenti (staff) -----------------------------------------------


@router.get("/{int:client_id}/appointments", auth=staff_auth, response=list[AppointmentOut])
def list_client_appointments(request, client_id: int):
    """Storico appuntamenti del cliente (passati e futuri), ordinati cronologicamente.

    Riusa la serializzazione di apps.agenda.api._appointment_out; import lazy
    per evitare dipendenze a livello di modulo tra le due app di dominio.
    """
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)

    from apps.agenda.api import _appointment_out  # lazy: riuso serializzazione esistente
    from apps.agenda.models import Appointment  # lazy: evita import cross-app a livello modulo

    appointments = (
        Appointment.objects.filter(salon=ctx.salon, client=client)
        .select_related("client", "operator")
        .prefetch_related("items__service", "items__operator")
        .order_by("start")
    )
    return [_appointment_out(a) for a in appointments]


# ---- Storico unificato (visite + note + schede) ---------------------------------


def _note_out(note: ClientNote) -> dict:
    author = getattr(note, "author", None)
    return {
        "id": note.id,
        "client_id": note.client_id,
        "appointment_id": note.appointment_id,
        "text": note.text,
        "visibility": note.visibility,
        "author_id": note.author_id,
        "author_name": (author.get_full_name() or author.email) if author else "",
        "attachments": [_attachment_out(a) for a in note.attachments.all()],
        "created_at": note.created_at,
        "updated_at": note.updated_at,
    }


def _attachment_out(att: ClientNoteAttachment) -> dict:
    try:
        url = att.file.url
    except ValueError:
        url = ""
    return {
        "id": att.id,
        "name": att.name,
        "url": url,
        "content_type": att.content_type,
        "size": att.size,
        "is_image": att.is_image,
        "created_at": att.created_at,
    }


def _sheet_out(sheet: TechnicalSheet) -> dict:
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
        "photo": sheet.photo.url if sheet.photo else None,
        "author_id": sheet.author_id,
        "author_name": (author.get_full_name() or author.email) if author else "",
        "created_at": sheet.created_at,
    }


@router.get("/{int:client_id}/history", auth=staff_auth)
def client_history(request, client_id: int):
    """Storico completo del cliente in un'unica timeline (più recente prima).

    Voci: `visit` (appuntamento con servizi, operatrici, stato, incasso, nota
    appuntamento + note di trattamento e schede tecniche collegate), `sale`
    (vendita al banco senza appuntamento), `note` e `sheet` non legate a una
    visita. Gli appuntamenti futuri hanno `upcoming: true`.
    """
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)

    from apps.agenda.api import _appointment_out  # lazy: riuso serializzazione
    from apps.agenda.models import Appointment  # lazy
    from apps.sales.api import _sale_out  # lazy
    from apps.sales.models import Sale  # lazy

    appointments = list(
        Appointment.objects.filter(salon=ctx.salon, client=client)
        .select_related("client", "operator")
        .prefetch_related("items__service", "items__operator")
        .order_by("-start")
    )
    sales = {
        s.appointment_id: s
        for s in Sale.objects.filter(salon=ctx.salon, client=client).select_related("client")
        if s.appointment_id
    }
    counter_sales = [
        s for s in Sale.objects.filter(salon=ctx.salon, client=client).select_related("client")
        if not s.appointment_id
    ]
    notes = list(client.notes.select_related("author").prefetch_related("attachments"))
    sheets = list(client.sheets.select_related("author"))
    notes_by_appt: dict = {}
    for n in notes:
        if n.appointment_id:
            notes_by_appt.setdefault(n.appointment_id, []).append(n)
    sheets_by_appt: dict = {}
    for sh in sheets:
        if sh.appointment_id:
            sheets_by_appt.setdefault(sh.appointment_id, []).append(sh)

    now = timezone.now()
    entries = []
    for a in appointments:
        sale = sales.get(a.id)
        entries.append(
            {
                "kind": "visit",
                "date": a.start,
                "upcoming": a.start >= now and a.status in ("confirmed", "checked_in", "in_progress"),
                "appointment": _appointment_out(a),
                "operator_name": f"{a.operator.first_name} {a.operator.last_name}".strip() if a.operator_id else "",
                "sale": _sale_out(sale) if sale else None,
                "notes": [_note_out(n) for n in notes_by_appt.get(a.id, [])],
                "sheets": [_sheet_out(sh) for sh in sheets_by_appt.get(a.id, [])],
            }
        )
    for s in counter_sales:
        entries.append({"kind": "sale", "date": s.created_at, "sale": _sale_out(s)})
    for n in notes:
        if not n.appointment_id:
            entries.append({"kind": "note", "date": n.created_at, "note": _note_out(n)})
    for sh in sheets:
        if not sh.appointment_id:
            entries.append({"kind": "sheet", "date": sh.created_at, "sheet": _sheet_out(sh)})
    entries.sort(key=lambda e: e["date"], reverse=True)
    return {
        "client_id": client.id,
        "counts": {
            "visits": sum(1 for e in entries if e["kind"] == "visit" and not e["upcoming"]),
            "upcoming": sum(1 for e in entries if e["kind"] == "visit" and e["upcoming"]),
            "notes": len(notes),
            "sheets": len(sheets),
            "sales": len(sales) + len(counter_sales),
        },
        "entries": entries,
    }


# ---- Note interne (con allegati: foto e documenti) -------------------------------


def _appointment_for(ctx, client: Client, appointment_id):
    if not appointment_id:
        return None
    from apps.agenda.models import Appointment  # lazy

    appointment = Appointment.objects.filter(salon=ctx.salon, client=client, id=appointment_id).first()
    if appointment is None:
        raise HttpError(404, "Appuntamento non trovato per questo cliente")
    return appointment


def _validate_upload(f: UploadedFile) -> None:
    ctype = (f.content_type or "").lower()
    if ctype not in ClientNoteAttachment.IMAGE_TYPES + ClientNoteAttachment.DOC_TYPES:
        raise HttpError(400, f"Formato non supportato: {f.name} (immagini, PDF, Word o testo)")
    if f.size > ClientNoteAttachment.MAX_BYTES:
        raise HttpError(400, f"File troppo grande: {f.name} (max 15 MB)")


def _attach_files(note: ClientNote, files: list[UploadedFile]) -> None:
    for f in files:
        _validate_upload(f)
    for f in files:
        att = ClientNoteAttachment(
            note=note, name=f.name[:200], content_type=(f.content_type or "")[:100], size=f.size
        )
        att.file.save(f.name, f, save=True)


@router.get("/{int:client_id}/notes", auth=staff_auth, response=list[NoteOut])
def list_notes(request, client_id: int):
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)
    return [_note_out(n) for n in client.notes.select_related("author").prefetch_related("attachments")]


@router.post("/{int:client_id}/notes", auth=staff_auth, response=NoteOut)
def create_note(request, client_id: int, data: NoteIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    if not data.text.strip():
        raise HttpError(400, "Il testo della nota è obbligatorio")
    note = ClientNote.objects.create(
        client=client,
        appointment=_appointment_for(ctx, client, data.appointment_id),
        text=data.text.strip(),
        visibility=data.visibility,
        author=ctx.user,
    )
    log_activity(
        ctx.salon,
        "client.note_added",
        f"Nota aggiunta per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note.id},
    )
    return _note_out(note)


@router.post("/{int:client_id}/notes/upload", auth=staff_auth, response=NoteOut)
def create_note_with_files(
    request,
    client_id: int,
    files: list[UploadedFile] = File(...),
    text: str = Form(""),
    visibility: str = Form("private"),
    appointment_id: Optional[int] = Form(None),
):
    """Nota di trattamento con foto/documenti allegati (multipart)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    if not files and not text.strip():
        raise HttpError(400, "Scrivi una nota o allega almeno un file")
    for f in files:
        _validate_upload(f)
    note = ClientNote.objects.create(
        client=client,
        appointment=_appointment_for(ctx, client, appointment_id),
        text=text.strip(),
        visibility=visibility if visibility in ("private", "ai", "shared") else "private",
        author=ctx.user,
    )
    _attach_files(note, files)
    log_activity(
        ctx.salon,
        "client.note_added",
        f"Nota con {len(files)} allegat{'o' if len(files) == 1 else 'i'} per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note.id, "attachments": len(files)},
    )
    return _note_out(note)


@router.put("/{int:client_id}/notes/{int:note_id}", auth=staff_auth, response=NoteOut)
def update_note(request, client_id: int, note_id: int, data: NoteUpdateIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    if data.text is not None:
        if not data.text.strip() and not note.attachments.exists():
            raise HttpError(400, "Una nota senza allegati non può essere vuota")
        note.text = data.text.strip()
    if data.visibility is not None:
        note.visibility = data.visibility
    note.save()
    return _note_out(note)


@router.post("/{int:client_id}/notes/{int:note_id}/attachments", auth=staff_auth, response=NoteOut)
def add_attachments(request, client_id: int, note_id: int, files: list[UploadedFile] = File(...)):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    _attach_files(note, files)
    note.save(update_fields=["updated_at"])
    return _note_out(note)


@router.delete(
    "/{int:client_id}/notes/{int:note_id}/attachments/{int:attachment_id}",
    auth=staff_auth,
    response=OkOut,
)
def delete_attachment(request, client_id: int, note_id: int, attachment_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    att = get_object_or_404(ClientNoteAttachment, pk=attachment_id, note_id=note_id, note__client=client)
    att.file.delete(save=False)
    att.delete()
    return OkOut()


@router.delete("/{int:client_id}/notes/{int:note_id}", auth=staff_auth, response=OkOut)
def delete_note(request, client_id: int, note_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    for att in note.attachments.all():
        att.file.delete(save=False)
    note.delete()
    log_activity(
        ctx.salon,
        "client.note_deleted",
        f"Nota eliminata per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note_id},
    )
    return OkOut()


# ---- Schede tecniche (sola lettura dopo la creazione) --------------------------


@router.get("/{int:client_id}/sheets", auth=staff_auth, response=list[TechnicalSheetOut])
def list_sheets(request, client_id: int):
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)
    return client.sheets.all()


@router.post("/{int:client_id}/sheets", auth=staff_auth, response=TechnicalSheetOut)
def create_sheet(request, client_id: int, data: TechnicalSheetIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    sheet = TechnicalSheet.objects.create(
        client=client,
        author=ctx.user,
        **data.dict(),
    )
    log_activity(
        ctx.salon,
        "client.sheet_added",
        f"Scheda tecnica aggiunta per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "sheet_id": sheet.id},
    )
    return sheet


@router.post("/{int:client_id}/sheets/{int:sheet_id}/photo", auth=staff_auth, response=TechnicalSheetOut)
def upload_sheet_photo(request, client_id: int, sheet_id: int, photo: UploadedFile = File(...)):
    """Foto della scheda tecnica (unico campo modificabile dopo la creazione)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    sheet = get_object_or_404(TechnicalSheet, pk=sheet_id, client=client)
    if (photo.content_type or "").lower() not in ClientNoteAttachment.IMAGE_TYPES:
        raise HttpError(400, "La foto deve essere un'immagine (JPEG, PNG, WebP, HEIC)")
    if photo.size > ClientNoteAttachment.MAX_BYTES:
        raise HttpError(400, "Foto troppo grande (max 15 MB)")
    if sheet.photo:
        sheet.photo.delete(save=False)
    sheet.photo.save(photo.name, photo, save=True)
    return sheet


# ---------------------------------------------------------------------------
# Form pubblico di raccolta contatti — /<slug>/hook nell'app cliente
# ---------------------------------------------------------------------------

HOOK_LABEL = "Da form"
HOOK_LABEL_COLOR = "#8B5CF6"
# Soglia per IP e per salone. Non troppo bassa: un salone che fa compilare il
# form da un tablet sul bancone, o clienti sulla stessa rete pubblica, arrivano
# tutti dallo stesso IP. Serve a fermare uno script, non a contare le persone —
# contro lo spam mirato la difesa è l'honeypot.
HOOK_MAX_PER_WINDOW = 20
HOOK_WINDOW_SECONDS = 3600


def _client_ip(request) -> str:
    """IP reale dietro il proxy.

    Si prende l'ULTIMO elemento di X-Forwarded-For, non il primo: la catena è
    scrivibile dal client, ma il nostro proxy accoda in fondo il peer che ha
    davvero aperto la connessione. Fidarsi del primo elemento renderebbe il rate
    limit aggirabile con un header.
    """
    xff = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if xff:
        return xff.split(",")[-1].strip()
    return request.META.get("REMOTE_ADDR", "") or "unknown"


@router.post("/public/hook", auth=None, response=HookLeadOut)
def public_hook(request, data: HookLeadIn):
    """Raccoglie un contatto dal form pubblico del salone.

    Risponde 200 in ogni caso in cui il salone esiste — anche se il numero è già
    in rubrica o se la richiesta è stata scartata. Distinguere gli esiti
    trasformerebbe l'endpoint in un oracolo: chiunque potrebbe verificare se un
    numero è cliente di quel salone provandolo.
    """
    if data.trap or data.website.strip():  # honeypot
        # WARNING, non INFO: se questa trappola scatta su un utente vero
        # perdiamo un contatto senza che nessuno lo sappia, quindi deve essere
        # visibile nei log. La risposta resta 200 per non istruire i bot.
        logger.warning(
            "hook: submission scartata dall'honeypot (salone=%s, trap=%s, website=%r)",
            data.salon_slug, data.trap, data.website[:40],
        )
        return {"ok": True}

    if not data.privacy:
        raise HttpError(400, "Il consenso al trattamento dei dati è obbligatorio")

    first_name = data.first_name.strip()
    phone = data.phone.strip()
    if not first_name or not phone:
        raise HttpError(400, "Nome e telefono sono obbligatori")

    try:
        salon = Salon.objects.get(slug=data.salon_slug)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")

    # Il modulo raccoglie anche se il salone non ha configurato l'informativa:
    # bloccarlo spegnerebbe la raccolta contatti alla maggior parte dei saloni
    # attivi, ed è una decisione commerciale, non tecnica. Resta il WARNING qui
    # e l'avviso in dashboard — il consenso senza informativa da leggere è
    # debole, e chi lo raccoglie deve poterlo sapere.
    # values_list().first() e non _settings(): un endpoint pubblico non deve
    # creare righe (get_or_create) su richiesta di uno sconosciuto.
    privacy_url = (
        SalonSettings.objects.filter(salon=salon)
        .values_list("privacy_policy_url", flat=True)
        .first()
    )
    if not privacy_url:
        logger.warning(
            "hook: consenso raccolto senza informativa privacy configurata (salone=%s)", salon.slug
        )

    # Rate limit per IP. La cache è su database (vedi settings.CACHES): condivisa
    # fra i worker, altrimenti ognuno conterebbe per conto suo e il limite non
    # limiterebbe nulla.
    key = f"hook:{salon.id}:{_client_ip(request)}"
    hits = cache.get(key, 0)
    if hits >= HOOK_MAX_PER_WINDOW:
        logger.warning("hook: rate limit superato per %s", key)
        return {"ok": True}
    cache.set(key, hits + 1, HOOK_WINDOW_SECONDS)

    now = timezone.now().isoformat()
    client = Client.objects.filter(salon=salon, phone=phone).first()

    if client is None:
        client = Client.objects.create(
            salon=salon,
            first_name=first_name,
            last_name=data.last_name.strip(),
            phone=phone,
            email=data.email.strip(),
            origin="hook",
            consents={
                "privacy": True,
                "privacy_at": now,
                "marketing": bool(data.marketing),
                "marketing_at": now if data.marketing else "",
                "card_charge": False,
            },
        )
        label, _ = ClientCategory.objects.get_or_create(
            salon=salon, name=HOOK_LABEL, defaults={"color": HOOK_LABEL_COLOR}
        )
        client.categories.add(label)
        emit_event(
            salon,
            "client.created",
            {"client_id": client.id, "name": client.full_name, "phone": client.phone, "source": "hook"},
        )
        log_activity(salon, "client.created", f"Contatto dal form: {client.full_name}")
    else:
        # Cliente già in rubrica: si aggiornano i consensi (è il senso del form) e
        # si riempiono solo i campi vuoti. Sovrascrivere nome o email con quanto
        # digitato da uno sconosciuto rovinerebbe una scheda reale, e l'etichetta
        # "Da form" non va messa a chi è già cliente.
        client.consents = {
            **(client.consents or {}),
            "privacy": True,
            "privacy_at": now,
            "marketing": bool(data.marketing) or bool((client.consents or {}).get("marketing")),
            "marketing_at": now if data.marketing else (client.consents or {}).get("marketing_at", ""),
        }
        if not client.email and data.email.strip():
            client.email = data.email.strip()
        if not client.last_name and data.last_name.strip():
            client.last_name = data.last_name.strip()
        client.save(update_fields=["consents", "email", "last_name"])
        log_activity(salon, "client.updated", f"Consensi aggiornati dal form: {client.full_name}")

    return {"ok": True}
