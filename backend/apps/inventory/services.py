"""Logica di magazzino. INTEGRITÀ: ogni variazione di stock passa da `apply_movement`.

`Product.stock_qty` è denormalizzata: nessun endpoint o servizio la scrive
direttamente; si crea sempre uno `StockMovement` e lo stock viene aggiornato
atomicamente con `F()` sotto `select_for_update`.

Gli ordini ai fornitori stanno in orders.py, il carico da CSV in csv_load.py:
entrambi passano da `apply_movement`.
"""

from decimal import Decimal

from django.db import transaction
from django.db.models import F
from ninja.errors import HttpError

from apps.core.models import Salon
from apps.core.services import log_activity

from .models import Product, StockMovement

# Causali ammesse per uno scarico a mano dal magazzino.
UNLOAD_KINDS = {
    StockMovement.Kind.INTERNAL_USE,
    StockMovement.Kind.ADJUSTMENT,
    StockMovement.Kind.TRANSFER,
}

# Tetto alla quantità di un carico. La colonna è numeric(10,2): oltre i cento
# milioni PostgreSQL risponde «numeric field overflow», cioè un 500 (su SQLite
# dei test passa e basta). Il caso vero è l'EAN di tredici cifre che il CSV
# della bolla mette nell'ultima colonna, letto come quantità (09-06). Nessun
# salone carica centomila confezioni in una volta.
MAX_LOAD_QTY = Decimal("100000")


def lock_salon(salon) -> None:
    """Serializza dentro la transazione corrente le scritture di magazzino del salone.

    Va chiamata DENTRO un `atomic()`. Su SQLite è un no-op.

    FOR NO KEY UPDATE come `agenda.services.lock_salon` (18-08): con FOR UPDATE
    un checkout che scarica il magazzino teneva il salone in modo incompatibile
    con i controlli delle chiavi esterne (FOR KEY SHARE) che chi ha inserito
    righe legate al salone fa al COMMIT — deadlock, e un 500 a una delle due.
    Fra loro queste chiamate restano serializzate.
    """
    list(
        Salon.objects.select_for_update(no_key=True)
        .filter(pk=salon.pk)
        .values_list("id", flat=True)
    )


def apply_movement(
    product,
    kind,
    qty,
    *,
    reason="",
    sale=None,
    order=None,
    author=None,
    operator=None,
    invoice=None,
):
    """UNICA porta di variazione dello stock.

    qty positiva = carico, negativa = scarico. Per gli scarichi vieta lo stock
    negativo (HttpError 422 "Giacenza insufficiente"). Ritorna lo StockMovement
    creato; `product.stock_qty` viene ricaricata dal DB.
    """
    qty = Decimal(str(qty))
    if qty == 0:
        raise HttpError(422, "La quantità non può essere zero")
    with transaction.atomic():
        locked = Product.objects.select_for_update().get(pk=product.pk)
        if qty < 0 and locked.stock_qty + qty < 0:
            raise HttpError(422, "Giacenza insufficiente")
        movement = StockMovement.objects.create(
            salon_id=locked.salon_id,
            product=locked,
            kind=kind,
            qty=qty,
            reason=reason,
            sale=sale,
            order=order,
            author=author if (author is not None and getattr(author, "pk", None)) else None,
            operator=operator if (operator is not None and getattr(operator, "pk", None)) else None,
            invoice=invoice,
        )
        Product.objects.filter(pk=locked.pk).update(stock_qty=F("stock_qty") + qty)
    product.refresh_from_db(fields=["stock_qty"])
    return movement


def deduct_stock_for_sale(sale):
    """Scarica lo stock per ogni riga prodotto della vendita.

    Anche le righe omaggio (is_gift=True) scalano la giacenza: il prodotto
    esce comunque dal magazzino.
    """
    movements = []
    lines = sale.lines.filter(line_type="product", product__isnull=False).select_related("product")
    for line in lines:
        movements.append(
            apply_movement(
                line.product,
                kind=StockMovement.Kind.SALE,
                qty=-Decimal(line.qty),
                reason="Vendita" + (" (omaggio)" if line.is_gift else ""),
                sale=sale,
                author=getattr(sale, "created_by", None),
            )
        )
    if movements:
        # Carichi e scarichi a mano ridisegnano il magazzino sulle altre
        # postazioni (eventi `stock.*`), le vendite no: la vendita registra solo
        # `sale.created`, che il magazzino non ascolta e che a un ruolo di solo
        # magazzino non arriva nemmeno. Chi teneva aperto il magazzino vedeva
        # ancora la tinta a 3 pezzi dopo averne venduti 3 (09-08). Nessun
        # importo nell'evento: lo riceve chi ha il magazzino, non la cassa.
        author = getattr(sale, "created_by", None)
        log_activity(
            sale.salon,
            "stock.sold",
            "Scarico da vendita: "
            + ", ".join(f"{m.product.name} ×{format(-m.qty.normalize(), 'f')}" for m in movements),
            actor=author if (author is not None and getattr(author, "pk", None)) else None,
            payload={
                "sale_id": sale.id,
                "product_ids": sorted({m.product_id for m in movements}),
            },
        )
    return movements


def save_product(product, salon, payload: dict, *, supplier, category):
    """Scrive l'anagrafica del prodotto (nuovo o esistente), MAI la giacenza.

    `payload` sono i campi del corpo senza fornitore e categoria, che arrivano
    già letti fra quelli del salone.
    """
    if payload["usage"] not in Product.Usage.values:
        raise HttpError(400, "Tipo di utilizzo non valido")
    for name, value in payload.items():
        setattr(product, name, value)
    product.supplier = supplier
    product.category = category
    if product.pk is None:
        product.salon = salon
        product.save()
        return product
    # In modifica si scrivono SOLO i campi anagrafici arrivati nel payload.
    # `models.Product` dichiara che `stock_qty` non va mai scritta direttamente:
    # un save() pieno la riportava al valore letto a inizio richiesta, e i
    # movimenti registrati nel frattempo (una vendita al banco mentre si
    # correggeva il prezzo) sparivano dalla giacenza pur restando nello storico.
    product.save(update_fields=[*payload.keys(), "supplier", "category", "updated_at"])
    return product
