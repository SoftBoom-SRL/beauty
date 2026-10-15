"""Passo «stock»: la storia dei movimenti di magazzino e la giacenza di oggi.

I movimenti si scrivono direttamente, senza `inventory.services.apply_movement`:
la storia di AreaBeauty va anche sotto zero (prodotti venduti prima di essere
caricati), cosa che la porta di beauty giustamente rifiuta. Alla fine la
giacenza di ogni prodotto è quella di AreaBeauty; se la somma dei movimenti non
ci arriva, un movimento di rettifica colma la differenza, così giacenza e
storia restano coerenti come per i prodotti nati in beauty.
"""

import datetime as dt
from collections import defaultdict
from decimal import Decimal

from django.db.models import Sum

from apps.inventory.models import Product, StockMovement

from ..source import ROME, day
from ..util import clip

K = StockMovement.Kind
KINDS = {
    "carico": K.LOAD,
    "carico generico": K.ADJUSTMENT,
    "scarico": K.INTERNAL_USE,
    "scarico da punto vendita": K.SALE,
}


def run(ctx):
    products = ctx.refs("prodotto")
    operators = ctx.refs("operatore")
    sales = ctx.refs("vendita")
    movements, exts = [], []
    for m in ctx.source.movements:
        ext = m.get("idMovimento")
        if ctx.ref("movimento", ext):
            continue
        product_pk = products.get(str(m.get("idArticolo")))
        if not product_pk:
            ctx.count("movimenti di prodotti sconosciuti saltati")
            continue
        qty = Decimal(str(m.get("quantita") or 0))
        if qty == 0:
            ctx.count("movimenti a quantità zero saltati")
            continue
        if (m.get("idCausale") or "").strip().lower() == "scarico":
            qty = -qty
        cause = (m.get("causale") or "").strip().lower()
        kind = KINDS.get(cause, K.ADJUSTMENT)
        sale_pk = sales.get(str(m.get("idTransazione"))) if kind == K.SALE else None
        when = day(m.get("dataMovimento"))
        movement = StockMovement(
            salon=ctx.salon,
            product_id=product_pk,
            kind=kind,
            qty=qty,
            reason=clip(m.get("descrizione") or m.get("causale"), 255),
            sale_id=sale_pk,
            operator_id=operators.get(m.get("idOperatore")),
        )
        movement._when = dt.datetime.combine(when, dt.time(12, 0), tzinfo=ROME) if when else None
        movements.append(movement)
        exts.append(ext)
        ctx.count(f"movimenti {kind}")
    StockMovement.objects.bulk_create(movements, batch_size=1000)
    dated = [m for m in movements if m._when]
    for m in dated:
        m.created_at = m._when
    StockMovement.objects.bulk_update(dated, ["created_at"], batch_size=1000)
    ctx.link_many("movimento", list(zip(exts, movements)))
    _align(ctx, products)


def _align(ctx, products):
    """Giacenza = quella di AreaBeauty; la differenza con la storia diventa una rettifica."""
    target = {}
    for g in list(ctx.source.stock_deleted) + list(ctx.source.stock):  # gli attivi vincono
        target[str(g.get("ArticoloId"))] = Decimal(str(g.get("QuantitaGiacenza") or 0))
    by_pk = {pk: target.get(ext) for ext, pk in products.items() if ext in target}
    sums = defaultdict(Decimal)
    for row in StockMovement.objects.filter(product_id__in=list(by_pk)).values("product_id").annotate(t=Sum("qty")):
        sums[row["product_id"]] = row["t"] or Decimal("0")
    fixes = []
    for pk, qty in by_pk.items():
        diff = qty - sums[pk]
        if diff:
            fixes.append(StockMovement(
                salon=ctx.salon, product_id=pk, kind=K.ADJUSTMENT, qty=diff,
                reason="Allineamento alla giacenza di AreaBeauty",
            ))
    StockMovement.objects.bulk_create(fixes, batch_size=1000)
    if fixes:
        ctx.count("rettifiche per tornare alla giacenza di AreaBeauty", len(fixes))
    for qty in sorted(set(by_pk.values())):
        Product.objects.filter(pk__in=[pk for pk, q in by_pk.items() if q == qty]).update(stock_qty=qty)
    ctx.count("giacenze scritte", len(by_pk))
    ctx.count("giacenze negative (come in AreaBeauty)", sum(1 for q in by_pk.values() if q < 0))
