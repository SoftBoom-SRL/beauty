"""Collegamento del salone a Yourang (uno per salone) + state del popup.

La connessione la crea il titolare dalla dashboard ("Collega Yourang") o il primo
accesso con Yourang. Token, scope e segreti dei webhook li custodisce il proxy
connect.yourang.ai (YR-502): qui restano l'org, il catalogo e lo stato della sync.
"""

from django.conf import settings
from django.db import models


class YourangConnection(models.Model):
    """Collegamento del salone a un'org Yourang. Uno solo per salone."""

    class Status(models.TextChoices):
        CONNECTED = "connected", "Connesso"
        ERROR = "error", "Errore"
        DISCONNECTED = "disconnected", "Disconnesso"

    salon = models.OneToOneField(
        "core.Salon", on_delete=models.CASCADE, related_name="yourang_connection"
    )
    # Org Yourang (`org_id` dell'identità del proxy): chiave per instradare i webhook.
    yourang_org_id = models.CharField(max_length=64, blank=True, db_index=True)
    # Catalogo Yourang in cui spingiamo servizi/pacchetti (uno per salone).
    catalogue_id = models.CharField(max_length=64, blank=True)
    connected_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.CONNECTED
    )
    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True)
    connected_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            # Un'organizzazione Yourang appartiene a UN solo salone: il webhook
            # risolve il salone dall'org, quindi due righe con la stessa org
            # consegnano le prenotazioni al salone sbagliato. Parziale perché ""
            # significa "non ancora collegata" e vale per molte righe.
            models.UniqueConstraint(
                fields=["yourang_org_id"],
                condition=~models.Q(yourang_org_id=""),
                name="uniq_yourang_connection_org",
            ),
        ]

    def __str__(self):
        return f"Yourang · {self.salon_id} ({self.status})"


class YourangOAuthState(models.Model):
    """State di un tentativo di connessione/login in corso.

    Ponte fra lo start (crea) e `oauth/exchange` (consuma e cancella). Viaggia
    nel `return_to` del proxy e lega il ritorno del popup a chi l'ha aperto.

    - Flusso "connect" (dalle impostazioni, utente già loggato): salon+user valorizzati.
    - Flusso "login con Yourang" (dalla pagina di login): salon/user null, il salone
      viene risolto/provisionato dall'identità Yourang allo scambio.
    """

    state = models.CharField(max_length=64, unique=True)
    salon = models.ForeignKey(
        "core.Salon", on_delete=models.CASCADE, related_name="+", null=True, blank=True
    )
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+",
        null=True, blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"OAuthState {self.state[:8]}… · salone {self.salon_id or '—'}"


class YourangEventSync(models.Model):
    """Ultimi valori ricevuti da Yourang per un evento importato.

    Yourang rimanda l'evento intero a ogni `event.*`, anche quando è cambiato
    solo lo stato (un'approvazione): riscrivere ogni volta orario e cliente
    annullava lo spostamento fatto in salone, e la prenotazione tornava alle 10
    sopra la cliente messa lì nel frattempo (11-07). Confrontando con l'ultimo
    remoto visto si applica solo ciò che è cambiato DAVVERO su Yourang. Sta qui
    e non sull'appuntamento: è stato dell'integrazione, non dell'agenda.
    """

    appointment = models.OneToOneField(
        "agenda.Appointment", on_delete=models.CASCADE, related_name="+"
    )
    remote_start = models.DateTimeField(null=True, blank=True)
    # Telefono normalizzato e nome come arrivano nell'evento: la cliente.
    remote_client = models.CharField(max_length=255, blank=True)
    remote_duration_min = models.PositiveIntegerField(null=True, blank=True)
    remote_status = models.CharField(max_length=32, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Evento Yourang · appuntamento {self.appointment_id}"
