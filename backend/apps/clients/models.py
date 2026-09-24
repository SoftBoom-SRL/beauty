"""Anagrafica clienti del salone: etichette, cliente, note interne, schede tecniche.

Consumato da: accounts (registrazione/login OTP web app), agenda (FK cliente),
sales (storico vendite/spesa), marketing (fedeltà/coupon/gift card),
automations (facts per le condizioni E/O). FK verso altre app sempre a stringa.
"""

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

# In testa e non dentro `save`: common.phone importa i modelli solo dentro
# `find_client_by_phone`, quindi non c'è ciclo.
from common.phone import phone_key as compute_phone_key


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

    class Gender(models.TextChoices):
        FEMALE = "female", "Donna"
        MALE = "male", "Uomo"
        OTHER = "other", "Altro"

    # Anno segnaposto per i compleanni di cui il cliente dà solo giorno e mese
    # (bisestile, così il 29 febbraio è rappresentabile). Vedi birthday_year_known.
    BIRTHDAY_YEAR_UNKNOWN = 1904

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
    # I trattamenti cambiano spesso in base al genere: vuoto = non specificato.
    gender = models.CharField(max_length=8, choices=Gender.choices, blank=True, default="")
    birthday = models.DateField(null=True, blank=True)
    # False quando il cliente ha dato solo giorno e mese: l'anno in `birthday`
    # è BIRTHDAY_YEAR_UNKNOWN e non va mostrato né usato per l'età.
    birthday_year_known = models.BooleanField(default=True)
    since = models.DateField(null=True, blank=True)
    consents = models.JSONField(default=default_consents, blank=True)
    whatsapp_reminders = models.BooleanField(default=True)
    stripe_customer_id = models.CharField(max_length=120, blank=True)
    stripe_payment_method_id = models.CharField(max_length=120, blank=True)
    # Account Stripe a cui appartengono i due campi qui sopra ("" = account
    # della piattaforma). Un cliente creato prima che il titolare collegasse il
    # proprio account ha un codice che su quell'account non esiste: senza questo
    # campo ogni pagamento dei clienti già in rubrica fallirebbe.
    stripe_account_id = models.CharField(max_length=120, blank=True, default="")
    # Forma confrontabile del telefono (E.164 senza '+', o le sole cifre):
    # `common.phone.phone_key`. Esiste per cercare una cliente dal numero con un
    # indice invece di scorrere tutta l'anagrafica in memoria a ogni richiesta —
    # cosa che accadeva su endpoint pubblici e senza autenticazione.
    phone_key = models.CharField(max_length=32, blank=True, default="", db_index=True)
    deposit_always = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    # Contatto Yourang collegato (sync). Vuoto = non ancora sincronizzato.
    yourang_contact_id = models.CharField(max_length=64, blank=True, default="", db_index=True)

    def save(self, *args, **kwargs):
        update_fields = kwargs.get("update_fields")
        # Un salvataggio che non tocca il telefono non tocca la chiave. Prima
        # la ricalcolava sempre: una scheda con la chiave scritta dal vecchio
        # algoritmo, doppione di un'altra, non si poteva più nemmeno archiviare
        # (DELETE → IntegrityError → 500) né correggere nel nome (18-02). Le
        # chiavi vecchie le riallinea la migrazione clients.0008; qui si
        # ricalcola quando il numero cambia davvero, o col salvataggio pieno.
        if update_fields is None or "phone" in update_fields:
            new_key = compute_phone_key(self.phone)
            if new_key != self.phone_key:
                self.phone_key = new_key
                if update_fields is not None and "phone_key" not in update_fields:
                    kwargs["update_fields"] = list(update_fields) + ["phone_key"]
        super().save(*args, **kwargs)

    class Meta:
        ordering = ["first_name", "last_name", "id"]
        constraints = [
            models.UniqueConstraint(fields=["salon", "phone"], name="uniq_client_salon_phone"),
            # L'identità della cliente è la chiave normalizzata, non la stringa
            # digitata: «348 221 0094» e «+39 348 2210094» sono la stessa
            # persona ma superavano il vincolo qui sopra. Parziale perché
            # phone_key resta vuota sui numeri non normalizzabili («n/d»,
            # «da chiedere»): lì non c'è identità da proteggere e un vincolo
            # pieno impedirebbe la seconda scheda senza numero.
            models.UniqueConstraint(
                fields=["salon", "phone_key"],
                condition=~models.Q(phone_key=""),
                name="uniq_client_salon_phone_key",
            ),
            models.UniqueConstraint(
                fields=["salon", "yourang_contact_id"],
                condition=~models.Q(yourang_contact_id=""),
                name="uniq_client_salon_yourang_contact",
            ),
        ]
        indexes = [models.Index(fields=["salon", "is_active"])]

    def __str__(self):
        return self.full_name or self.phone

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    @property
    def age(self):
        """Età in anni, oppure None se il compleanno manca o è senza anno."""
        if not self.birthday or not self.birthday_year_known:
            return None
        from django.utils import timezone

        today = timezone.localdate()
        years = today.year - self.birthday.year
        if (today.month, today.day) < (self.birthday.month, self.birthday.day):
            years -= 1
        return max(0, years)

    @property
    def birthday_iso(self):
        """Compleanno per l'API: 'YYYY-MM-DD', oppure '--MM-DD' se l'anno non è noto."""
        if not self.birthday:
            return None
        if self.birthday_year_known:
            return self.birthday.isoformat()
        return f"--{self.birthday.month:02d}-{self.birthday.day:02d}"


class ClientNote(models.Model):
    """Nota interna sul cliente (privata dello staff oppure utilizzabile dall'AI)."""

    class Visibility(models.TextChoices):
        PRIVATE = "private"
        AI = "ai"

    client = models.ForeignKey(Client, on_delete=models.CASCADE, related_name="notes")
    # Nota di trattamento: legata alla visita in cui è stata scritta (storico).
    appointment = models.ForeignKey(
        "agenda.Appointment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="client_notes",
    )
    text = models.TextField(blank=True)  # può essere vuota se ci sono allegati
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
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Nota #{self.pk} · cliente {self.client_id}"


def note_attachment_path(instance, filename: str) -> str:
    return f"client_notes/{instance.note.client.salon_id}/{instance.note.client_id}/{filename}"


class ClientNoteAttachment(models.Model):
    """Foto o documento allegato a una nota (prima/dopo trattamento, consenso firmato…)."""

    IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif")
    DOC_TYPES = (
        "application/pdf",
        "text/plain",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    MAX_BYTES = 15 * 1024 * 1024

    note = models.ForeignKey(ClientNote, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(upload_to=note_attachment_path)
    name = models.CharField(max_length=200)
    content_type = models.CharField(max_length=100, blank=True)
    size = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.name

    @property
    def is_image(self) -> bool:
        return self.content_type in self.IMAGE_TYPES


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
