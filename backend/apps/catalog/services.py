"""Logica del catalogo: righe dei pacchetti, ordine delle categorie, listino pubblico.

api.py controlla permessi e tetti per IP e legge con `salon_get` la riga che
l'endpoint modifica (i test sostituiscono quella lettura per simulare la
sincronizzazione con Yourang che scrive nel frattempo); qui si scrivono le
righe dei pacchetti e l'ordine delle categorie, e si compone l'uscita pubblica.
"""

from django.db import transaction
from django.db.models import Prefetch

from common.utils import salon_get

from .models import Package, PackageItem, Service, ServiceCategory


def package_out(package: Package) -> dict:
    return {
        "id": package.id,
        "name": package.name,
        "description": package.description,
        "price": package.price,
        "active": package.active,
        "items": list(package.items.all()),
    }


def sync_package_items(ctx, package: Package, items: list[dict]) -> None:
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


def set_category_order(salon, ids: list[int]) -> None:
    """Ordine delle categorie = posizione in `ids`; si ignorano gli id di altri saloni.

    Tutto in una transazione, con le categorie del salone bloccate e rilette.
    Ogni categoria si salvava per conto suo: due riordini insieme (due
    postazioni, un doppio invio) si mescolavano, e un errore a metà lasciava
    l'ordine in parte nuovo e in parte vecchio, anche nel listino dell'app
    (voce 27 dei bug sospetti del 24/09). Il lock prende tutte le categorie
    del salone, in ordine di id: due riordini si mettono in fila anche quando
    non elencano le stesse categorie.
    """
    with transaction.atomic():
        categories = {
            c.id: c
            for c in ServiceCategory.objects.select_for_update().filter(salon=salon).order_by("id")
        }
        for order, cat_id in enumerate(ids):
            category = categories.get(cat_id)
            if category is None:
                continue
            if category.order != order:
                category.order = order
                category.save(update_fields=["order"])


def public_price_list(salon) -> list[dict]:
    """Listino pubblico: categorie in ordine, ciascuna con i suoi servizi attivi."""
    categories = ServiceCategory.objects.filter(salon=salon).order_by("order", "id").prefetch_related(
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


def public_package_list(salon) -> list[dict]:
    """Pacchetti pubblici attivi, con i servizi inclusi (nome, posa, quantità)."""
    packages = Package.objects.filter(salon=salon, active=True).prefetch_related("items__service")
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
