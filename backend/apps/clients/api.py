"""Anagrafica clienti: etichette, cliente, note interne, schede tecniche.

Letture base → solo `staff_auth`. Scritture → scope "clients" (vedi
common.permissions). Le schede tecniche sono uno storico immutabile: solo
GET (lista) e POST (creazione), nessun endpoint di update/delete.

Qui stanno permessi, lettura delle righe del salone (`salon_get`) e scelta
della risposta; le regole sono nei moduli accanto: `labels` (etichette),
`search` (ricerca), `fields` e `profiles` (la scheda, il telefono e il
contatto), `presenters` (i campi calcolati di dettaglio ed elenco), `importer`
(import CSV), `history` (storico), `records` (note, allegati, schede
tecniche), `hook` (form pubblico). `services` resta il modulo di
`client_stats`/`client_facts` e dell'affidabilità, che leggono le altre app.
"""

import logging
from typing import Optional

from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from ninja import File, Form, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from apps.agenda.schemas import AppointmentOut
from apps.core.services import get_salon_by_slug, log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import require_scope
from common.phone import canonical_phone
from common.schemas import OkOut
from common.utils import salon_get

from .fields import client_payload
from .history import build_history, client_appointments
from .hook import record_lead
from .importer import import_rows
from .labels import create_label, delete_label, label_counts, label_payload, update_label
from .models import (
    Client,
    ClientCategory,
    ClientNote,
    ClientNoteAttachment,
    TechnicalSheet,
)
from .presenters import attach_amounts_due, client_detail, contact_out
from .profiles import (
    DUPLICATE_PHONE,
    archive_profile,
    archived_phone_message,
    contact_allowed,
    create_profile,
    phone_holder,
    update_profile,
)
from .records import (
    appointment_for,
    attach_files,
    note_out,
    replace_sheet_photo,
    sheet_out,
    validate_attachment,
)
from .schemas import (
    ClientArchiveOut,
    ClientCategoryIn,
    ClientCategoryOut,
    ClientCountsOut,
    HookLeadIn,
    HookLeadOut,
    ClientDetailOut,
    ClientIn,
    ClientListOut,
    ClientOut,
    ClientUpdateIn,
    ImportIn,
    ImportOut,
    NoteIn,
    NoteOut,
    NoteUpdateIn,
    TechnicalSheetIn,
    TechnicalSheetOut,
)
from .search import search_filter

logger = logging.getLogger("youty.clients")
router = Router(tags=["clients"])


class ClientPagination(LimitOffsetPagination):
    """La paginazione dell'elenco, con il debito delle clienti della pagina.

    Una query in più per pagina (`sales.dues.amounts_due_by_client` sulle sole
    righe mostrate), non una per riga.
    """

    def paginate_queryset(self, queryset, pagination, request, **params):
        page = super().paginate_queryset(queryset, pagination, request, **params)
        page[self.items_attribute] = attach_amounts_due(request.auth, list(page[self.items_attribute]))
        return page


def _phone_taken(holder: Client, *, client: Optional[Client] = None):
    """Risposta per un numero che è già di un'altra scheda (`client` None = creazione).

    - Scheda archiviata, alla creazione: 409 con il suo id. È la cliente
      archiviata che richiama per prenotare: la ricerca della dashboard
      mostra solo le attive e la creazione rispondeva «già registrato» senza
      dire da chi — un vicolo cieco (06-02). Non la si riattiva da qui: il
      numero può essere passato a un'altra persona, che entrerebbe nello
      storico di chi non è più cliente; la riattivazione resta una scelta
      dello staff (PUT {"is_active": true}). In modifica: 400 col suo nome.
    - Scheda attiva: 400 con chi ha il numero (`phone_holder_id`,
      `phone_holder_name`) e se può fare da contatto (`contact_allowed`).
      Madre e figlia, coppie: lo stesso numero è di due persone, e invece del
      solo rifiuto la dashboard propone «Usa il numero di Laura come
      contatto» — la nuova scheda senza telefono, collegata a lei.
    """
    if not holder.is_active:
        if client is not None:
            raise HttpError(400, archived_phone_message(holder, creating=False))
        return JsonResponse(
            {
                "detail": archived_phone_message(holder),
                "archived_client_id": holder.id,
                "archived_client_name": holder.full_name,
            },
            status=409,
        )
    return JsonResponse(
        {
            "detail": DUPLICATE_PHONE,
            "phone_holder_id": holder.id,
            "phone_holder_name": holder.full_name,
            "contact_allowed": contact_allowed(holder, client),
        },
        status=400,
    )


# ---- Etichette (ClientCategory) ---------------------------------------------


@router.get("/categories", auth=staff_auth, response=list[ClientCategoryOut])
def list_categories(request):
    return request.auth.salon.client_categories.all()


@router.post("/categories", auth=staff_auth, response=ClientCategoryOut)
def create_category(request, data: ClientCategoryIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    payload = label_payload(ctx, data)
    return create_label(ctx, payload)


@router.put("/categories/{int:category_id}", auth=staff_auth, response=ClientCategoryOut)
def update_category(request, category_id: int, data: ClientCategoryIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = salon_get(ClientCategory, ctx, category_id)
    payload = label_payload(ctx, data, exclude_id=category.id)
    return update_label(ctx, category, payload)


@router.delete("/categories/{int:category_id}", auth=staff_auth, response=OkOut)
def delete_category(request, category_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    category = salon_get(ClientCategory, ctx, category_id)
    delete_label(ctx, category)
    return OkOut()


# ---- Cliente ------------------------------------------------------------------


@router.get("/", auth=staff_auth, response=list[ClientListOut])
@paginate(ClientPagination)
def list_clients(
    request,
    q: str = "",
    category_id: Optional[int] = None,
    reliability_min: Optional[int] = None,
    reliability_max: Optional[int] = None,
    is_active: Optional[bool] = None,
):
    """Elenco paginato. Ogni riga ha `contact` (si contatta tramite) e
    `amount_due` (da saldare; null senza il permesso «vendite»). La ricerca per
    numero trova anche chi, senza un telefono suo, passa da quel numero."""
    ctx = request.auth
    qs = (
        Client.objects.filter(salon=ctx.salon)
        .select_related("contact_client")
        .prefetch_related("categories")
    )
    if q:
        qs = qs.filter(search_filter(q))
    if category_id is not None:
        qs = qs.filter(categories__id=category_id)
    if reliability_min is not None:
        qs = qs.filter(reliability__gte=reliability_min)
    if reliability_max is not None:
        qs = qs.filter(reliability__lte=reliability_max)
    if is_active is not None:
        qs = qs.filter(is_active=is_active)
    return qs.distinct()


@router.get("/counts", auth=staff_auth, response=ClientCountsOut)
def client_counts(request):
    """Schede attive del salone, in tutto e per etichetta, in una risposta sola.

    Sono i numeri delle card in cima alla sezione Clienti della dashboard:
    `active` è il `count` della lista con `is_active=true`, ogni voce di
    `categories` quello della lista con `is_active=true&category_id=<id>`.
    Stesso permesso della lista.
    """
    return label_counts(request.auth.salon)


@router.post("/", auth=staff_auth, response=ClientOut)
def create_client(request, data: ClientIn):
    """Crea la scheda. Il telefono è facoltativo; con `contact_client_id` la
    cliente si contatta tramite un'altra scheda (vedi `ClientIn`). Un numero
    già in rubrica: 409 se è di una scheda archiviata (`archived_client_id`),
    400 se è di una attiva (`phone_holder_id`, `phone_holder_name`,
    `contact_allowed`)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    payload, category_ids = client_payload(data)
    holder = phone_holder(ctx, payload["phone"])
    if holder is not None:
        return _phone_taken(holder)
    return create_profile(ctx, payload, category_ids)


@router.get("/{int:client_id}", auth=staff_auth, response=ClientDetailOut)
def get_client(request, client_id: int):
    """La scheda con visite (giorni), spesa, ultima visita e debito (`amount_due`)
    — dati di cassa, a zero/null con `stats_hidden` senza il permesso «vendite» —,
    le schede che si contattano tramite lei (`dependents`) e l'affidabilità
    ricalcolata con i suoi conteggi (`reliability_basis`)."""
    ctx = request.auth
    client = salon_get(Client.objects.select_related("contact_client"), ctx, client_id)
    return client_detail(ctx, client)


@router.put("/{int:client_id}", auth=staff_auth, response=ClientOut)
def update_client(request, client_id: int, data: ClientUpdateIn):
    """Applica i soli campi presenti nel corpo e scrive le sole colonne cambiate (C15).

    Il salvataggio completo riscriveva la scheda letta a inizio richiesta —
    e il corpo completo della dashboard quella letta all'apertura della
    scheda: lingua, email, promemoria e consensi cambiati nel frattempo
    dall'app tornavano indietro, e con loro i dati Stripe scritti dal webhook
    (18-07).
    """
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    payload, category_ids = client_payload(data, partial=True)
    phone = payload.get("phone")
    if phone and phone != client.phone:
        holder = phone_holder(ctx, phone, exclude_id=client.id)
        if holder is not None:
            return _phone_taken(holder, client=client)
    return update_profile(ctx, client, payload, category_ids)


@router.delete("/{int:client_id}", auth=staff_auth, response=ClientArchiveOut)
def delete_client(request, client_id: int):
    """Archivia la scheda (soft delete). Le schede che si contattavano tramite
    lei perdono il collegamento: tornano in `unlinked_dependents`, da dire a chi
    archivia (restano senza numero di contatto)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    unlinked = archive_profile(ctx, client)
    return {"ok": True, "unlinked_dependents": [contact_out(d) for d in unlinked]}


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

    Riusa la serializzazione di apps.agenda.presenters._appointment_out; import lazy
    per evitare dipendenze a livello di modulo tra le due app di dominio.
    """
    ctx = request.auth
    # Stessa invariante di storico, note e schede: l'elenco delle visite di una
    # persona è un dato della sua scheda, non dell'agenda del giorno.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    return client_appointments(ctx, client)


# ---- Storico unificato (visite + note + schede) ---------------------------------


@router.get("/{int:client_id}/history", auth=staff_auth)
def client_history(request, client_id: int):
    """Storico completo del cliente in un'unica timeline (più recente prima).

    Voci: `visit` (appuntamento con servizi, operatrici, stato, incasso,
    caparra `deposit_sale`, nota appuntamento + note di trattamento e schede
    tecniche collegate), `sale` (vendita al banco senza appuntamento), `note`
    e `sheet` non legate a una visita. Gli appuntamenti futuri hanno
    `upcoming: true`. `sales_hidden` dice se gli incassi sono stati omessi
    perché chi legge non ha il permesso «vendite». `counts.visits` sono i
    giorni con una visita chiusa o un passaggio al banco, come nella scheda
    (senza «vendite», le sole visite chiuse).
    """
    ctx = request.auth
    # Storico, note e schede sono i dati più sensibili che il gestionale
    # conserva: leggerli richiede il permesso «clienti», come scriverli.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    return build_history(ctx, client)


# ---- Note interne (con allegati: foto e documenti) -------------------------------


@router.get("/{int:client_id}/notes", auth=staff_auth, response=list[NoteOut])
def list_notes(request, client_id: int):
    ctx = request.auth
    # Storico, note e schede sono i dati più sensibili che il gestionale
    # conserva: leggerli richiede il permesso «clienti», come scriverli.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    return [note_out(n) for n in client.notes.select_related("author").prefetch_related("attachments")]


@router.post("/{int:client_id}/notes", auth=staff_auth, response=NoteOut)
def create_note(request, client_id: int, data: NoteIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    if not data.text.strip():
        raise HttpError(400, "Il testo della nota è obbligatorio")
    note = ClientNote.objects.create(
        client=client,
        appointment=appointment_for(ctx, client, data.appointment_id),
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
    return note_out(note)


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
        validate_attachment(f)
    note = ClientNote.objects.create(
        client=client,
        appointment=appointment_for(ctx, client, appointment_id),
        text=text.strip(),
        # "shared" non è una scelta di ClientNote.Visibility: era ammesso qui e
        # finiva in archivio come valore che nessuna lettura sa interpretare.
        visibility=visibility if visibility in ("private", "ai") else "private",
        author=ctx.user,
    )
    attach_files(note, files)
    log_activity(
        ctx.salon,
        "client.note_added",
        f"Nota con {len(files)} allegat{'o' if len(files) == 1 else 'i'} per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "note_id": note.id, "attachments": len(files)},
    )
    return note_out(note)


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
    return note_out(note)


@router.post("/{int:client_id}/notes/{int:note_id}/attachments", auth=staff_auth, response=NoteOut)
def add_attachments(request, client_id: int, note_id: int, files: list[UploadedFile] = File(...)):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
    attach_files(note, files)
    note.save(update_fields=["updated_at"])
    return note_out(note)


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
    # Storico, note e schede sono i dati più sensibili che il gestionale
    # conserva: leggerli richiede il permesso «clienti», come scriverli.
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    return [sheet_out(sh) for sh in client.sheets.select_related("author")]


@router.post("/{int:client_id}/sheets", auth=staff_auth, response=TechnicalSheetOut)
def create_sheet(request, client_id: int, data: TechnicalSheetIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    payload = data.dict()
    # Come l'endpoint gemello delle note: l'appuntamento va risolto, non
    # passato grezzo. Un id inesistente usciva come 500 sulla chiave esterna e
    # un id di un altro salone (o di un'altra cliente) veniva salvato lo
    # stesso, facendo sparire la scheda dallo storico — lo storico la cerca fra
    # gli appuntamenti di questa cliente, dove quell'id non c'è.
    appointment = appointment_for(ctx, client, payload.pop("appointment_id", None))
    sheet = TechnicalSheet.objects.create(
        client=client,
        author=ctx.user,
        appointment=appointment,
        **payload,
    )
    log_activity(
        ctx.salon,
        "client.sheet_added",
        f"Scheda tecnica aggiunta per {client.full_name}",
        actor=ctx.user,
        payload={"client_id": client.id, "sheet_id": sheet.id},
    )
    return sheet_out(sheet)


@router.post("/{int:client_id}/sheets/{int:sheet_id}/photo", auth=staff_auth, response=TechnicalSheetOut)
def upload_sheet_photo(request, client_id: int, sheet_id: int, photo: UploadedFile = File(...)):
    """Foto della scheda tecnica (unico campo modificabile dopo la creazione)."""
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    sheet = get_object_or_404(TechnicalSheet, pk=sheet_id, client=client)
    replace_sheet_photo(sheet, photo)
    return sheet_out(sheet)


# ---------------------------------------------------------------------------
# Form pubblico di raccolta contatti — /<slug>/hook nell'app cliente
# ---------------------------------------------------------------------------


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
    phone = canonical_phone(data.phone)
    if not first_name or not phone:
        raise HttpError(400, "Nome e telefono sono obbligatori")

    salon = get_salon_by_slug(data.salon_slug)
    record_lead(salon, data, first_name=first_name, phone=phone, ip=ratelimit.client_ip(request))
    return {"ok": True}
