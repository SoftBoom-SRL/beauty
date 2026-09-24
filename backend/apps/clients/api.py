"""Anagrafica clienti: etichette, cliente, note interne, schede tecniche.

Letture base → solo `staff_auth`. Scritture → scope "clients" (vedi
common.permissions). Le schede tecniche sono uno storico immutabile: solo
GET (lista) e POST (creazione), nessun endpoint di update/delete.
"""

import logging
from decimal import Decimal
from typing import Optional

from django.db import IntegrityError, transaction
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from apps.agenda.schemas import AppointmentOut
from apps.core.models import SalonSettings
from apps.core.services import emit_event, get_salon_by_slug, log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import has_scope, require_scope
from common.phone import canonical_phone, find_client_by_phone
from common.schemas import OkOut
from common.utils import salon_get

from .fields import client_payload
from .history import build_history, client_appointments
from .importer import import_rows
from .labels import create_label, delete_label, label_payload, update_label
from .profiles import (
    archive_profile,
    archived_phone_message,
    check_phone_unique,
    create_profile,
    notify_marketing,
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
from .models import (
    Client,
    ClientCategory,
    ClientNote,
    ClientNoteAttachment,
    TechnicalSheet,
)
from .schemas import (
    CategoryIn,
    CategoryOut,
    HookLeadIn,
    HookLeadOut,
    ClientDetailOut,
    ClientIn,
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
from .services import client_stats

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
    payload = label_payload(ctx, data)
    return create_label(ctx, payload)


@router.put("/categories/{int:category_id}", auth=staff_auth, response=CategoryOut)
def update_category(request, category_id: int, data: CategoryIn):
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


@router.post("/", auth=staff_auth, response=ClientOut)
def create_client(request, data: ClientIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    payload, category_ids = client_payload(data)
    phone = payload["phone"]
    archived = check_phone_unique(ctx, phone)
    if archived is not None:
        # Cliente archiviata che richiama per prenotare: la ricerca della
        # dashboard mostra solo le attive e la creazione rispondeva «già
        # registrato» senza dire da chi — un vicolo cieco (06-02). Non la si
        # riattiva da qui: il numero può essere passato a un'altra persona, che
        # entrerebbe nello storico di chi non è più cliente. Si indica la
        # scheda (409 con il suo id) e la riattivazione resta una scelta dello
        # staff: PUT {"is_active": true}.
        return JsonResponse(
            {
                "detail": archived_phone_message(archived),
                "archived_client_id": archived.id,
                "archived_client_name": archived.full_name,
            },
            status=409,
        )
    return create_profile(ctx, payload, category_ids)


@router.get("/{int:client_id}", auth=staff_auth, response=ClientDetailOut)
def get_client(request, client_id: int):
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)
    # Spesa totale, numero di visite e ultima visita sono dati di cassa: li
    # vede solo chi ha il permesso «vendite», come sulla lista degli incassi.
    # A chi non ce l'ha la scheda arriva completa, con i contatori a zero.
    may_see = has_scope(ctx, "sales")
    if may_see:
        stats = client_stats(client)
    else:
        stats = {"visits": 0, "total_spent": Decimal("0"), "last_visit": None}
    client.visits = stats["visits"]
    client.total_spent = stats["total_spent"]
    client.last_visit = stats["last_visit"]
    # Senza questo flag l'interfaccia mostrava «0 visite · 0 € spesi» a chi non
    # ha il permesso vendite: una cliente storica sembrava alla prima visita, e
    # l'operatrice rischiava di trattarla come tale (caparra compresa). Zero e
    # «non visibile» devono restare distinguibili.
    client.stats_hidden = not may_see
    return client


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
        archived = check_phone_unique(ctx, phone, exclude_id=client.id)
        if archived is not None:
            raise HttpError(400, archived_phone_message(archived, creating=False))
    return update_profile(ctx, client, payload, category_ids)


@router.delete("/{int:client_id}", auth=staff_auth, response=OkOut)
def delete_client(request, client_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    archive_profile(ctx, client)
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
    perché chi legge non ha il permesso «vendite».
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

HOOK_LABEL = "Da form"
HOOK_LABEL_COLOR = "#8B5CF6"
# Soglia per IP e per salone. Non troppo bassa: un salone che fa compilare il
# form da un tablet sul bancone, o clienti sulla stessa rete pubblica, arrivano
# tutti dallo stesso IP. Serve a fermare uno script, non a contare le persone —
# contro lo spam mirato la difesa è l'honeypot.
HOOK_MAX_PER_WINDOW = 20
HOOK_WINDOW_SECONDS = 3600


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

    # Rate limit per IP, sul contatore condiviso di common.ratelimit: è una
    # UPDATE atomica sul database, mentre il vecchio leggi-poi-scrivi sulla
    # cache lasciava passare un flood in parallelo contandolo come una
    # richiesta sola (ogni richiesta qui crea una scheda e un evento).
    key = f"hook:{salon.id}:{ratelimit.client_ip(request)}"
    if not ratelimit.hit(key, HOOK_MAX_PER_WINDOW, HOOK_WINDOW_SECONDS):
        logger.warning("hook: rate limit superato per %s", key)
        return {"ok": True}

    now = timezone.now().isoformat()
    client = find_client_by_phone(salon, phone)

    if client is None:
        try:
            with transaction.atomic():
                lang = (data.lang or "").strip().lower()
                client = Client.objects.create(
                    salon=salon,
                    first_name=first_name,
                    last_name=data.last_name.strip(),
                    phone=phone,
                    email=data.email.strip(),
                    lang=lang if lang in Client.Lang.values else Client.Lang.IT,
                    origin="hook",
                    since=timezone.localdate(),
                    consents={
                        "privacy": True,
                        "privacy_at": now,
                        "marketing": bool(data.marketing),
                        "marketing_at": now if data.marketing else "",
                        "card_charge": False,
                    },
                )
        except IntegrityError:
            # Doppio tocco su «Invia», o due invii in parallelo: il controllo
            # qui sopra non è atomico, il vincolo di unicità sì. Si riprende la
            # scheda appena nata e si prosegue come per chi è già in rubrica —
            # questo endpoint risponde 200 in ogni caso, un 500 racconterebbe a
            # uno sconosciuto che quel numero è cliente del salone.
            client = find_client_by_phone(salon, phone)
            if client is None:
                logger.warning(
                    "hook: creazione rifiutata e scheda non ritrovata (salone=%s)", salon.slug
                )
                return {"ok": True}
        else:
            _mark_as_hook_lead(salon, client)
            return {"ok": True}

    if not client.is_active:
        # Scheda archiviata dallo staff: il modulo la riattivava da solo, con un
        # consenso marketing «fresco» dato da chiunque conoscesse nome e numero
        # — anche la cliente tolta di proposito, o chi ha chiesto di non
        # essere più contattata (10-15). Non si tocca: il salone riceve la
        # segnalazione e decide, come quando la stessa persona prova a entrare
        # dall'app (accounts). Il numero può essere passato a un'altra persona.
        _notify_archived_client(salon, client)
        return {"ok": True}

    # Cliente già in rubrica: si aggiornano i consensi (è il senso del form) e
    # si riempiono solo i campi vuoti. Sovrascrivere nome o email con quanto
    # digitato da uno sconosciuto rovinerebbe una scheda reale, e l'etichetta
    # "Da form" non va messa a chi è già cliente.
    stored = client.consents or {}
    marketing_before = bool(stored.get("marketing"))
    client.consents = {
        **stored,
        "privacy": True,
        "privacy_at": now,
        "marketing": bool(data.marketing) or marketing_before,
        "marketing_at": now if data.marketing else stored.get("marketing_at", ""),
    }
    if data.marketing:
        client.consents.pop("marketing_revoked_at", None)
    fields = ["consents"]
    if not client.email and data.email.strip():
        client.email = data.email.strip()
        fields.append("email")
    if not client.last_name and data.last_name.strip():
        client.last_name = data.last_name.strip()
        fields.append("last_name")
    client.save(update_fields=fields)
    if bool(client.consents["marketing"]) != marketing_before:
        # Consenso ridato dopo una revoca: Yourang deve togliere il blocco.
        notify_marketing("marketing_consent_changed", client, accepted=True)
    # Con il suo id la scheda aperta in dashboard si ricarica: senza, la
    # reception continuava a vedere i consensi di prima (06-10).
    log_activity(
        salon,
        "client.updated",
        f"Consensi aggiornati dal form: {client.full_name}",
        payload={"client_id": client.id, "fields": fields},
    )

    return {"ok": True}


# Una segnalazione al giorno per scheda archiviata. La chiave è la stessa
# delle segnalazioni dell'accesso dall'app (accounts, «archived-notice:<id>»):
# app e modulo nello stesso giorno sono un avviso solo.
ARCHIVED_NOTICE_WINDOW_SECONDS = 24 * 3600


def _notify_archived_client(salon, client: Client) -> None:
    """Segnala al salone (feed, scope clienti) la scheda archiviata che si è fatta viva."""
    if not ratelimit.hit(f"archived-notice:{client.id}", 1, ARCHIVED_NOTICE_WINDOW_SECONDS):
        return
    log_activity(
        salon,
        "client.reactivation_requested",
        f"{client.full_name}: scheda archiviata, ha compilato il modulo contatti. "
        "Riattivala se vuoi che entri.",
        payload={"client_id": client.id, "source": "hook"},
    )


def _mark_as_hook_lead(salon, client: Client) -> None:
    """Etichetta «Da form», evento SSE e registro: la scheda è un lead nuovo."""
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
