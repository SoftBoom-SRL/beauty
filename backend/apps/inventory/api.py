import logging
import re
from decimal import Decimal
from typing import Optional

from django.db import DatabaseError, transaction
from django.db.models import Case, F, IntegerField, ProtectedError, Q, Value, When
from django.utils import timezone
from django.utils.dateparse import parse_date
from ninja import File, Form, Router
from ninja.errors import HttpError
from ninja.files import UploadedFile
from ninja.pagination import LimitOffsetPagination, paginate

from apps.core.services import emit_event, log_activity
from common.auth import staff_auth
from common.media import stored_upload_name
from common.permissions import require_scope
from common.schemas import OkOut
from common.utils import salon_get

from .models import Product, ProductCategory, PurchaseOrder, StockMovement, Supplier
from .schemas import (
    CategoryIn,
    CategoryOut,
    LoadCsvIn,
    LoadCsvOut,
    MovementOut,
    OrderOut,
    OrderReceiveIn,
    OrderReceiveOut,
    OrderSendIn,
    OrderUpdateIn,
    ProductIn,
    ProductLoadIn,
    ProductOut,
    ProductUnloadIn,
    SupplierIn,
    SupplierOut,
)
from .services import apply_movement, generate_draft_orders, receive_order

router = Router(tags=["inventory"])
logger = logging.getLogger(__name__)

UNLOAD_KINDS = {
    StockMovement.Kind.INTERNAL_USE,
    StockMovement.Kind.ADJUSTMENT,
    StockMovement.Kind.TRANSFER,
}

_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}\Z")
# PositiveSmallIntegerField: sopra questo valore il database rifiuta la riga, e
# al cliente arriva un 500 invece del 400 che gli spiega cosa ha sbagliato.
MAX_CATEGORY_ORDER = 32767

# La fattura del carico finisce in uno storage servito da noi: senza un tetto
# alla dimensione e un elenco di formati, il campo «allega fattura» è un
# caricamento libero di file arbitrari (stesso controllo di clients/api.py).
INVOICE_TYPES = (
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
)
INVOICE_MAX_BYTES = 15 * 1024 * 1024

# Tetto alla quantità di un carico. La colonna è numeric(10,2): oltre i cento
# milioni PostgreSQL risponde «numeric field overflow», cioè un 500 (su SQLite
# dei test passa e basta). Il caso vero è l'EAN di tredici cifre che il CSV
# della bolla mette nell'ultima colonna, letto come quantità (09-06). Nessun
# salone carica centomila confezioni in una volta.
MAX_LOAD_QTY = Decimal("100000")


def _products_qs(ctx):
    return Product.objects.filter(salon=ctx.salon).select_related("category", "supplier")


def _apply_product_payload(product: Product, ctx, data: ProductIn) -> Product:
    payload = data.dict()
    supplier = salon_get(Supplier, ctx, payload.pop("supplier_id"))
    category_id = payload.pop("category_id")
    category = salon_get(ProductCategory, ctx, category_id) if category_id else None
    if payload["usage"] not in Product.Usage.values:
        raise HttpError(400, "Tipo di utilizzo non valido")
    for name, value in payload.items():
        setattr(product, name, value)
    product.supplier = supplier
    product.category = category
    if product.pk is None:
        product.salon = ctx.salon
        product.save()
        return product
    # In modifica si scrivono SOLO i campi anagrafici arrivati nel payload.
    # `models.Product` dichiara che `stock_qty` non va mai scritta direttamente:
    # un save() pieno la riportava al valore letto a inizio richiesta, e i
    # movimenti registrati nel frattempo (una vendita al banco mentre si
    # correggeva il prezzo) sparivano dalla giacenza pur restando nello storico.
    product.save(update_fields=[*payload.keys(), "supplier", "category", "updated_at"])
    return product


def _validate_category_in(data: CategoryIn) -> None:
    """Colore e ordine arrivano dal client e finiscono grezzi in colonne strette.

    Senza questo controllo un colore di venti caratteri o un ordine negativo non
    sono un errore della richiesta ma un errore del database: 500 e nessuna
    spiegazione a chi sta compilando il modulo.
    """
    if not (0 <= data.order <= MAX_CATEGORY_ORDER):
        raise HttpError(400, "Ordine della categoria non valido")
    if data.color is not None and not _HEX_COLOR_RE.match((data.color or "").strip()):
        raise HttpError(400, "Colore non valido (atteso #RRGGBB)")


def _invoice_upload_name(upload: UploadedFile) -> str:
    """Valida la fattura e restituisce il nome con cui salvarla su disco.

    Si controllavano solo il tipo dichiarato (lo scrive il client) e la
    dimensione, e il file finiva su disco con nome ed estensione del client:
    un «fattura.html» dichiarato application/pdf restava un .html (10-16). Ora
    vale la regola unica di `common.media`, come per logo, allegati e foto:
    estensione coerente col tipo e nome generato dal server.
    """
    ctype = (upload.content_type or "").lower().split(";")[0].strip()
    if ctype not in INVOICE_TYPES:
        raise HttpError(400, f"Formato fattura non supportato: {upload.name} (PDF o immagine)")
    return stored_upload_name(upload, allowed_types=INVOICE_TYPES, max_bytes=INVOICE_MAX_BYTES)


# ---- Prodotti ----------------------------------------------------------------


@router.get("/products", auth=staff_auth, response=list[ProductOut])
@paginate(LimitOffsetPagination)
def list_products(
    request,
    q: str = "",
    category_id: Optional[int] = None,
    supplier_id: Optional[int] = None,
    brand: str = "",
    usage: str = "",
    stock_state: str = "",
    include_inactive: bool = False,
):
    ctx = request.auth
    qs = _products_qs(ctx)
    if not include_inactive:
        qs = qs.filter(active=True)
    if q:
        qs = qs.filter(Q(name__icontains=q) | Q(sku__icontains=q) | Q(brand__icontains=q))
    if category_id:
        qs = qs.filter(category_id=category_id)
    if supplier_id:
        qs = qs.filter(supplier_id=supplier_id)
    if brand:
        qs = qs.filter(brand__iexact=brand)
    if usage:
        qs = qs.filter(usage=usage)
    if stock_state == "low":
        qs = qs.filter(stock_qty__lte=F("min_threshold"))
    elif stock_state == "warning":
        qs = qs.filter(
            stock_qty__gt=F("min_threshold"),
            stock_qty__lte=F("min_threshold") * Decimal("1.5"),
        )
    elif stock_state == "ok":
        qs = qs.filter(stock_qty__gt=F("min_threshold") * Decimal("1.5"))
    # default: prodotti sotto soglia prima. L'id in coda rende l'ordine univoco:
    # con due omonimi (marche diverse) a cavallo fra due pagine, LIMIT/OFFSET su
    # PostgreSQL poteva ripeterne uno e saltare l'altro (09-10).
    return qs.annotate(
        below_threshold=Case(
            When(stock_qty__lte=F("min_threshold"), then=Value(0)),
            default=Value(1),
            output_field=IntegerField(),
        )
    ).order_by("below_threshold", "name", "id")


@router.post("/products", auth=staff_auth, response=ProductOut)
def create_product(request, data: ProductIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    product = _apply_product_payload(Product(), ctx, data)
    log_activity(
        ctx.salon,
        "product.created",
        f"Nuovo prodotto: {product.name}",
        actor=ctx.user,
        payload={"product_id": product.id},
    )
    return product


@router.get("/products/{int:product_id}", auth=staff_auth, response=ProductOut)
def get_product(request, product_id: int):
    return salon_get(Product, request.auth, product_id)


@router.put("/products/{int:product_id}", auth=staff_auth, response=ProductOut)
def update_product(request, product_id: int, data: ProductIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    product = salon_get(Product, ctx, product_id)
    product = _apply_product_payload(product, ctx, data)
    log_activity(
        ctx.salon,
        "product.updated",
        f"Prodotto aggiornato: {product.name}",
        actor=ctx.user,
        payload={"product_id": product.id},
    )
    return product


@router.delete("/products/{int:product_id}", auth=staff_auth, response=OkOut)
def delete_product(request, product_id: int):
    """Soft delete: il prodotto resta in archivio (movimenti/storici intatti)."""
    ctx = request.auth
    require_scope(ctx, "inventory")
    product = salon_get(Product, ctx, product_id)
    product.active = False
    product.save(update_fields=["active", "updated_at"])
    log_activity(
        ctx.salon,
        "product.deleted",
        f"Prodotto disattivato: {product.name}",
        actor=ctx.user,
        payload={"product_id": product.id},
    )
    return OkOut()


# ---- Carichi e scarichi ------------------------------------------------------


@router.post("/products/{int:product_id}/load", auth=staff_auth, response=MovementOut)
def load_product(
    request,
    product_id: int,
    data: Form[ProductLoadIn],
    invoice: Optional[UploadedFile] = File(None),
):
    ctx = request.auth
    require_scope(ctx, "inventory")
    product = salon_get(Product, ctx, product_id)
    if data.qty <= 0:
        raise HttpError(422, "La quantità da caricare deve essere positiva")
    if data.qty > MAX_LOAD_QTY:
        raise HttpError(422, f"Quantità fuori scala: {data.qty}")
    if invoice is not None:
        invoice.name = _invoice_upload_name(invoice)
    movement = apply_movement(
        product,
        kind=StockMovement.Kind.LOAD,
        qty=data.qty,
        reason=data.reason,
        author=ctx.user,
        invoice=invoice,
    )
    log_activity(
        ctx.salon,
        "stock.loaded",
        f"Carico {product.name}: +{data.qty}",
        actor=ctx.user,
        payload={"product_id": product.id, "movement_id": movement.id, "qty": float(data.qty)},
    )
    return movement


@router.post("/products/{int:product_id}/unload", auth=staff_auth, response=MovementOut)
def unload_product(request, product_id: int, data: ProductUnloadIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    product = salon_get(Product, ctx, product_id)
    if data.qty <= 0:
        raise HttpError(422, "La quantità da scaricare deve essere positiva")
    if data.kind not in UNLOAD_KINDS:
        raise HttpError(400, "Causale di scarico non valida")
    operator = None
    if data.operator_id is not None:
        from apps.staff.models import Operator

        operator = salon_get(Operator, ctx, data.operator_id)
    movement = apply_movement(
        product,
        kind=data.kind,
        qty=-data.qty,
        reason=data.reason,
        author=ctx.user,
        operator=operator,
    )
    log_activity(
        ctx.salon,
        "stock.unloaded",
        f"Scarico {product.name}: -{data.qty} ({data.kind})",
        actor=ctx.user,
        payload={"product_id": product.id, "movement_id": movement.id, "qty": float(data.qty)},
    )
    return movement


def _single_active_match(qs, what: str) -> Optional[Product]:
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


def _csv_row_product(ctx, row, default_supplier_id) -> tuple[Product, str]:
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
        product = _single_active_match(products.filter(sku__iexact=row.sku), "SKU")
    if product is None and row.name:
        product = _single_active_match(products.filter(name__iexact=row.name), "Nome")
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


@router.post("/load-csv", auth=staff_auth, response=LoadCsvOut)
def load_csv(request, data: LoadCsvIn):
    """Carico multiplo da CSV: per `product_id`, altrimenti per SKU poi per nome
    fra i prodotti attivi; non sovrascrive, somma.

    Se il prodotto non esiste viene creato (serve supplier_id di riga o globale).
    Ogni riga è tutto-o-niente e ha il suo esito: un errore, anche del
    database, resta sulla sua riga. Prima un errore che non fosse HttpError
    chiudeva la richiesta con un 500 dopo aver già caricato le righe
    precedenti, e il nuovo tentativo le caricava due volte (09-06).
    """
    ctx = request.auth
    require_scope(ctx, "inventory")
    results = []
    loaded = created = errors = 0
    for idx, row in enumerate(data.rows, start=1):
        label = row.name or row.sku
        try:
            with transaction.atomic():
                product, status = _csv_row_product(ctx, row, data.supplier_id)
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
    log_activity(
        ctx.salon,
        "stock.csv_loaded",
        f"Carico CSV: {loaded} righe caricate, {created} prodotti creati, {errors} errori",
        actor=ctx.user,
        payload={"loaded": loaded, "created": created, "errors": errors},
    )
    return {"results": results, "loaded": loaded, "created": created, "errors": errors}


# ---- Movimenti ---------------------------------------------------------------


def _filter_movements(qs, kind: str, date_from: str, date_to: str):
    if kind:
        qs = qs.filter(kind=kind)
    if date_from and (d := parse_date(date_from)):
        qs = qs.filter(created_at__date__gte=d)
    if date_to and (d := parse_date(date_to)):
        qs = qs.filter(created_at__date__lte=d)
    # Ordine univoco sotto la paginazione, come per i prodotti (09-10).
    return qs.order_by("-created_at", "-id")


@router.get("/products/{int:product_id}/movements", auth=staff_auth, response=list[MovementOut])
@paginate(LimitOffsetPagination)
def list_product_movements(
    request, product_id: int, kind: str = "", date_from: str = "", date_to: str = ""
):
    ctx = request.auth
    product = salon_get(Product, ctx, product_id)
    qs = product.movements.select_related("product", "author", "operator")
    return _filter_movements(qs, kind, date_from, date_to)


@router.get("/movements", auth=staff_auth, response=list[MovementOut])
@paginate(LimitOffsetPagination)
def list_movements(
    request,
    kind: str = "",
    date_from: str = "",
    date_to: str = "",
    product_id: Optional[int] = None,
):
    ctx = request.auth
    qs = StockMovement.objects.filter(salon=ctx.salon).select_related("product", "author", "operator")
    if product_id:
        qs = qs.filter(product_id=product_id)
    return _filter_movements(qs, kind, date_from, date_to)


# ---- Fornitori ---------------------------------------------------------------


@router.get("/suppliers", auth=staff_auth, response=list[SupplierOut])
def list_suppliers(request):
    return Supplier.objects.filter(salon=request.auth.salon)


@router.post("/suppliers", auth=staff_auth, response=SupplierOut)
def create_supplier(request, data: SupplierIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    if data.order_method not in Supplier.OrderMethod.values:
        raise HttpError(400, "Metodo d'ordine non valido")
    supplier = Supplier.objects.create(salon=ctx.salon, **data.dict())
    log_activity(
        ctx.salon,
        "supplier.created",
        f"Nuovo fornitore: {supplier.name}",
        actor=ctx.user,
        payload={"supplier_id": supplier.id},
    )
    return supplier


@router.put("/suppliers/{int:supplier_id}", auth=staff_auth, response=SupplierOut)
def update_supplier(request, supplier_id: int, data: SupplierIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    if data.order_method not in Supplier.OrderMethod.values:
        raise HttpError(400, "Metodo d'ordine non valido")
    supplier = salon_get(Supplier, ctx, supplier_id)
    for name, value in data.dict().items():
        setattr(supplier, name, value)
    supplier.save()
    log_activity(
        ctx.salon,
        "supplier.updated",
        f"Fornitore aggiornato: {supplier.name}",
        actor=ctx.user,
        payload={"supplier_id": supplier.id},
    )
    return supplier


@router.delete("/suppliers/{int:supplier_id}", auth=staff_auth, response=OkOut)
def delete_supplier(request, supplier_id: int):
    ctx = request.auth
    require_scope(ctx, "inventory")
    supplier = salon_get(Supplier, ctx, supplier_id)
    name = supplier.name
    try:
        supplier.delete()
    except ProtectedError:
        raise HttpError(400, "Fornitore con prodotti o ordini associati: impossibile eliminarlo")
    log_activity(
        ctx.salon,
        "supplier.deleted",
        f"Fornitore eliminato: {name}",
        actor=ctx.user,
    )
    return OkOut()


# ---- Categorie prodotto ------------------------------------------------------


@router.get("/categories", auth=staff_auth, response=list[CategoryOut])
def list_categories(request):
    return ProductCategory.objects.filter(salon=request.auth.salon)


@router.post("/categories", auth=staff_auth, response=CategoryOut)
def create_category(request, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    _validate_category_in(data)
    return ProductCategory.objects.create(
        salon=ctx.salon,
        name=data.name,
        order=data.order,
        color=(data.color or "#E0E7FF").strip(),
    )


@router.put("/categories/{int:category_id}", auth=staff_auth, response=CategoryOut)
def update_category(request, category_id: int, data: CategoryIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    _validate_category_in(data)
    category = salon_get(ProductCategory, ctx, category_id)
    category.name = data.name
    category.order = data.order
    if data.color is not None:
        category.color = data.color.strip()
    category.save()
    return category


@router.delete("/categories/{int:category_id}", auth=staff_auth, response=OkOut)
def delete_category(request, category_id: int):
    ctx = request.auth
    require_scope(ctx, "inventory")
    salon_get(ProductCategory, ctx, category_id).delete()
    return OkOut()


# ---- Ordini fornitore ---------------------------------------------------------


def _orders_qs(ctx):
    return (
        PurchaseOrder.objects.filter(salon=ctx.salon)
        .select_related("supplier")
        .prefetch_related("lines__product")
    )


@router.get("/orders", auth=staff_auth, response=list[OrderOut])
@paginate(LimitOffsetPagination)
def list_orders(request, status: str = "", supplier_id: Optional[int] = None):
    qs = _orders_qs(request.auth)
    if status:
        qs = qs.filter(status=status)
    if supplier_id:
        qs = qs.filter(supplier_id=supplier_id)
    return qs


@router.post("/orders/generate", auth=staff_auth, response=list[OrderOut])
def generate_orders(request):
    """Genera bozze d'ordine per i prodotti sotto soglia, raggruppate per fornitore."""
    ctx = request.auth
    require_scope(ctx, "inventory")
    orders = generate_draft_orders(ctx.salon, author=ctx.user)
    log_activity(
        ctx.salon,
        "order.generated",
        f"Generate {len(orders)} bozze d'ordine da soglie di magazzino",
        actor=ctx.user,
        payload={"order_ids": [o.id for o in orders]},
    )
    return orders


@router.get("/orders/{int:order_id}", auth=staff_auth, response=OrderOut)
def get_order(request, order_id: int):
    return salon_get(PurchaseOrder, request.auth, order_id)


@router.put("/orders/{int:order_id}", auth=staff_auth, response=OrderOut)
def update_order(request, order_id: int, data: OrderUpdateIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    order = salon_get(PurchaseOrder, ctx, order_id)
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
        for row in data.lines:
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
    log_activity(
        ctx.salon,
        "order.updated",
        f"Ordine #{order.id} aggiornato ({order.supplier.name})",
        actor=ctx.user,
        payload={"order_id": order.id},
    )
    return order


@router.post("/orders/{int:order_id}/send", auth=staff_auth, response=OrderOut)
def send_order(request, order_id: int, data: OrderSendIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    order = salon_get(PurchaseOrder, ctx, order_id)
    method = data.method or order.supplier.order_method
    if method not in Supplier.OrderMethod.values:
        raise HttpError(400, "Metodo d'invio non valido")
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
    emit_event(
        ctx.salon,
        "supplier.order",
        {
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
        },
    )
    log_activity(
        ctx.salon,
        "order.sent",
        f"Ordine #{order.id} inviato a {order.supplier.name} ({method})",
        actor=ctx.user,
        payload={"order_id": order.id, "method": method},
    )
    return order


@router.post("/orders/{int:order_id}/receive", auth=staff_auth, response=OrderReceiveOut)
def receive_order_view(request, order_id: int, data: OrderReceiveIn):
    ctx = request.auth
    require_scope(ctx, "inventory")
    order = salon_get(PurchaseOrder, ctx, order_id)
    order, discrepancies = receive_order(
        order, [row.dict() for row in data.lines], author=ctx.user
    )
    log_activity(
        ctx.salon,
        "order.received",
        f"Ordine #{order.id} ricevuto ({order.status})"
        + (f" — {len(discrepancies)} discrepanze" if discrepancies else ""),
        actor=ctx.user,
        payload={
            "order_id": order.id,
            "status": order.status,
            "discrepancies": [
                {
                    "line_id": d["line_id"],
                    "product_id": d["product_id"],
                    "qty_ordered": float(d["qty_ordered"]),
                    "qty_received": float(d["qty_received"]),
                }
                for d in discrepancies
            ],
        },
    )
    return {"order": order, "discrepancies": discrepancies}
