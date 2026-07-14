from django.db import models


class Coupon(models.Model):
    """Buono sconto (manuale, automatico o generato dal programma fedeltà)."""

    class Kind(models.TextChoices):
        PERCENT = "percent", "%"
        AMOUNT = "amount", "€"

    class Origin(models.TextChoices):
        MANUAL = "manual", "Manuale"
        AUTO = "auto", "Automatico"
        LOYALTY = "loyalty", "Fedeltà"

    class Status(models.TextChoices):
        ACTIVE = "active", "Attivo"
        REDEEMED = "redeemed", "Utilizzato"
        EXPIRED = "expired", "Scaduto"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="coupons")
    client = models.ForeignKey(
        "clients.Client",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="coupons",
    )
    code = models.CharField(max_length=16)  # human_code(8), unique per salone
    kind = models.CharField(max_length=10, choices=Kind.choices)
    value = models.DecimalField(max_digits=10, decimal_places=2)
    origin = models.CharField(max_length=10, choices=Origin.choices, default=Origin.MANUAL)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)
    expires_at = models.DateTimeField(null=True, blank=True)
    redeemed_at = models.DateTimeField(null=True, blank=True)
    sale = models.ForeignKey(
        "sales.Sale", on_delete=models.SET_NULL, null=True, blank=True, related_name="coupons"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["salon", "code"], name="uq_coupon_salon_code"),
        ]

    def __str__(self):
        return f"{self.code} ({self.get_kind_display()} {self.value})"


class GiftCard(models.Model):
    """Carta regalo con saldo scalabile ai pagamenti (vedi redeem_gift_card)."""

    class PaymentStatus(models.TextChoices):
        PAID = "paid", "Pagata"
        UNPAID = "unpaid", "Da pagare"

    class Status(models.TextChoices):
        ACTIVE = "active", "Attiva"
        REDEEMED = "redeemed", "Esaurita"
        EXPIRED = "expired", "Scaduta"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="gift_cards")
    code = models.CharField(max_length=16)  # human_code(12), unique per salone
    initial_value = models.DecimalField(max_digits=10, decimal_places=2)
    balance = models.DecimalField(max_digits=10, decimal_places=2)
    # Se valorizzato la carta regala un trattamento specifico (valore = prezzo servizio);
    # null = carta monetaria ordinaria. Il saldo/riscatto resta invariato.
    gift_service = models.ForeignKey(
        "catalog.Service", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    buyer_client = models.ForeignKey(
        "clients.Client",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="gift_cards_bought",
    )
    recipient_client = models.ForeignKey(
        "clients.Client",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="gift_cards_received",
    )
    recipient_name = models.CharField(max_length=120, blank=True)
    payment_status = models.CharField(
        max_length=10, choices=PaymentStatus.choices, default=PaymentStatus.UNPAID
    )
    paid_at = models.DateTimeField(null=True, blank=True)
    paid_method = models.CharField(max_length=20, blank=True)
    delivery_date = models.DateField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["salon", "code"], name="uq_giftcard_salon_code"),
        ]

    def __str__(self):
        return f"{self.code} (€{self.balance}/{self.initial_value})"


class LoyaltyProgram(models.Model):
    """Programma fedeltà: accumulo punti/timbri e premio alla soglia."""

    class Type(models.TextChoices):
        POINTS = "points", "Punti"
        STAMPS = "stamps", "Timbri"
        TIERS = "tiers", "Livelli"
        MEMBERSHIP = "membership", "Membership"

    class EarnMetric(models.TextChoices):
        PER_EURO = "per_euro", "Per euro speso"
        PER_VISIT = "per_visit", "Per visita"
        PER_SERVICE = "per_service", "Per servizio"

    class RewardType(models.TextChoices):
        COUPON_AMOUNT = "coupon_amount", "Coupon €"
        DISCOUNT_PCT = "discount_pct", "Sconto %"
        FREE_SERVICE = "free_service", "Servizio omaggio"
        FREE_PRODUCT = "free_product", "Prodotto omaggio"
        GIFT_CARD = "gift_card", "Gift card"

    class Enrollment(models.TextChoices):
        AUTO = "auto", "Automatica"
        REQUEST = "request", "Su richiesta"
        PAID = "paid", "A pagamento"

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="loyalty_programs"
    )
    name = models.CharField(max_length=120)
    type = models.CharField(max_length=12, choices=Type.choices, default=Type.POINTS)
    earn_metric = models.CharField(
        max_length=12, choices=EarnMetric.choices, default=EarnMetric.PER_EURO
    )
    earn_ratio = models.DecimalField(max_digits=10, decimal_places=2, default=1)
    reward_type = models.CharField(
        max_length=15, choices=RewardType.choices, default=RewardType.COUPON_AMOUNT
    )
    reward_value = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    reward_service = models.ForeignKey(
        "catalog.Service", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    threshold = models.PositiveIntegerField()
    enrollment = models.CharField(
        max_length=10, choices=Enrollment.choices, default=Enrollment.AUTO
    )
    points_expiry_months = models.PositiveSmallIntegerField(default=0)  # 0 = mai
    bonus = models.JSONField(default=dict, blank=True)  # {birthday, referral, prebooking, ...}
    color = models.CharField(max_length=7, default="#6366F1")
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.name


class LoyaltyAccount(models.Model):
    """Saldo punti di un cliente in un programma."""

    program = models.ForeignKey(
        LoyaltyProgram, on_delete=models.CASCADE, related_name="accounts"
    )
    client = models.ForeignKey(
        "clients.Client", on_delete=models.CASCADE, related_name="loyalty_accounts"
    )
    points = models.IntegerField(default=0)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-points"]
        constraints = [
            models.UniqueConstraint(fields=["program", "client"], name="uq_loyalty_program_client"),
        ]

    def __str__(self):
        return f"{self.client} · {self.program.name}: {self.points}"


class Communication(models.Model):
    """Comunicazione broadcast (l'invio effettivo è demandato a Yourang via outbox)."""

    class AudienceType(models.TextChoices):
        LABELS = "labels", "Etichette"
        CLIENTS = "clients", "Clienti"

    class Status(models.TextChoices):
        DRAFT = "draft", "Bozza"
        SCHEDULED = "scheduled", "Programmata"
        SENT = "sent", "Inviata"

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="communications"
    )
    title = models.CharField(max_length=200)
    body = models.TextField()
    image = models.ImageField(upload_to="communications/", null=True, blank=True)
    cta_label = models.CharField(max_length=80, blank=True)
    cta_url = models.CharField(max_length=300, blank=True)
    audience_type = models.CharField(
        max_length=10, choices=AudienceType.choices, default=AudienceType.LABELS
    )
    audience = models.JSONField(default=list, blank=True)  # category ids o client ids
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.DRAFT)
    scheduled_at = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.title} ({self.status})"
