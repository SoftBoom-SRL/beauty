"""Stato della connessione del salone a Yourang (una per salone).

I token NON stanno più qui: dal passaggio al proxy (connect.<brand>) il portale
non possiede alcuna credenziale Yourang. Resta l'org, che è ciò che serve per
instradare i webhook in ingresso e per dire al proxy per quale organizzazione
stiamo chiamando.
"""

from django.conf import settings
from django.db import models


class YourangConnection(models.Model):
    """Connessione OAuth del salone a Yourang. Una sola per salone."""

    class Status(models.TextChoices):
        CONNECTED = "connected", "Connesso"
        ERROR = "error", "Errore"
        DISCONNECTED = "disconnected", "Disconnesso"

    salon = models.OneToOneField(
        "core.Salon", on_delete=models.CASCADE, related_name="yourang_connection"
    )
    # Org Yourang (claim `org` stampato dalla piattaforma): chiave per instradare
    # i webhook e selettore passato al proxy in X-Yourang-Org.
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
