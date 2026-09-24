"""Logica di magazzino. INTEGRITÀ: ogni variazione di stock passa da `apply_movement`.

`Product.stock_qty` è denormalizzata: nessun endpoint o servizio la scrive
direttamente; si crea sempre uno `StockMovement` e lo stock viene aggiornato
atomicamente con `F()` sotto `select_for_update`.
"""

from decimal import Decimal

from django.db import transaction
from django.db.models import F
from ninja.errors import HttpError

from apps.core.models import Salon
from apps.core.services import log_activity

from .models import Product, PurchaseOrder, PurchaseOrderLine, StockMovement


def _lock_salon(salon) -> None:
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


def generate_draft_orders(salon, author=None):
    """Bozze d'ordine per i prodotti attivi sotto soglia, raggruppate per fornitore.

    Esclude i prodotti già presenti in ordini draft/sent. Quantità proposta:
    `reorder_qty`, oppure `min_threshold − stock_qty` se reorder_qty è 0.
    Se esiste già una bozza per il fornitore, le righe vengono aggiunte lì.
    Ritorna la lista degli ordini creati/aggiornati.
    """
    products = (
        Product.objects.filter(salon=salon, active=True, stock_qty__lte=F("min_threshold"))
        .exclude(
            order_lines__order__status__in=[
                PurchaseOrder.Status.DRAFT,
                PurchaseOrder.Status.SENT,
            ]
        )
        .select_related("supplier")
        .order_by("supplier_id", "name")
    )
    orders: list[PurchaseOrder] = []
    by_supplier: dict[int, PurchaseOrder] = {}
    with transaction.atomic():
        # «Cerco la bozza del fornitore» e «la creo» non sono atomici di per sé:
        # due click su «Genera ordini» producevano due bozze per lo stesso
        # fornitore e le righe raddoppiate (PurchaseOrderLine non ha un vincolo
        # di unicità su (order, product)). Il lock sulla riga del salone fa
        # attendere il secondo. Su SQLite è un no-op, ma lì si scrive in serie.
        _lock_salon(salon)
        for product in products:
            # Sotto soglia con reorder_qty a zero e giacenza ESATTAMENTE pari
            # alla soglia la differenza è zero: il prodotto risultava «low» in
            # elenco ma «Genera ordini» lo scartava in silenzio. Si riordina
            # almeno una confezione.
            qty = product.reorder_qty or (product.min_threshold - product.stock_qty) or Decimal("1")
            if qty <= 0:
                continue
            order = by_supplier.get(product.supplier_id)
            if order is None:
                order = PurchaseOrder.objects.filter(
                    salon=salon,
                    supplier_id=product.supplier_id,
                    status=PurchaseOrder.Status.DRAFT,
                ).first()
                if order is None:
                    order = PurchaseOrder.objects.create(
                        salon=salon, supplier_id=product.supplier_id
                    )
                by_supplier[product.supplier_id] = order
                orders.append(order)
            PurchaseOrderLine.objects.create(order=order, product=product, qty_ordered=qty)
    return orders


def receive_order(order, lines_data, author=None):
    """Registra la ricezione di un ordine: un movimento `load` per ogni riga.

    `lines_data`: iterable di {"id": line_id, "qty_received": Decimal}.
    Le righe non incluse restano a qty_received=0 (discrepanza).
    Stato finale: received se tutte le righe combaciano, altrimenti partial.
    Ritorna (order, discrepancies).
    """
    received_by_id = {int(row["id"]): Decimal(str(row["qty_received"])) for row in lines_data}
    with transaction.atomic():
        # Il controllo «già ricevuto» si fa sulla riga bloccata e RILETTA dentro
        # la transazione. Farlo sull'istanza arrivata con la richiesta lasciava
        # passare due volte la stessa ricezione — ogni carico prendeva il lock
        # sul prodotto, quindi la giacenza saliva di dieci due volte — e la riga
        # d'ordine restava a dieci: venti pezzi a magazzino, dieci sui documenti.
        if PurchaseOrder.objects.select_for_update().filter(pk=order.pk).first() is None:
            raise HttpError(404, "Ordine non trovato")
        order.refresh_from_db()
        if order.status in (PurchaseOrder.Status.RECEIVED, PurchaseOrder.Status.PARTIAL):
            raise HttpError(400, "Ordine già ricevuto")
        lines = list(order.lines.select_related("product"))
        for line in lines:
            qty = received_by_id.get(line.id)
            if qty is None:
                continue
            if qty < 0:
                raise HttpError(422, "Quantità ricevuta non valida")
            line.qty_received = qty
            line.save(update_fields=["qty_received"])
            if qty > 0:
                apply_movement(
                    line.product,
                    kind=StockMovement.Kind.LOAD,
                    qty=qty,
                    reason=f"Ricezione ordine #{order.pk}",
                    order=order,
                    author=author,
                )
        discrepancies = [
            {
                "line_id": line.id,
                "product_id": line.product_id,
                "product_name": line.product.name,
                "qty_ordered": line.qty_ordered,
                "qty_received": line.qty_received,
                "delta": line.qty_received - line.qty_ordered,
            }
            for line in lines
            if line.qty_received != line.qty_ordered
        ]
        order.status = (
            PurchaseOrder.Status.PARTIAL if discrepancies else PurchaseOrder.Status.RECEIVED
        )
        order.save(update_fields=["status", "updated_at"])
    return order, discrepancies
