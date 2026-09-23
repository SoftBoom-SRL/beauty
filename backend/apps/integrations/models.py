"""Stato della connessione OAuth verso Yourang (una per salone) + stato PKCE.

La connessione la crea il titolare dalla dashboard ("Collega Yourang"): il flusso
OAuth2 Authorization Code + PKCE salva qui i token (cifrati AES-256-GCM) e il segreto
del webhook. Da qui i servizi di sync leggono il token valido per chiamare le API
esterne di Yourang.
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
    # Token OAuth cifrati (AES-256-GCM, chiave = settings.ENCRYPTION_KEY).
    access_token_enc = models.TextField(blank=True)
    refresh_token_enc = models.TextField(blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    scope = models.CharField(max_length=255, blank=True)
    # Org Yourang (claim `org` dell'access token): chiave per instradare i webhook.
    yourang_org_id = models.CharField(max_length=64, blank=True, db_index=True)
    # Catalogo Yourang in cui spingiamo servizi/pacchetti (uno per salone).
    catalogue_id = models.CharField(max_length=64, blank=True)
    # Segreto di firma del webhook restituito da Yourang alla registrazione (cifrato).
    webhook_secret_enc = models.TextField(blank=True)
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

    def __str__(self):
        return f"Yourang · {self.salon_id} ({self.status})"


class YourangOAuthState(models.Model):
    """State + PKCE verifier di un tentativo di connessione/login in corso.

    Ponte fra lo start (crea) e `oauth/exchange` (consuma e cancella).
    Il verifier PKCE deve restare lato server fra i due passi.

    - Flusso "connect" (dalle impostazioni, utente già loggato): salon+user valorizzati.
    - Flusso "login con Yourang" (dalla pagina di login): salon/user null, il salone
      viene risolto/provisionato dall'identità Yourang allo scambio.
    """

    state = models.CharField(max_length=64, unique=True)
    code_verifier = models.CharField(max_length=128)
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
