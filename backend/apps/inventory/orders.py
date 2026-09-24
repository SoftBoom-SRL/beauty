"""Ordini ai fornitori: bozze dalle soglie, modifica, invio e ricezione.

Ogni passaggio di stato si decide sulla riga dell'ordine BLOCCATA e riletta
dentro la transazione, non sulla copia arrivata con la richiesta: due schermate
aperte sullo stesso ordine non lo mandano due volte al fornitore e non lo
ricevono due volte a magazzino.
"""

from decimal import Decimal

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from ninja.errors import HttpError

from .models import Product, PurchaseOrder, PurchaseOrderLine, StockMovement
from .services import apply_movement, lock_salon


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
        lock_salon(salon)
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


def update_draft_order(order, lines) -> None:
    """Nuove quantità per le righe di una bozza (0 o meno = riga tolta)."""
    # La stessa riga due volte nel corpo diventava due oggetti letti per conto
    # loro: con la riga a 0 e poi a 3 il primo la cancellava, il secondo
    # provava a salvarla e Django sollevava DatabaseError («Save with
    # update_fields did not affect any rows»), un 500. La dashboard toglie già
    # i doppioni: succedeva con una richiesta scritta a mano (voce 25 dei bug
    # sospetti del 24/09).
    ids = [row.id for row in lines]
    if len(ids) != len(set(ids)):
        raise HttpError(400, "La stessa riga d'ordine compare più volte")
    # Tutto o niente: prima si risolvono TUTTE le righe, poi si scrive. Applicarle
    # una per una lasciava l'ordine a metà quando l'ultima riga era sconosciuta —
    # 404 al client, ma le quantità precedenti già cambiate a magazzino.
    with transaction.atomic():
        if (
            PurchaseOrder.objects.select_for_update()
            .filter(pk=order.pk, status=PurchaseOrder.Status.DRAFT)
            .first()
            is None
        ):
            raise HttpError(400, "Solo le bozze d'ordine sono modificabili")
        rows = []
        for row in lines:
            line = order.lines.filter(pk=row.id).first()
            if line is None:
                raise HttpError(404, "Riga d'ordine non trovata")
            rows.append((line, row.qty_ordered))
        for line, qty_ordered in rows:
            if qty_ordered <= 0:
                line.delete()
            else:
                line.qty_ordered = qty_ordered
                line.save(update_fields=["qty_ordered"])


def mark_order_sent(order, method: str):
    """Segna la bozza come inviata col metodo scelto. Ritorna (ordine riletto, righe)."""
    # Come in `receive_order`: lo stato si guarda sulla riga BLOCCATA e riletta,
    # non sulla copia arrivata con la richiesta. Due schermate aperte sullo
    # stesso ordine mandavano altrimenti due volte la stessa ordinazione al
    # fornitore, che spediva la merce due volte.
    with transaction.atomic():
        locked = (
            PurchaseOrder.objects.select_for_update()
            .filter(pk=order.pk, status=PurchaseOrder.Status.DRAFT)
            .first()
        )
        if locked is None:
            raise HttpError(400, "L'ordine è già stato inviato")
        order = locked
        lines = list(order.lines.select_related("product"))
        if not lines:
            raise HttpError(400, "Impossibile inviare un ordine senza righe")
        order.status = PurchaseOrder.Status.SENT
        order.sent_method = method
        order.sent_at = timezone.now()
        order.save(update_fields=["status", "sent_method", "sent_at", "updated_at"])
    return order, lines


def supplier_order_payload(order, method: str, lines) -> dict:
    """Evento `supplier.order` per Yourang: il fornitore e le righe da ordinare."""
    return {
        "order_id": order.id,
        "method": method,
        "supplier": {
            "id": order.supplier_id,
            "name": order.supplier.name,
            "email": order.supplier.email,
            "phone": order.supplier.phone,
        },
        "lines": [
            {
                "product_id": line.product_id,
                "name": line.product.name,
                "sku": line.product.sku,
                "qty": float(line.qty_ordered),
                "package_unit": line.product.package_unit,
            }
            for line in lines
        ],
    }


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
