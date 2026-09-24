"""Catalogo: categorie servizi, servizi (listino), pacchetti.

Letture base → solo `staff_auth`. Scritture → scope "pricing".
Endpoint pubblici (`/public/...`) senza auth: usati dalla web app cliente prima
del login per mostrare listino e pacchetti del salone (solo elementi attivi).
"""

from typing import Optional

from django.db import transaction
from django.db.models import Prefetch
from django.db.models.deletion import ProtectedError
from ninja import Router
from ninja.errors import HttpError

from apps.core.services import get_salon_by_slug, log_activity
from common import ratelimit
from common.auth import staff_auth
from common.permissions import require_scope
from common.schemas import OkOut
from common.utils import salon_get
from common.validation import MAX_POSITIVE_INT, validate_category_in

from .models import Package, PackageItem, Service, ServiceCategory
from .schemas import (
    CategoryIn,
    CategoryOut,
    PackageIn,
    PackageOut,
    PublicCategoryOut,
    PublicPackageOut,
    ReorderIn,
    ServiceIn,
    ServiceOut,
)

router = Router(tags=["catalog"])

DEFAULT_CATEGORY_COLOR = "#E0E7FF"
# PositiveIntegerField: oltre questo valore il database rifiuta la riga e al
# client arriva un 500 invece del 400 che gli dice cosa correggere.
MAX_CATEGORY_ORDER = MAX_POSITIVE_INT

# Endpoint pubblici senza auth: stesso tetto per IP della disponibilità in agenda.
PUBLIC_CATALOG_MAX_PER_WINDOW = 120
PUBLIC_CATALOG_WINDOW_SECONDS = 300


# ---- Categorie servizi -------------------------------------------------------


@router.get("/categories", auth=staff_auth, response=list[CategoryOut])
def list_categories(request):
    return request.auth.salon.service_categories.all()


@router.post("/categories", auth=staff_auth, response=CategoryOut)
def create_category(request, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "pricing")
    validate_category_in(data, max_order=MAX_CATEGORY_ORDER)
    payload = data.dict()
    payload["color"] = (payload["color"] or DEFAULT_CATEGORY_COLOR).strip()
    category = ServiceCategory.objects.create(salon=ctx.salon, **payload)
    log_activity(
        ctx.salon,
        "category.created",
        f"Categoria creata: {category.name_it}",
        actor=ctx.user,
        payload={"category_id": category.id},
    )
    return category


@router.put("/categories/{int:category_id}", auth=staff_auth, response=CategoryOut)
def update_category(request, category_id: int, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "pricing")
    validate_category_in(data, max_order=MAX_CATEGORY_ORDER)
    category = salon_get(ServiceCategory, ctx, category_id)
    payload = data.dict()
    # Colore assente = invariato: un modulo che manda solo nome e ordine non
    # deve riportare al grigio di fabbrica una categoria colorata a mano.
    color = payload.pop("color")
    if color is not None:
        category.color = color.strip()
    for name, value in payload.items():
        setattr(category, name, value)
    category.save()
    log_activity(
        ctx.salon,
        "category.updated",
        f"Categoria aggiornata: {category.name_it}",
        actor=ctx.user,
        payload={"category_id": category.id},
    )
    return category


@router.delete("/categories/{int:category_id}", auth=staff_auth, response=OkOut)
def delete_category(request, category_id: int):
    ctx = request.auth
    require_scope(ctx, "pricing")
    category = salon_get(ServiceCategory, ctx, category_id)
    name_it = category.name_it
    try:
        category.delete()
    except ProtectedError:
        raise HttpError(400, "Impossibile eliminare: categoria con servizi collegati")
    log_activity(
        ctx.salon,
        "category.deleted",
        f"Categoria eliminata: {name_it}",
        actor=ctx.user,
        payload={"category_id": category_id},
    )
    return OkOut()


@router.post("/categories/reorder", auth=staff_auth, response=list[CategoryOut])
def reorder_categories(request, data: ReorderIn):
    ctx = request.auth
    require_scope(ctx, "pricing")
    categories = {
        c.id: c
        for c in ServiceCategory.objects.filter(salon=ctx.salon, id__in=data.ids)
    }
    for order, cat_id in enumerate(data.ids):
        category = categories.get(cat_id)
        if category is None:
            continue
        if category.order != order:
            category.order = order
            category.save(update_fields=["order"])
    log_activity(
        ctx.salon,
        "category.reordered",
        "Categorie riordinate",
        actor=ctx.user,
        payload={"ids": data.ids},
    )
    return ServiceCategory.objects.filter(salon=ctx.salon).order_by("order", "id")


# ---- Servizi ------------------------------------------------------------------


@router.get("/services", auth=staff_auth, response=list[ServiceOut])
def list_services(request, category_id: Optional[int] = None, active: Optional[bool] = None):
    ctx = request.auth
    qs = Service.objects.filter(salon=ctx.salon)
    if category_id is not None:
        qs = qs.filter(category_id=category_id)
    if active is not None:
        qs = qs.filter(active=active)
    return qs.order_by("category__order", "order", "id")


@router.post("/services", auth=staff_auth, response=ServiceOut)
def create_service(request, data: ServiceIn):
    ctx = request.auth
    require_scope(ctx, "pricing")
    payload = data.dict()
    category = salon_get(ServiceCategory, ctx, payload.pop("category_id"))
    service = Service.objects.create(salon=ctx.salon, category=category, **payload)
    log_activity(
        ctx.salon,
        "service.created",
        f"Servizio creato: {service.name_it}",
        actor=ctx.user,
        payload={"service_id": service.id},
    )
    return service


@router.put("/services/{int:service_id}", auth=staff_auth, response=ServiceOut)
def update_service(request, service_id: int, data: ServiceIn):
    ctx = request.auth
    require_scope(ctx, "pricing")
    service = salon_get(Service, ctx, service_id)
    old_price = service.price
    payload = data.dict()
    service.category = salon_get(ServiceCategory, ctx, payload.pop("category_id"))
    for name, value in payload.items():
        setattr(service, name, value)
    # Solo le colonne del modulo: il save() completo riscriveva anche
    # `yourang_item_id` con il valore letto a inizio richiesta, e la voce
    # collegata dalla sincronizzazione nel frattempo tornava vuota — al giro
    # dopo la sync ne creava una seconda su Yourang (18-07).
    service.save(update_fields=[*payload.keys(), "category"])
    log_activity(
        ctx.salon,
        "service.updated",
        f"Servizio aggiornato: {service.name_it}",
        actor=ctx.user,
        payload={"service_id": service.id},
    )
    if service.price != old_price:
        log_activity(
            ctx.salon,
            "service.price_changed",
            f"Prezzo aggiornato: {service.name_it}",
            actor=ctx.user,
            payload={"old": str(old_price), "new": str(service.price)},
        )
    return service


@router.delete("/services/{int:service_id}", auth=staff_auth, response=OkOut)
def delete_service(request, service_id: int):
    ctx = request.auth
    require_scope(ctx, "pricing")
    service = salon_get(Service, ctx, service_id)
    service.active = False
    service.save(update_fields=["active"])
    log_activity(
        ctx.salon,
        "service.deleted",
        f"Servizio disattivato: {service.name_it}",
        actor=ctx.user,
        payload={"service_id": service.id},
    )
    return OkOut()


# ---- Pacchetti ------------------------------------------------------------------


def _package_out(package: Package) -> dict:
    return {
        "id": package.id,
        "name": package.name,
        "description": package.description,
        "price": package.price,
        "active": package.active,
        "items": list(package.items.all()),
    }


def _sync_package_items(ctx, package: Package, items: list[dict]) -> None:
    """Ricrea integralmente gli items del pacchetto (spec: ricreati a ogni update).

    Prima si risolvono TUTTI i servizi (404 se uno non è del salone), poi si
    cancella e ricrea: un id sbagliato non deve lasciare il pacchetto senza righe.
    """
    resolved = [
        (salon_get(Service, ctx, item["service_id"]), item.get("qty", 1)) for item in items
    ]
    package.items.all().delete()
    for service, qty in resolved:
        PackageItem.objects.create(package=package, service=service, qty=qty)


@router.get("/packages", auth=staff_auth, response=list[PackageOut])
def list_packages(request):
    ctx = request.auth
    qs = Package.objects.filter(salon=ctx.salon).prefetch_related("items")
    return [_package_out(p) for p in qs]


@router.post("/packages", auth=staff_auth, response=PackageOut)
@transaction.atomic
def create_package(request, data: PackageIn):
    ctx = request.auth
    require_scope(ctx, "pricing")
    payload = data.dict()
    items = payload.pop("items") or []
    package = Package.objects.create(salon=ctx.salon, **payload)
    _sync_package_items(ctx, package, items)
    log_activity(
        ctx.salon,
        "package.created",
        f"Pacchetto creato: {package.name}",
        actor=ctx.user,
        payload={"package_id": package.id},
    )
    return _package_out(package)


@router.put("/packages/{int:package_id}", auth=staff_auth, response=PackageOut)
@transaction.atomic
def update_package(request, package_id: int, data: PackageIn):
    """Tutto o niente: se un servizio non esiste il pacchetto resta com'era
    (righe e prezzo compresi), invece di restare svuotato a metà."""
    ctx = request.auth
    require_scope(ctx, "pricing")
    package = salon_get(Package, ctx, package_id)
    payload = data.dict()
    items = payload.pop("items")
    # `items` assente = righe invariate. Prima il default era la lista vuota:
    # un PUT che cambiava solo nome o prezzo cancellava i servizi del pacchetto,
    # e il pacchetto continuava a essere venduto senza contenere più nulla.
    if items is not None:
        _sync_package_items(ctx, package, items)
    for name, value in payload.items():
        setattr(package, name, value)
    # Come per i servizi: il save() completo riportava indietro il
    # `yourang_item_id` scritto dalla sincronizzazione nel frattempo (18-07).
    package.save(update_fields=list(payload.keys()))
    log_activity(
        ctx.salon,
        "package.updated",
        f"Pacchetto aggiornato: {package.name}",
        actor=ctx.user,
        payload={"package_id": package.id},
    )
    return _package_out(package)


@router.delete("/packages/{int:package_id}", auth=staff_auth, response=OkOut)
def delete_package(request, package_id: int):
    ctx = request.auth
    require_scope(ctx, "pricing")
    package = salon_get(Package, ctx, package_id)
    package.active = False
    package.save(update_fields=["active"])
    log_activity(
        ctx.salon,
        "package.deleted",
        f"Pacchetto disattivato: {package.name}",
        actor=ctx.user,
        payload={"package_id": package.id},
    )
    return OkOut()


# ---- Endpoint pubblici (web app cliente, no auth) ----------------------------


@router.get("/public/services", response=list[PublicCategoryOut])
def public_services(request, salon: str):
    """Listino pubblico raggruppato per categoria (ordinata), solo servizi attivi."""
    s = get_salon_by_slug(salon)
    ratelimit.enforce_public(
        request, s, "services", PUBLIC_CATALOG_MAX_PER_WINDOW, PUBLIC_CATALOG_WINDOW_SECONDS
    )
    categories = ServiceCategory.objects.filter(salon=s).order_by("order", "id").prefetch_related(
        Prefetch(
            "services",
            queryset=Service.objects.filter(active=True).order_by("order", "id"),
        )
    )
    return [
        {
            "id": c.id,
            "name_it": c.name_it,
            "name_en": c.name_en,
            "color": c.color,
            "services": list(c.services.all()),
        }
        for c in categories
    ]


@router.get("/public/packages", response=list[PublicPackageOut])
def public_packages(request, salon: str):
    """Pacchetti pubblici attivi, con dettaglio dei servizi inclusi."""
    s = get_salon_by_slug(salon)
    ratelimit.enforce_public(
        request, s, "packages", PUBLIC_CATALOG_MAX_PER_WINDOW, PUBLIC_CATALOG_WINDOW_SECONDS
    )
    packages = Package.objects.filter(salon=s, active=True).prefetch_related("items__service")
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "price": p.price,
            "items": [
                {
                    "service_id": item.service_id,
                    "name_it": item.service.name_it,
                    "name_en": item.service.name_en,
                    "soak_min": item.service.soak_min,
                    "qty": item.qty,
                }
                for item in p.items.all()
            ],
        }
        for p in packages
    ]
