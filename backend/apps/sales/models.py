from django.conf import settings
from django.db import models


class Sale(models.Model):
    """Incasso: checkout di un appuntamento oppure vendita diretta al banco (POS)."""

    class Kind(models.TextChoices):
        CHECKOUT = "checkout"
        POS = "pos"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="sales")
    location = models.ForeignKey(
        "core.Location", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    kind = models.CharField(max_length=10, choices=Kind.choices)
    appointment = models.OneToOneField(
        "agenda.Appointment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sale",
    )
    # Caparra di un appuntamento registrata come incasso a sé: entra in cassa il
    # giorno in cui arriva, non quello del conto finale (al checkout viene poi
    # detratta con `deposit_deducted`, così il denaro si conta una volta sola).
    # Non si può riusare `appointment`, che resta libero per il checkout dello
    # stesso appuntamento; il vincolo uno-a-uno impedisce che due webhook
    # consegnati insieme registrino due volte la stessa caparra.
    deposit_appointment = models.OneToOneField(
        "agenda.Appointment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="deposit_sale",
    )
    client = models.ForeignKey(
        "clients.Client", on_delete=models.SET_NULL, null=True, blank=True, related_name="sales"
    )
    # `total` è quanto il conto vale DAVVERO: le righe meno il buono sconto
    # eventualmente presentato al banco. Lo sconto resta scritto qui accanto
    # perché lo scontrino lo mostra e il titolare vuole sapere quanto regala il
    # programma fedeltà; il coupon consumato punta a questa vendita.
    total = models.DecimalField(max_digits=10, decimal_places=2)
    coupon_discount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    deposit_deducted = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["salon", "-created_at"])]

    def __str__(self):
        return f"Vendita #{self.pk} · {self.kind} · € {self.total}"


class SaleLine(models.Model):
    """Riga di vendita: servizio, prodotto retail o gift card venduta."""

    class LineType(models.TextChoices):
        SERVICE = "service"
        PRODUCT = "product"
        GIFT_CARD = "gift_card"

    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="lines")
    operator = models.ForeignKey(
        "staff.Operator", on_delete=models.SET_NULL, null=True, blank=True, related_name="sale_lines"
    )
    line_type = models.CharField(max_length=10, choices=LineType.choices)
    service = models.ForeignKey(
        "catalog.Service", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    product = models.ForeignKey(
        "inventory.Product", on_delete=models.SET_NULL, null=True, blank=True, related_name="sale_lines"
    )
    gift_card = models.ForeignKey(
        "marketing.GiftCard",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sold_in_lines",
        help_text="Gift card venduta con questa riga",
    )
    qty = models.PositiveIntegerField(default=1)
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)
    discount_pct = models.PositiveSmallIntegerField(default=0)
    is_gift = models.BooleanField(default=False)
    amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        help_text="qty × unit_price × (1 − discount/100); 0 se omaggio",
    )

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.line_type} ×{self.qty} · € {self.amount}"


class Payment(models.Model):
    """Pagamento di una vendita (una vendita può avere pagamenti misti)."""

    class Method(models.TextChoices):
        CASH = "cash"
        CARD = "card"
        OTHER = "other"
        GIFT_CARD = "gift_card"

    sale = models.ForeignKey(Sale, on_delete=models.CASCADE, related_name="payments")
    method = models.CharField(max_length=10, choices=Method.choices)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    gift_card = models.ForeignKey(
        "marketing.GiftCard",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="redeemed_in_payments",
        help_text="Gift card usata come pagamento",
    )

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.method} · € {self.amount}"
