import uuid

from django.db import models


class Automation(models.Model):
    """Regola di automazione: il backend definisce QUANDO/A CHI, Yourang esegue l'invio.

    `conditions` usa il formato condiviso di `common.conditions` (E/O su facts cliente,
    vedi `apps.clients.services.client_facts`). `message_preview` è sincronizzata da
    Yourang (sola lettura lato API: nessun endpoint la modifica).
    """

    class Event(models.TextChoices):
        NEW_CLIENT = "new_client", "Nuovo cliente"
        APPOINTMENT_CREATED = "appointment_created", "Appuntamento creato"
        APPOINTMENT_UPCOMING = "appointment_upcoming", "Appuntamento in arrivo"
        VISIT_COMPLETED = "visit_completed", "Visita completata"
        BIRTHDAY = "birthday", "Compleanno"
        CLIENT_INACTIVE = "client_inactive", "Cliente inattivo"
        NO_SHOW = "no_show", "Mancata presentazione"
        SLOT_FREED = "slot_freed", "Slot liberato"

    class OffsetDirection(models.TextChoices):
        BEFORE = "before", "Prima"
        AFTER = "after", "Dopo"

    class OffsetUnit(models.TextChoices):
        MINUTES = "minutes", "Minuti"
        HOURS = "hours", "Ore"
        DAYS = "days", "Giorni"

    class TriggerOrigin(models.TextChoices):
        YOURANG = "yourang", "Yourang"
        WEBHOOK = "webhook", "Webhook"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="automations")
    name = models.CharField(max_length=120)
    event = models.CharField(max_length=30, choices=Event.choices)
    offset_direction = models.CharField(
        max_length=10, choices=OffsetDirection.choices, default=OffsetDirection.AFTER
    )
    offset_value = models.PositiveIntegerField(default=0)
    offset_unit = models.CharField(max_length=10, choices=OffsetUnit.choices, default=OffsetUnit.HOURS)
    send_time = models.TimeField(null=True, blank=True)  # null = subito
    conditions = models.JSONField(default=dict, blank=True)  # formato common.conditions
    trigger_origin = models.CharField(
        max_length=10, choices=TriggerOrigin.choices, default=TriggerOrigin.YOURANG
    )
    webhook_token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    message_preview = models.TextField(blank=True)  # testo del modello scelto, sola lettura via API
    # Modello WhatsApp (approvato su Yourang) che l'automazione invia, e i campi
    # di youty che ne riempiono i valori, nell'ordine che Yourang chiede
    # (vedi automations.whatsapp.PARAMETER_FIELDS). Vuoto = nessun invio.
    template_name = models.CharField(max_length=512, blank=True)
    template_language = models.CharField(max_length=16, blank=True)
    template_category = models.CharField(max_length=32, blank=True)
    template_parameters = models.JSONField(default=list, blank=True)
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name


class AutomationSend(models.Model):
    """Un invio di un'automazione: uno solo per cliente e occasione.

    `key` dice l'occasione (l'appuntamento, e per i promemoria anche il suo
    orario: un appuntamento spostato riceve il promemoria del nuovo orario).
    Il vincolo di unicità è ciò che impedisce il doppio messaggio quando due
    giri si sovrappongono; un invio fallito si ritenta qualche volta con la
    stessa chiave di idempotenza, quindi Yourang non lo manda due volte.
    """

    class Status(models.TextChoices):
        SENDING = "sending", "In invio"
        SENT = "sent", "Inviato"
        FAILED = "failed", "Fallito"
        SKIPPED = "skipped", "Saltato"

    automation = models.ForeignKey(Automation, on_delete=models.CASCADE, related_name="sends")
    client = models.ForeignKey("clients.Client", on_delete=models.CASCADE, related_name="automation_sends")
    appointment = models.ForeignKey(
        "agenda.Appointment", on_delete=models.SET_NULL, null=True, blank=True,
        related_name="automation_sends",
    )
    key = models.CharField(max_length=120)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.SENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    error = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["automation", "key"], name="automation_send_once"),
        ]

    def __str__(self):
        return f"{self.automation_id}:{self.key} ({self.status})"
