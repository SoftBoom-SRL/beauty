"""Anagrafica clienti del salone: etichette, cliente, note interne, schede tecniche.

Consumato da: accounts (registrazione/login OTP web app), agenda (FK cliente),
sales (storico vendite/spesa), marketing (fedeltà/coupon/gift card),
automations (facts per le condizioni E/O). FK verso altre app sempre a stringa.
"""

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models


def default_consents() -> dict:
    return {"privacy": False, "marketing": False, "card_charge": False}


class ClientCategory(models.Model):
    """Etichetta cliente (es. Local, Expat, VIP...)."""

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="client_categories"
    )
    name = models.CharField(max_length=60)
    color = models.CharField(max_length=7, default="#6366F1")  # #hex
    order = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]
        verbose_name = "etichetta cliente"
        verbose_name_plural = "etichette cliente"
        constraints = [
            models.UniqueConstraint(
                fields=["salon", "name"], name="uniq_clientcategory_salon_name"
            )
        ]

    def __str__(self):
        return self.name


class Client(models.Model):
    """Scheda anagrafica del cliente finale del salone."""

    class Lang(models.TextChoices):
        IT = "it"
        EN = "en"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="clients")
    first_name = models.CharField(max_length=80)
    last_name = models.CharField(max_length=80, blank=True)
    phone = models.CharField(max_length=32)
    email = models.EmailField(blank=True)
    wa = models.BooleanField(default=True)  # il cliente ha/usa WhatsApp
    lang = models.CharField(max_length=2, choices=Lang.choices, default=Lang.IT)
    categories = models.ManyToManyField(ClientCategory, blank=True, related_name="clients")
    reliability = models.IntegerField(
        default=100, validators=[MinValueValidator(0), MaxValueValidator(100)]
    )
    origin = models.CharField(max_length=60, blank=True)  # Instagram, Google...
    birthday = models.DateField(null=True, blank=True)
    since = models.DateField(null=True, blank=True)
    consents = models.JSONField(default=default_consents, blank=True)
    whatsapp_reminders = models.BooleanField(default=True)
    stripe_customer_id = models.CharField(max_length=120, blank=True)
    stripe_payment_method_id = models.CharField(max_length=120, blank=True)
    deposit_always = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["first_name", "last_name", "id"]
        constraints = [
            models.UniqueConstraint(fields=["salon", "phone"], name="uniq_client_salon_phone")
        ]
        indexes = [models.Index(fields=["salon", "is_active"])]

    def __str__(self):
        return self.full_name or self.phone

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()


class ClientNote(models.Model):
    """Nota interna sul cliente (privata dello staff oppure utilizzabile dall'AI)."""

    class Visibility(models.TextChoices):
        PRIVATE = "private"
        AI = "ai"

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="notes")
    text = models.TextField()
    visibility = models.CharField(
        max_length=10, choices=Visibility.choices, default=Visibility.PRIVATE
    )
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Nota #{self.pk} · cliente {self.client_id}"


class TechnicalSheet(models.Model):
    """Scheda tecnica di un trattamento: sola lettura una volta creata.

    Nessun endpoint di update/delete è previsto: è uno storico immutabile.
    """

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="sheets")
    appointment = models.ForeignKey(
        "agenda.Appointment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="technical_sheets",
    )
    category = models.CharField(max_length=40)  # nail, hair, viso, extra...
    treatment = models.CharField(max_length=120)
    zone = models.CharField(max_length=120, blank=True)
    products = models.TextField(blank=True)
    params = models.JSONField(default=dict, blank=True)
    outcome = models.TextField(blank=True)
    duration_hold = models.CharField(max_length=60, blank=True)
    advice = models.TextField(blank=True)
    protocol = models.TextField(blank=True)
    next_step = models.CharField(max_length=120, blank=True)
    photo = models.ImageField(upload_to="technical_sheets/", null=True, blank=True)
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Scheda {self.category} · cliente {self.client_id}"
