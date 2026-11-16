from decimal import ROUND_DOWN, Decimal

from django.conf import settings
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
    # Quante volte si può usare: 1 (come sempre), N, o NULL = senza limite.
    # Ogni buono era monouso: un codice promozionale per tutte le clienti
    # («PRIMAVERA10») andava creato una volta per cliente (Beauty Boutique,
    # 11/2026). `uses` conta gli utilizzi; all'ultimo il buono diventa
    # «utilizzato». `sale` e `redeemed_at` sono quelli dell'ultimo utilizzo.
    max_uses = models.PositiveIntegerField(null=True, blank=True, default=1, db_default=1)
    uses = models.PositiveIntegerField(default=0, db_default=0)
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
        # Creata per errore (o intestata alla cliente sbagliata): resta nello
        # storico ma non si spende più, e il saldo va a zero (vedi cancel_gift_card).
        CANCELLED = "cancelled", "Annullata"

    class Kind(models.TextChoices):
        # Comprata da qualcuno per qualcun altro (o per sé, come buono).
        GIFT = "gift", "Regalo"
        # Trattamento pagato in anticipo dalla cliente stessa: in agenda e in
        # cassa si legge «Già pagato», non «Regalo».
        PREPAID = "prepaid", "Già pagato"
        # Sedute di un pacchetto venduto in cassa (`package`, `package_line`).
        PACKAGE = "package", "Pacchetto"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="gift_cards")
    kind = models.CharField(
        max_length=10, choices=Kind.choices, default=Kind.GIFT, db_default=Kind.GIFT
    )
    code = models.CharField(max_length=16)  # human_code(12), unique per salone
    initial_value = models.DecimalField(max_digits=10, decimal_places=2)
    balance = models.DecimalField(max_digits=10, decimal_places=2)
    # Se valorizzato la carta regala un trattamento specifico (valore = prezzo servizio);
    # null = carta monetaria ordinaria. Il saldo/riscatto resta invariato.
    gift_service = models.ForeignKey(
        "catalog.Service", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    # Sedute del trattamento (solo con `gift_service`): un pacchetto da 12
    # manicure è UNA carta con 12 sedute. Ogni riscatto ne toglie una e scala
    # dal saldo il valore di una seduta (`session_value`); all'ultima il saldo
    # va a zero e la carta è esaurita. Le carte monetarie restano a 1/1.
    sessions_total = models.PositiveSmallIntegerField(default=1, db_default=1)
    sessions_left = models.PositiveSmallIntegerField(default=1, db_default=1)
    # Il pacchetto di listino e la riga di vendita da cui nasce la carta.
    package = models.ForeignKey(
        "catalog.Package", on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    package_line = models.ForeignKey(
        "sales.SaleLine",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="package_credits",
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
    # Annullamento: quando e perché. Il saldo che aveva la carta resta nel
    # registro attività (`giftcard.cancelled`), perché qui `balance` va a zero.
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancel_reason = models.CharField(max_length=255, blank=True, default="", db_default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["salon", "code"], name="uq_giftcard_salon_code"),
        ]

    def __str__(self):
        return f"{self.code} (€{self.balance}/{self.initial_value})"

    @property
    def session_value(self) -> Decimal:
        """Quanto scala dal saldo la prossima seduta.

        Il saldo diviso le sedute rimaste, arrotondato per difetto al centesimo:
        l'ultima seduta prende tutto quello che resta, così il saldo arriva a
        zero esatto. Per le carte monetarie (o a una seduta) è il saldo intero.
        """
        left = self.sessions_left or 0
        if left <= 1:
            return self.balance
        return (Decimal(self.balance) / left).quantize(Decimal("0.01"), rounding=ROUND_DOWN)


class GiftCardAdjustment(models.Model):
    """Modifica manuale del saldo di una carta, con il motivo (vedi adjust_gift_card).

    Il saldo della «carta VIP» non si poteva correggere: un errore di carico o
    un credito concordato con la cliente si sistemava solo con una ricarica,
    che però entra in cassa come incasso (Beauty Boutique, 11/2026). Qui il
    saldo cambia senza denaro, e la riga resta nello storico della carta.
    """

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="+")
    gift_card = models.ForeignKey(GiftCard, on_delete=models.CASCADE, related_name="adjustments")
    # Di quanto è cambiato il saldo: positivo = credito aggiunto, negativo = tolto.
    delta = models.DecimalField(max_digits=10, decimal_places=2)
    balance_after = models.DecimalField(max_digits=10, decimal_places=2)
    note = models.CharField(max_length=255)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]

    def __str__(self):
        return f"{self.gift_card_id} {self.delta:+} → {self.balance_after}"


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
