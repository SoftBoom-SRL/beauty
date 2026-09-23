from django.conf import settings
from django.db import models


class TimeStampedModel(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Salon(TimeStampedModel):
    class Lang(models.TextChoices):
        IT = "it"
        EN = "en"

    name = models.CharField(max_length=120)
    slug = models.SlugField(unique=True)
    default_lang = models.CharField(max_length=2, choices=Lang.choices, default=Lang.IT)
    currency = models.CharField(max_length=3, default="EUR")
    # Salone creato da `seed_demo`: è l'unico che `seed_demo --reset` può
    # cancellare. Prima il reset cercava il salone per slug e basta, e un salone
    # vero chiamato «The Parlour» (slug `the-parlour`, come quelli nati da
    # «Accedi con Yourang») spariva con tutte le sue clienti.
    is_demo = models.BooleanField(default=False, editable=False)

    def __str__(self):
        return self.name


class Location(TimeStampedModel):
    salon = models.ForeignKey(Salon, on_delete=models.CASCADE, related_name="locations")
    name = models.CharField(max_length=120)
    address = models.CharField(max_length=255, blank=True)
    phone = models.CharField(max_length=40, blank=True)
    is_default = models.BooleanField(default=False)

    def __str__(self):
        return f"{self.salon.name} · {self.name}"


class SalonSettings(TimeStampedModel):
    """Branding white-label + ottimizzazione agenda (Impostazioni)."""

    class AgendaFill(models.TextChoices):
        FREE = "free", "Libero"
        MAX_REVENUE = "max_revenue", "Massimo incasso"

    class SlotRecovery(models.TextChoices):
        NOTIFY = "notify", "Avvisa"
        EXECUTE = "execute", "Esegui"

    class SlotInterval(models.IntegerChoices):
        MIN_15 = 15, "15 minuti"
        MIN_20 = 20, "20 minuti"
        MIN_30 = 30, "30 minuti"

    salon = models.OneToOneField(Salon, on_delete=models.CASCADE, related_name="settings")
    logo = models.ImageField(upload_to="branding/", blank=True, null=True)
    brand_color = models.CharField(max_length=7, default="#6366F1")
    # Testo mostrato nell'app cliente. Se `opening_hours_week` è compilato viene
    # generato da lì (vedi core.services.opening_hours_text).
    opening_hours = models.TextField(blank=True, default="")
    # Orari del centro per giorno: {"0": [["09:00","13:00"],["14:00","19:00"]], …, "6": []}
    # (0 = lunedì; lista vuota = chiuso). Fonte unica per agenda, app cliente e impostazioni.
    opening_hours_week = models.JSONField(default=dict, blank=True)
    # "max_revenue" (default): la disponibilità proposta alle clienti evita i buchi
    # invendibili (slot adiacenti a prenotazioni e bordi turno); "free": tutti gli orari.
    agenda_fill = models.CharField(
        max_length=20, choices=AgendaFill.choices, default=AgendaFill.MAX_REVENUE
    )
    slot_recovery = models.CharField(
        max_length=20, choices=SlotRecovery.choices, default=SlotRecovery.NOTIFY
    )
    # Granularità delle fasce orarie: griglia agenda interna + base disponibilità booking.
    slot_interval_min = models.PositiveSmallIntegerField(
        choices=SlotInterval.choices, default=SlotInterval.MIN_15
    )
    # Informativa privacy del SALONE: il titolare del trattamento dei dati delle
    # clienti è il salone, non la piattaforma. Mostrata nel form pubblico /<slug>/hook.
    privacy_policy_url = models.URLField(blank=True, default="")
    lastminute_discount_cap = models.PositiveSmallIntegerField(default=0)  # 0/10/20/30 %
    lastminute_monthly_budget = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    flexible_enabled = models.BooleanField(default=True)
    flexible_window_min = models.PositiveSmallIntegerField(default=30)
    flexible_reward_pct = models.PositiveSmallIntegerField(default=10)
    # Caparra con scadenza: minuti dalla prenotazione entro cui la caparra va
    # pagata, poi lo slot viene liberato (0 = mai). Il sollecito parte dopo
    # `deposit_reminder_minutes` (0 = nessun sollecito). Scelta del titolare.
    deposit_hold_minutes = models.PositiveSmallIntegerField(default=0)
    deposit_reminder_minutes = models.PositiveSmallIntegerField(default=0)
    # Ritardo di sicurezza prima che un evento dell'agenda parta verso Yourang
    # (0 = subito). In quei secondi l'evento resta trattenuto: se l'appuntamento
    # viene corretto — o l'azione annullata con «torna indietro» — alla cliente
    # arriva un messaggio solo, quello giusto. Vedi core.services.emit_event.
    automation_delay_seconds = models.PositiveSmallIntegerField(default=30)
    # Motivazioni di annullamento / no-show personalizzate dal titolare
    # (lista di stringhe; vuota = quelle predefinite della dashboard).
    cancel_reasons = models.JSONField(default=list, blank=True)
    no_show_reasons = models.JSONField(default=list, blank=True)
    # Stripe Connect: account del salone collegato dal titolare. Le caparre
    # online e gli addebiti no-show passano su questo account.
    stripe_account_id = models.CharField(max_length=64, blank=True, default="")
    stripe_connected_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return f"Impostazioni · {self.salon.name}"


class DepositRule(TimeStampedModel):
    """SE etichetta/affidabilità → richiedi acconto (% o €). Prima regola che matcha vince."""

    class AmountType(models.TextChoices):
        PERCENT = "pct", "%"
        FIXED = "fixed", "€"

    salon = models.ForeignKey(Salon, on_delete=models.CASCADE, related_name="deposit_rules")
    name = models.CharField(max_length=120)
    conditions = models.JSONField(default=dict, blank=True)  # formato common.conditions
    amount_type = models.CharField(max_length=5, choices=AmountType.choices)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    priority = models.PositiveSmallIntegerField(default=0)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["priority", "id"]

    def __str__(self):
        return self.name


class ActivityLog(models.Model):
    """Registro attività: ogni azione rilevante scrive una riga (vedi core.services.log_activity)."""

    salon = models.ForeignKey(Salon, on_delete=models.CASCADE, related_name="activity_logs")
    location = models.ForeignKey(
        Location, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    actor_name = models.CharField(max_length=120, blank=True)
    type = models.CharField(max_length=60)  # es. appointment.created, stock.adjusted
    summary = models.CharField(max_length=255)
    payload = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["salon", "-created_at"])]

    def __str__(self):
        return f"[{self.type}] {self.summary}"


class OutboxEvent(models.Model):
    """Eventi di dominio destinati alla piattaforma Yourang (WhatsApp/automazioni).

    Finché le API Yourang non sono disponibili gli eventi restano accodati qui;
    il comando `flush_outbox` li consegnerà quando l'integrazione sarà attiva.
    """

    class Status(models.TextChoices):
        PENDING = "pending"
        SENDING = "sending"  # preso in carico da un worker
        SENT = "sent"
        FAILED = "failed"
        # Sostituito da un evento successivo sullo stesso oggetto (o annullato
        # con «torna indietro») mentre era ancora trattenuto dal ritardo: non
        # verrà mai consegnato. Resta a database perché quando il titolare
        # chiede «perché non è partito il messaggio?» la risposta si vede qui.
        SUPERSEDED = "superseded"

    salon = models.ForeignKey(Salon, on_delete=models.CASCADE, related_name="outbox_events")
    event_type = models.CharField(max_length=60)  # es. appointment.created, client.otp
    payload = models.JSONField(default=dict, blank=True)
    # Oggetto a cui l'evento si riferisce (es. "appointment:42"): due eventi con
    # la stessa chiave ancora trattenuti si FONDONO invece di partire entrambi.
    coalesce_key = models.CharField(max_length=80, blank=True, default="")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    # Prima di questo istante l'evento non viene ritentato: l'attesa raddoppia a
    # ogni tentativo. Senza, un worker con intervallo di 5 secondi bruciava tutti
    # e otto i tentativi in quaranta secondi di disservizio e marcava come persi
    # messaggi che sarebbero arrivati benissimo un minuto dopo.
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    # Istante in cui un worker ha preso in carico l'evento: serve a recuperare
    # quelli rimasti appesi perché il processo è morto durante l'invio.
    claimed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [
            models.Index(fields=["status", "created_at"]),
            models.Index(fields=["status", "next_attempt_at"]),
            models.Index(fields=["salon", "coalesce_key", "status"]),
        ]

    def __str__(self):
        return f"{self.event_type} ({self.status})"


class RateLimitCounter(models.Model):
    """Contatore delle finestre di rate limit.

    Sta su una tabella propria e non sulla cache: `DatabaseCache.incr()` eredita
    da `BaseCache` la sequenza leggi-poi-scrivi, quindi due richieste simultanee
    leggono lo stesso valore e ne scrivono lo stesso incremento — un limite di 5
    ne lascia passare molti di più, che è esattamente il caso da fermare. La
    stessa scrittura riporta inoltre la scadenza al TIMEOUT predefinito (300
    secondi), perciò una finestra chiesta di un'ora durava cinque minuti.

    Qui l'incremento è una singola UPDATE ... SET count = count + 1, eseguita dal
    database, e la scadenza è un campo nostro che nessuno riscrive per sbaglio.
    """

    key = models.CharField(max_length=200, primary_key=True)
    count = models.PositiveIntegerField(default=0)
    expires_at = models.DateTimeField()

    class Meta:
        indexes = [models.Index(fields=["expires_at"])]

    def __str__(self):
        return f"{self.key} = {self.count}"
