"""Carico di magazzino da CSV: le righe della bolla, ognuna con il suo esito.

Ogni riga si risolve su un prodotto (scelto dall'elenco, per SKU o per nome fra
gli attivi, oppure nuovo) e si carica con `apply_movement` dentro il proprio
savepoint: un errore, anche del database, resta sulla sua riga e le altre
entrano lo stesso.
"""

import logging
from typing import Optional

from django.db import DatabaseError, transaction
from ninja.errors import HttpError

from .models import Product, StockMovement, Supplier
from .services import MAX_LOAD_QTY, apply_movement

# Il nome di prima, di quando il carico CSV stava in api.py (`__name__`): è
# quello che compare nei log.
logger = logging.getLogger("apps.inventory.api")


def single_active_match(qs, what: str) -> Optional[Product]:
    """L'unico prodotto ATTIVO che corrisponde, None se nessuno; più di uno = errore di riga.

    Nome e SKU non sono univoci: la marca è un campo a parte e un prodotto
    sostituito eredita spesso il codice del fornitore. Con `.first()` sui
    prodotti di ogni stato il carico finiva sull'omonimo di un'altra marca o
    sul vecchio articolo disattivato, invisibile in elenco, e la risposta
    diceva «caricato» (09-02, 15-04).
    """
    matches = list(qs.filter(active=True).order_by("id")[:2])
    if len(matches) > 1:
        raise HttpError(
            400, f"{what} ambiguo: più prodotti attivi corrispondono, scegli il prodotto dall'elenco"
        )
    return matches[0] if matches else None


def csv_row_product(ctx, row, default_supplier_id) -> tuple[Product, str]:
    """(prodotto, esito) di una riga di carico. HttpError = errore della riga."""
    if row.qty <= 0:
        raise HttpError(422, "Quantità non valida")
    if row.qty > MAX_LOAD_QTY:
        raise HttpError(422, f"Quantità fuori scala: {row.qty} (controlla le colonne della riga)")
    if row.product_id is not None:
        # Il prodotto scelto dall'elenco: l'id vince su SKU e nome (C7).
        product = Product.objects.filter(salon=ctx.salon, pk=row.product_id).first()
        if product is None:
            raise HttpError(400, "Prodotto non trovato")
        return product, "loaded"
    if not row.sku and not row.name:
        raise HttpError(400, "Riga senza nome né SKU")
    products = Product.objects.filter(salon=ctx.salon)
    product = None
    if row.sku:
        product = single_active_match(products.filter(sku__iexact=row.sku), "SKU")
    if product is None and row.name:
        product = single_active_match(products.filter(name__iexact=row.name), "Nome")
    if product is not None:
        return product, "loaded"

    # Prodotto nuovo. Le lunghezze si controllano qui: oltre il limite della
    # colonna PostgreSQL risponde «value too long», cioè un 500.
    name = row.name or row.sku
    if len(name) > Product._meta.get_field("name").max_length:
        raise HttpError(400, "Nome del nuovo prodotto troppo lungo")
    if len(row.sku) > Product._meta.get_field("sku").max_length:
        raise HttpError(400, "SKU del nuovo prodotto troppo lungo")
    supplier_id = row.supplier_id or default_supplier_id
    if not supplier_id:
        raise HttpError(400, "Fornitore mancante per il nuovo prodotto")
    supplier = Supplier.objects.filter(salon=ctx.salon, pk=supplier_id).first()
    if supplier is None:
        raise HttpError(400, "Fornitore non trovato")
    product = Product.objects.create(salon=ctx.salon, name=name, sku=row.sku, supplier=supplier)
    return product, "created"


def load_rows(ctx, rows, default_supplier_id) -> dict:
    """Carica le righe una per una, ognuna tutto-o-niente (vedi l'endpoint POST /load-csv).

    Ritorna il corpo della risposta: esito per riga e i tre contatori.
    """
    results = []
    loaded = created = errors = 0
    for idx, row in enumerate(rows, start=1):
        label = row.name or row.sku
        try:
            with transaction.atomic():
                product, status = csv_row_product(ctx, row, default_supplier_id)
                apply_movement(
                    product,
                    kind=StockMovement.Kind.LOAD,
                    qty=row.qty,
                    reason="Carico CSV",
                    author=ctx.user,
                )
        except HttpError as exc:
            errors += 1
            results.append({"row": idx, "name": label, "status": "error", "error": str(exc)})
            continue
        except DatabaseError:
            logger.exception("load-csv: riga %s non salvata (salone=%s)", idx, ctx.salon.id)
            errors += 1
            results.append(
                {
                    "row": idx,
                    "name": label,
                    "status": "error",
                    "error": "Riga non salvata: valori fuori dai limiti del magazzino",
                }
            )
            continue
        loaded += 1
        if status == "created":
            created += 1
        results.append({"row": idx, "product_id": product.id, "name": product.name, "status": status})
    return {"results": results, "loaded": loaded, "created": created, "errors": errors}
