from decimal import Decimal

from django.conf import settings
from django.db import models

from apps.core.models import TimeStampedModel


class Supplier(TimeStampedModel):
    """Fornitore del salone: destinatario degli ordini di riassortimento."""

    class OrderMethod(models.TextChoices):
        EMAIL = "email", "Email"
        WHATSAPP = "whatsapp", "WhatsApp"
        PDF = "pdf", "PDF"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="suppliers")
    name = models.CharField(max_length=120)
    email = models.EmailField(blank=True)
    phone = models.CharField(max_length=40, blank=True)
    order_method = models.CharField(
        max_length=10, choices=OrderMethod.choices, default=OrderMethod.EMAIL
    )
    address = models.CharField(max_length=255, blank=True)
    vat_number = models.CharField(max_length=20, blank=True)
    sdi_pec = models.CharField(max_length=120, blank=True)
    notes = models.TextField(blank=True)

    class Meta:
        ordering = ["name"]

    def __str__(self):
        return self.name


class ProductCategory(TimeStampedModel):
    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="product_categories"
    )
    name = models.CharField(max_length=120)
    order = models.PositiveSmallIntegerField(default=0)
    color = models.CharField(max_length=7, default="#E0E7FF")

    class Meta:
        ordering = ["order", "id"]
        verbose_name_plural = "Product categories"

    def __str__(self):
        return self.name


class Product(TimeStampedModel):
    """Prodotto a magazzino.

    ATTENZIONE: `stock_qty` è denormalizzata e NON va mai scritta direttamente;
    l'unica porta di variazione è `services.apply_movement`.
    """

    class Usage(models.TextChoices):
        INTERNAL = "internal", "Uso interno"
        RETAIL = "retail", "Rivendita"
        MIXED = "mixed", "Misto"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="products")
    name = models.CharField(max_length=160)
    sku = models.CharField(max_length=60, blank=True)
    brand = models.CharField(max_length=120, blank=True)
    category = models.ForeignKey(
        ProductCategory, on_delete=models.SET_NULL, null=True, blank=True, related_name="products"
    )
    usage = models.CharField(max_length=10, choices=Usage.choices, default=Usage.RETAIL)
    package_unit = models.CharField(max_length=20, blank=True)  # ml, pz…
    package_qty = models.DecimalField(max_digits=10, decimal_places=2, default=1)
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="products")
    purchase_price = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    purchase_discount_pct = models.PositiveSmallIntegerField(default=0)
    sale_price = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    vat_rate = models.PositiveSmallIntegerField(default=22)
    stock_qty = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    min_threshold = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    reorder_qty = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["name"]
        indexes = [models.Index(fields=["salon", "active"])]

    def __str__(self):
        return self.name

    @property
    def stock_state(self) -> str:
        """low se stock ≤ soglia, warning se ≤ soglia×1.5, altrimenti ok."""
        if self.stock_qty <= self.min_threshold:
            return "low"
        if self.stock_qty <= self.min_threshold * Decimal("1.5"):
            return "warning"
        return "ok"


class StockMovement(models.Model):
    """Movimento di magazzino: qty positiva = carico, negativa = scarico.

    Creato ESCLUSIVAMENTE da `services.apply_movement` (integrità dello stock).
    """

    class Kind(models.TextChoices):
        LOAD = "load", "Carico"
        SALE = "sale", "Vendita"
        INTERNAL_USE = "internal_use", "Uso interno"
        ADJUSTMENT = "adjustment", "Rettifica"
        TRANSFER = "transfer", "Trasferimento"
        RETURN_SUPPLIER = "return_supplier", "Reso a fornitore"

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="stock_movements"
    )
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="movements")
    kind = models.CharField(max_length=20, choices=Kind.choices)
    qty = models.DecimalField(max_digits=10, decimal_places=2)  # + carico / − scarico
    reason = models.CharField(max_length=255, blank=True)
    sale = models.ForeignKey(
        "sales.Sale", on_delete=models.SET_NULL, null=True, blank=True, related_name="stock_movements"
    )
    order = models.ForeignKey(
        "inventory.PurchaseOrder",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="movements",
    )
    invoice = models.FileField(upload_to="inventory/invoices/", null=True, blank=True)
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    operator = models.ForeignKey(
        "staff.Operator", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["salon", "-created_at"])]

    def __str__(self):
        return f"{self.product} {self.kind} {self.qty:+}"


class PurchaseOrder(TimeStampedModel):
    class Status(models.TextChoices):
        DRAFT = "draft", "Bozza"
        SENT = "sent", "Inviato"
        RECEIVED = "received", "Ricevuto"
        PARTIAL = "partial", "Parziale"

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="purchase_orders"
    )
    supplier = models.ForeignKey(Supplier, on_delete=models.PROTECT, related_name="orders")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    sent_method = models.CharField(max_length=10, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Ordine #{self.pk} · {self.supplier} ({self.status})"


class PurchaseOrderLine(models.Model):
    order = models.ForeignKey(PurchaseOrder, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name="order_lines")
    qty_ordered = models.DecimalField(max_digits=10, decimal_places=2)
    qty_received = models.DecimalField(max_digits=10, decimal_places=2, default=0)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.product} × {self.qty_ordered}"
