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
    message_preview = models.TextField(blank=True)  # sincronizzata da Yourang, sola lettura via API
    active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.name
