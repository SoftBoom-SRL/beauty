"""Agenda: appuntamenti multi-servizio, pause operatrici, lista d'attesa.

Un appuntamento è una sequenza di servizi (AppointmentService) che si
concatenano a partire da `start`; ogni servizio ha la propria operatrice
e uno snapshot di durata/prezzo preso dal listino al momento della creazione.
"""

import datetime as dt

from django.conf import settings
from django.db import models

from apps.core.models import TimeStampedModel


class Appointment(TimeStampedModel):
    class Status(models.TextChoices):
        CONFIRMED = "confirmed", "Confermato"
        CHECKED_IN = "checked_in", "Check-in"
        IN_PROGRESS = "in_progress", "In corso"
        CLOSED = "closed", "Chiuso"
        NO_SHOW = "no_show", "No-show"
        CANCELLED = "cancelled", "Annullato"

    class DepositStatus(models.TextChoices):
        NONE = "none", "Nessuno"
        REQUIRED = "required", "Richiesto"
        PAID = "paid", "Pagato"
        # Annullamento in tempo: la caparra va restituita ma il rimborso non è
        # (ancora) avvenuto — Stripe non configurato, caparra incassata in
        # salone o rimborso fallito. «Rimborsato» si scrive solo a rimborso fatto.
        REFUND_DUE = "refund_due", "Da rimborsare"
        # Rimborso partito ma non ancora riuscito: Stripe conferma i rimborsi in
        # un secondo momento e può anche fallirli. «Rimborsato» si scrive solo a
        # esito riuscito, altrimenti il gestionale dichiara restituito denaro
        # che è ancora sul conto del salone.
        REFUNDING = "refunding", "Rimborso in corso"
        REFUNDED = "refunded", "Rimborsato"
        FORFEITED = "forfeited", "Trattenuto"

    class CreatedVia(models.TextChoices):
        DASHBOARD = "dashboard", "Dashboard"
        APP = "app", "App cliente"
        YOURANG = "yourang", "Yourang"

    # Stati che NON occupano lo slot in agenda.
    INACTIVE_STATUSES = (Status.CANCELLED, Status.NO_SHOW)

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="appointments"
    )
    location = models.ForeignKey(
        "core.Location",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="appointments",
    )
    # PROTECT e non CASCADE: le API cancellano le clienti in modo morbido, ma
    # dall'admin la cancellazione è reale e si portava dietro tutto lo storico
    # delle visite (e i loro AppointmentService). Le vendite invece restavano,
    # con client NULL: i ricavi non tornavano più a nessuna visita.
    client = models.ForeignKey(
        "clients.Client", on_delete=models.PROTECT, related_name="appointments"
    )
    operator = models.ForeignKey(  # operatrice principale (quella del primo servizio)
        "staff.Operator", on_delete=models.PROTECT, related_name="appointments"
    )
    start = models.DateTimeField()
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.CONFIRMED
    )
    deposit_status = models.CharField(
        max_length=10, choices=DepositStatus.choices, default=DepositStatus.NONE
    )
    deposit_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    note = models.TextField(blank=True)
    flexible = models.BooleanField(default=False)
    created_via = models.CharField(
        max_length=10, choices=CreatedVia.choices, default=CreatedVia.DASHBOARD
    )
    cancel_reason = models.CharField(max_length=255, blank=True)
    cancelled_late = models.BooleanField(default=False)
    # Evento Yourang collegato (prenotazione importata via webhook/sync).
    yourang_event_id = models.CharField(max_length=64, blank=True, default="", db_index=True)
    # PaymentIntent Stripe della caparra pagata online (serve per il rimborso) e
    # dell'addebito no-show (un solo addebito per appuntamento).
    deposit_payment_intent_id = models.CharField(max_length=64, blank=True, default="")
    no_show_payment_intent_id = models.CharField(max_length=64, blank=True, default="")
    # Rimborsi della caparra, uno per id Stripe: {"re_...": {"amount_cents": int,
    # "status": "pending|succeeded|failed|canceled"}}. Tenerli per id rende
    # l'elaborazione idempotente (lo stesso evento può arrivare più volte) e
    # permette di riconciliare gli aggiornamenti di stato, che arrivano dopo.
    deposit_refunds = models.JSONField(default=dict, blank=True)
    # Somma dei rimborsi RIUSCITI, in euro. Un rimborso parziale non annulla la
    # caparra: la quota ancora trattenuta resta detraibile al checkout.
    deposit_refunded_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    # Caparra con scadenza (SalonSettings.deposit_hold_minutes): entro quando va
    # pagata, quando è partito il sollecito, il link di pagamento inviato.
    deposit_due_at = models.DateTimeField(null=True, blank=True)
    deposit_reminder_sent_at = models.DateTimeField(null=True, blank=True)
    deposit_payment_link = models.URLField(max_length=500, blank=True, default="")
    # Sessione Checkout dietro al link. Serve a chiuderla quando se ne crea una
    # nuova: due link aperti sulla stessa caparra significano due pagamenti
    # possibili, e il secondo arrivava senza che nessuno lo riconciliasse.
    deposit_checkout_session_id = models.CharField(max_length=80, blank=True, default="")
    # Account Stripe su cui vive la caparra: quello della sessione del link e,
    # a pagamento arrivato, quello dell'evento ("" = piattaforma). Rimborsi e
    # chiusure dei link vanno lì: collegando o scollegando Stripe dopo il
    # pagamento andavano sull'account nuovo, dove il PaymentIntent non esiste,
    # e fallivano. None = caparra di prima di questo campo: si usa l'account
    # attuale del salone.
    deposit_stripe_account = models.CharField(max_length=64, null=True, blank=True, default=None)
    # Quando Stripe chiude la sessione del link (al più 24 ore, anche senza
    # scadenza della caparra). Passata quella, il link si rifà invece di
    # rimandare alla cliente una pagina già chiusa.
    deposit_link_expires_at = models.DateTimeField(null=True, blank=True)
    # Fine del termine di pagamento fissata alla prenotazione, SENZA il taglio
    # sull'inizio della visita che c'è in `deposit_due_at`: se la visita viene
    # spostata, la scadenza vera si ricalcola da qui e dal nuovo inizio.
    deposit_hold_until = models.DateTimeField(null=True, blank=True)
    # Slot liberato automaticamente per caparra non pagata: resta la traccia
    # (l'operatrice richiama la cliente e decide) e si può ripristinare.
    auto_released = models.BooleanField(default=False)
    # Inserito dallo staff forzando le regole (fuori orario, sovrapposizione).
    forced = models.BooleanField(default=False)

    class Meta:
        ordering = ["start"]
        indexes = [
            models.Index(fields=["salon", "start"]),
            models.Index(fields=["operator", "start"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["salon", "yourang_event_id"],
                condition=~models.Q(yourang_event_id=""),
                name="uniq_appointment_salon_yourang_event",
            ),
        ]

    def __str__(self):
        return f"Appuntamento #{self.pk} · {self.start:%Y-%m-%d %H:%M}"

    @property
    def total_duration_min(self) -> int:
        # durata totale lato cliente = lavoro attivo + posa di ogni servizio
        return sum(item.duration_min + item.soak_min for item in self.items.all())

    @property
    def end(self) -> dt.datetime:
        return self.start + dt.timedelta(minutes=self.total_duration_min)

    @property
    def total_price(self):
        return sum((item.price for item in self.items.all()), start=0)

    @property
    def deposit_credit(self):
        """Quota di caparra ancora in cassa, quindi detraibile al checkout.

        È `deposit_amount` meno i rimborsi già riusciti E quelli ancora in
        corso (`sales.services.deposit_retained`). Prima si detraeva sempre
        l'intero importo: dopo un rimborso parziale di dieci euro su trenta, la
        cliente si vedeva scontare trenta euro che il salone non aveva più. E
        con un rimborso parziale ancora «pending» la caparra risultava «rimborso
        in corso» e la quota detraibile era zero: la cassa faceva pagare tutto e
        la parte ancora trattenuta tornava sulla carta solo dopo (02-21).
        """
        from apps.sales.services import deposit_retained  # lazy: sales dipende da agenda

        return deposit_retained(self)


class AppointmentService(models.Model):
    """Un servizio dentro l'appuntamento: snapshot di durata/prezzo dal listino."""

    appointment = models.ForeignKey(
        Appointment, on_delete=models.CASCADE, related_name="items"
    )
    service = models.ForeignKey(
        "catalog.Service", on_delete=models.PROTECT, related_name="appointment_items"
    )
    operator = models.ForeignKey(  # chi esegue QUESTO servizio
        "staff.Operator", on_delete=models.PROTECT, related_name="appointment_items"
    )
    # snapshot dal listino: lavoro ATTIVO (operatrice impegnata)
    duration_min = models.PositiveIntegerField()
    # snapshot dal listino: POSA/attesa dopo l'attivo (operatrice libera)
    soak_min = models.PositiveIntegerField(default=0)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    order = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ["order", "id"]

    def __str__(self):
        return f"{self.service} ({self.duration_min}')"


class Pause(TimeStampedModel):
    """Blocco manuale in agenda (pausa/indisponibilità dell'operatrice)."""

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="pauses"
    )
    operator = models.ForeignKey(
        "staff.Operator", on_delete=models.CASCADE, related_name="pauses"
    )
    start = models.DateTimeField()
    duration_min = models.PositiveIntegerField()
    note = models.CharField(max_length=255, blank=True)

    class Meta:
        ordering = ["start"]

    def __str__(self):
        return f"Pausa {self.start:%Y-%m-%d %H:%M} ({self.duration_min}')"

    @property
    def end(self) -> dt.datetime:
        return self.start + dt.timedelta(minutes=self.duration_min)


class UndoEntry(models.Model):
    """Un gesto dell'agenda che si può ancora annullare («torna indietro»).

    In agenda si lavora a mano libera: si trascina, si stacca, si annulla, e
    ogni tanto un gesto parte per sbaglio. Ogni mutazione scrive qui lo stato di
    PRIMA (`before`), quello che ha prodotto (`after`) e ciò che ha creato
    (`created`); `POST /api/agenda/undo` rimette le cose com'erano.

    `after` non serve a ripristinare ma a difendersi: se nel frattempo qualcuno
    ha toccato lo stesso appuntamento, lo stato attuale non combacia più e
    l'annullamento viene rifiutato invece di cancellare il lavoro di una collega.

    Lo storico è PER PERSONA (`actor`) e dura pochi minuti: «torna indietro»
    annulla l'ultima cosa fatta da chi preme il tasto, non quella della
    postazione accanto. Le azioni senza operatore (app cliente, automatismi)
    non ci finiscono.
    """

    class Kind(models.TextChoices):
        CREATE = "create", "Creazione"
        MOVE = "move", "Spostamento"
        EDIT = "edit", "Modifica"
        SPLIT = "split", "Stacco"
        CANCEL = "cancel", "Annullamento"
        NO_SHOW = "no_show", "No-show"
        STATUS = "status", "Cambio stato"
        PAUSE_CREATE = "pause_create", "Pausa aggiunta"
        PAUSE_UPDATE = "pause_update", "Pausa spostata"
        PAUSE_DELETE = "pause_delete", "Pausa rimossa"

    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="undo_entries")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+"
    )
    kind = models.CharField(max_length=20, choices=Kind.choices)
    # Frase già pronta per l'avviso: «Spostamento di Sofia Ricci».
    label = models.CharField(max_length=160)
    before = models.JSONField(default=dict, blank=True)
    after = models.JSONField(default=dict, blank=True)
    created = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    undone_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["salon", "actor", "-created_at"])]
        verbose_name_plural = "Undo entries"

    def __str__(self):
        return f"{self.get_kind_display()} · {self.label}"


class WaitlistEntry(models.Model):
    """Lista d'attesa: cliente interessato a un servizio quando si libera uno slot."""

    class Preference(models.TextChoices):
        MORNING = "morning", "Mattina"
        AFTERNOON = "afternoon", "Pomeriggio"
        WEEKEND = "weekend", "Weekend"
        ANY = "any", "Qualsiasi"
        EXACT = "exact", "Giorni/orario precisi"

    class Status(models.TextChoices):
        ACTIVE = "active", "Attiva"
        CONTACTED = "contacted", "Contattata"
        BOOKED = "booked", "Prenotata"
        EXPIRED = "expired", "Scaduta"

    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="waitlist_entries"
    )
    client = models.ForeignKey(
        "clients.Client", on_delete=models.CASCADE, related_name="waitlist_entries"
    )
    service = models.ForeignKey(
        "catalog.Service", on_delete=models.CASCADE, related_name="waitlist_entries"
    )
    operator = models.ForeignKey(  # null = qualsiasi operatrice
        "staff.Operator",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="waitlist_entries",
    )
    preference = models.CharField(
        max_length=10, choices=Preference.choices, default=Preference.ANY
    )
    exact_days = models.JSONField(default=list, blank=True)  # [0=lun … 6=dom]
    exact_time = models.TimeField(null=True, blank=True)
    status = models.CharField(
        max_length=10, choices=Status.choices, default=Status.ACTIVE
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        verbose_name_plural = "Waitlist entries"

    def __str__(self):
        return f"Waitlist #{self.pk} · {self.status}"
