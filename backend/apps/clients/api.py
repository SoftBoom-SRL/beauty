"""Anagrafica clienti: etichette, cliente, note interne, schede tecniche.

Letture base → solo `staff_auth`. Scritture → scope "clients" (vedi
common.permissions). Le schede tecniche sono uno storico immutabile: solo
GET (lista) e POST (creazione), nessun endpoint di update/delete.
"""

from typing import Optional

from django.db.models import Q
from django.shortcuts import get_object_or_404
from ninja import Router
from ninja.errors import HttpError
from ninja.pagination import LimitOffsetPagination, paginate

from apps.agenda.schemas import AppointmentOut
from apps.core.services import log_activity
from common.auth import staff_auth
from common.permissions import require_scope
from common.utils import salon_get

from .models import Client, ClientCategory, ClientNote, TechnicalSheet
from .schemas import (
    CategoryIn,
    CategoryOut,
    ClientDetailOut,
    ClientIn,
    ClientOut,
    ImportIn,
    ImportOut,
    NoteIn,
    NoteOut,
    OkOut,
    TechnicalSheetIn,
    TechnicalSheetOut,
)
from .services import client_stats, import_rows

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


@router.post("/", auth=staff_auth, response=ClientOut)
def create_client(request, data: ClientIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    payload = data.dict()
    category_ids = payload.pop("category_ids")
    phone = payload["phone"].strip()
    payload["phone"] = phone
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
    payload = data.dict()
    category_ids = payload.pop("category_ids")
    phone = payload["phone"].strip()
    payload["phone"] = phone
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
    result = import_rows(ctx.salon, [row.dict() for row in data.rows])
    log_activity(
        ctx.salon,
        "client.imported",
        f"Import clienti: {result['created']} creati, {result['updated']} aggiornati",
        actor=ctx.user,
        payload=result,
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


# ---- Note interne ---------------------------------------------------------------


@router.get("/{int:client_id}/notes", auth=staff_auth, response=list[NoteOut])
def list_notes(request, client_id: int):
    ctx = request.auth
    client = salon_get(Client, ctx, client_id)
    return client.notes.all()


@router.post("/{int:client_id}/notes", auth=staff_auth, response=NoteOut)
def create_note(request, client_id: int, data: NoteIn):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = ClientNote.objects.create(
        client=client,
        text=data.text,
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
    return note


@router.delete("/{int:client_id}/notes/{int:note_id}", auth=staff_auth, response=OkOut)
def delete_note(request, client_id: int, note_id: int):
    ctx = request.auth
    require_scope(ctx, "clients")
    client = salon_get(Client, ctx, client_id)
    note = get_object_or_404(ClientNote, pk=note_id, client=client)
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
