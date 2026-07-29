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
    # Credito Yourang esaurito. NON è uno stato della connessione — si può essere
    # collegati e senza credito — quindi vive in un campo suo. Si scopre solo
    # dall'errore di una chiamata (Yourang non espone un saldo) e si azzera alla
    # prima chiamata che torna a funzionare, cioè dopo la ricarica.
    credit_exhausted = models.BooleanField(default=False)
    credit_exhausted_at = models.DateTimeField(null=True, blank=True)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    last_error = models.TextField(blank=True)
    connected_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Yourang · {self.salon_id} ({self.status})"

    @property
    def feature_state(self) -> str:
        """Stato degli strumenti Yourang per questo salone: active / no_credit /
        not_connected. È il valore che decide quale popup mostrare lato UI."""
        if self.status != self.Status.CONNECTED:
            return "not_connected"
        return "no_credit" if self.credit_exhausted else "active"


class StripeConnection(models.Model):
    """Account Stripe del salone collegato via Connect Standard (una per salone).

    Modello scelto: **Standard + direct charges**. Il salone possiede il suo account
    Stripe, è lui il merchant of record (è il suo nome sull'estratto conto della
    cliente) e gestisce lui le eventuali dispute. La piattaforma non trattiene
    commissioni: nessuna `application_fee_amount`.

    Conseguenza operativa: Customer e PaymentMethod delle clienti vivono
    SULL'ACCOUNT DEL SALONE, non su quello della piattaforma. Ogni chiamata Stripe
    per questo salone va fatta con `stripe_account=stripe_account_id`.
    """

    class Status(models.TextChoices):
        CONNECTED = "connected", "Connesso"
        ERROR = "error", "Errore"
        DISCONNECTED = "disconnected", "Disconnesso"

    salon = models.OneToOneField(
        "core.Salon", on_delete=models.CASCADE, related_name="stripe_connection"
    )
    # acct_… — l'identificativo dell'account collegato: è LA chiave di ogni chiamata.
    stripe_account_id = models.CharField(max_length=64, db_index=True)
    # Con Standard il token d'accesso non serve per operare (si usa la chiave
    # segreta della piattaforma + stripe_account), ma lo conserviamo cifrato per
    # poter revocare la connessione lato Stripe.
    access_token_enc = models.TextField(blank=True)
    livemode = models.BooleanField(default=False)
    # Capacità lette da Stripe: senza charges_enabled l'onboarding non è completo
    # e nessun incasso è possibile, anche se la connessione risulta "connected".
    charges_enabled = models.BooleanField(default=False)
    payouts_enabled = models.BooleanField(default=False)
    details_submitted = models.BooleanField(default=False)
    connected_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+",
    )
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.CONNECTED
    )
    last_error = models.TextField(blank=True)
    connected_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Stripe · {self.salon_id} ({self.stripe_account_id})"

    @property
    def can_charge(self) -> bool:
        """Vero solo se il salone può davvero incassare adesso."""
        return (
            self.status == self.Status.CONNECTED
            and bool(self.stripe_account_id)
            and self.charges_enabled
        )


class StripeOAuthState(models.Model):
    """State di un collegamento Stripe in corso (ponte start → exchange).

    Stripe Connect Standard usa OAuth2 server-side con client_secret: non serve
    PKCE, serve solo che lo `state` sia imprevedibile e a uso singolo.
    """

    state = models.CharField(max_length=64, unique=True)
    salon = models.ForeignKey("core.Salon", on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"StripeOAuthState {self.state[:8]}… · salone {self.salon_id}"


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
