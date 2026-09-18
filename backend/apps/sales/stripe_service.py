"""Integrazione Stripe: carte salvate, acconti, addebito no-show, rimborso caparra.

Stripe è opzionale: senza STRIPE_SECRET_KEY ogni funzione risponde
HttpError(503, "Stripe non configurato"). Gli importi sono in centesimi.
"""

import logging
from decimal import Decimal
from urllib.parse import urlencode

from django.conf import settings
from django.core import signing
from django.utils import timezone
from ninja.errors import HttpError

logger = logging.getLogger("youty.stripe")

CONNECT_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize"
_CONNECT_SALT = "youty.stripe-connect"
CONNECT_STATE_MAX_AGE = 15 * 60


def _client():
    """Modulo stripe configurato, o 503 se la chiave segreta non è impostata."""
    if not settings.STRIPE_SECRET_KEY:
        raise HttpError(503, "Stripe non configurato")
    import stripe  # lazy: dipendenza opzionale a runtime

    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


# ---- Account del salone (Stripe Connect) -------------------------------------


def salon_account_id(salon) -> str:
    """Account Stripe collegato dal titolare ("" = si usa l'account della piattaforma)."""
    salon_settings = getattr(salon, "settings", None)
    return getattr(salon_settings, "stripe_account_id", "") or ""


def _account_opts(salon) -> dict:
    """kwargs per le chiamate Stripe: instradano sull'account del salone se collegato."""
    account = salon_account_id(salon)
    return {"stripe_account": account} if account else {}


_INTENT_ACCOUNT_SALT = "youty.stripe-intent-account"


def account_token(salon) -> str:
    """Firma l'account su cui stiamo creando il pagamento, per i metadata.

    Torna indietro dentro l'evento e permette di riconoscere un pagamento nato
    su un account che nel frattempo è cambiato: prima il webhook confrontava con
    l'account ATTUALE del salone, così bastava collegare (o scollegare) Stripe
    perché i pagamenti dei link già in volo venissero scartati — soldi incassati
    e nessuno che li riconciliasse.

    È firmato perché i metadata di un evento Connect li scrive chi genera
    l'evento: senza firma un salone collegato potrebbe dichiarare l'account che
    preferisce e farsi accettare il pagamento di un appuntamento altrui.
    """
    return signing.dumps({"s": salon.id, "a": salon_account_id(salon)}, salt=_INTENT_ACCOUNT_SALT)


def account_token_matches(salon, token: str, account: str) -> bool:
    """Vero se `token` è nostro, è di questo salone e dichiara proprio `account`."""
    if not token:
        return False
    try:
        data = signing.loads(token, salt=_INTENT_ACCOUNT_SALT)
    except signing.BadSignature:
        return False
    return data.get("s") == salon.id and (data.get("a") or "") == (account or "")


def payments_enabled(salon) -> bool:
    """Vero se si possono creare pagamenti online per il salone."""
    return bool(settings.STRIPE_SECRET_KEY)


def connect_available() -> bool:
    return bool(settings.STRIPE_SECRET_KEY and settings.STRIPE_CONNECT_CLIENT_ID)


def connect_authorize_url(salon, redirect_uri: str) -> str:
    """URL OAuth (Stripe Connect Standard) a cui mandare il titolare per collegare il suo account."""
    if not connect_available():
        raise HttpError(503, "Stripe Connect non configurato sulla piattaforma (STRIPE_CONNECT_CLIENT_ID)")
    state = signing.dumps({"salon": salon.id}, salt=_CONNECT_SALT)
    params = {
        "response_type": "code",
        "client_id": settings.STRIPE_CONNECT_CLIENT_ID,
        "scope": "read_write",
        "state": state,
        "redirect_uri": redirect_uri,
    }
    return f"{CONNECT_AUTHORIZE_URL}?{urlencode(params)}"


def connect_exchange(salon, code: str, state: str) -> str:
    """Scambia il code OAuth con l'account collegato e lo salva sulle impostazioni del salone."""
    try:
        data = signing.loads(state, salt=_CONNECT_SALT, max_age=CONNECT_STATE_MAX_AGE)
    except signing.BadSignature:
        raise HttpError(400, "Richiesta di collegamento non valida o scaduta: riprova")
    if data.get("salon") != salon.id:
        raise HttpError(400, "Richiesta di collegamento non valida per questo salone")
    stripe = _client()
    try:
        response = stripe.OAuth.token(grant_type="authorization_code", code=code)
    except stripe.StripeError as exc:
        raise HttpError(400, f"Collegamento Stripe non riuscito: {getattr(exc, 'user_message', None) or exc}")
    account_id = response.get("stripe_user_id") or ""
    if not account_id:
        raise HttpError(400, "Stripe non ha restituito l'account collegato")
    from apps.core.models import SalonSettings  # lazy

    salon_settings, _ = SalonSettings.objects.get_or_create(salon=salon)
    salon_settings.stripe_account_id = account_id
    salon_settings.stripe_connected_at = timezone.now()
    salon_settings.save(update_fields=["stripe_account_id", "stripe_connected_at", "updated_at"])
    return account_id


def connect_disconnect(salon) -> None:
    """Scollega l'account Stripe del salone (revoca lato Stripe se possibile)."""
    from apps.core.models import SalonSettings  # lazy

    salon_settings, _ = SalonSettings.objects.get_or_create(salon=salon)
    account_id = salon_settings.stripe_account_id
    if account_id and connect_available():
        stripe = _client()
        try:
            stripe.OAuth.deauthorize(client_id=settings.STRIPE_CONNECT_CLIENT_ID, stripe_user_id=account_id)
        except stripe.StripeError as exc:  # già revocato lato Stripe: non blocca
            logger.warning("Deauthorize Stripe non riuscita per %s: %s", account_id, exc)
    salon_settings.stripe_account_id = ""
    salon_settings.stripe_connected_at = None
    salon_settings.save(update_fields=["stripe_account_id", "stripe_connected_at", "updated_at"])


def _to_cents(amount) -> int:
    return int((Decimal(str(amount)) * 100).quantize(Decimal("1")))


def _currency(salon) -> str:
    return (getattr(salon, "currency", "") or "EUR").lower()


def ensure_customer(client) -> str:
    """Ritorna lo stripe_customer_id del cliente sull'account in uso.

    I codici cliente di Stripe vivono dentro un singolo account: quello creato
    sull'account della piattaforma non esiste su quello del titolare. Quando il
    salone collega (o scollega) il proprio account bisogna quindi ricrearlo, e
    buttare via la carta salvata, che apparteneva al vecchio codice. Senza
    questo controllo, il giorno del collegamento tutti i pagamenti dei clienti
    già in rubrica smettono di funzionare.
    """
    stripe = _client()
    account = salon_account_id(client.salon)
    if client.stripe_customer_id and client.stripe_account_id == account:
        return client.stripe_customer_id

    customer = stripe.Customer.create(
        name=f"{client.first_name} {client.last_name}".strip(),
        phone=client.phone or None,
        email=client.email or None,
        metadata={"client_id": client.id, "salon_id": client.salon_id},
        **_account_opts(client.salon),
    )
    if client.stripe_customer_id:
        logger.info(
            "Cliente %s ricreato su un altro account Stripe (%s → %s): carta salvata rimossa",
            client.id, client.stripe_account_id or "piattaforma", account or "piattaforma",
        )
    client.stripe_customer_id = customer["id"]
    client.stripe_account_id = account
    client.stripe_payment_method_id = ""
    client.save(
        update_fields=["stripe_customer_id", "stripe_account_id", "stripe_payment_method_id"]
    )
    return client.stripe_customer_id


def create_setup_intent(client):
    """SetupIntent off-session per salvare la carta del cliente dalla web app."""
    stripe = _client()
    customer_id = ensure_customer(client)
    return stripe.SetupIntent.create(
        customer=customer_id,
        usage="off_session",
        metadata={"client_id": client.id},
        **_account_opts(client.salon),
    )


def create_deposit_intent(appointment):
    """PaymentIntent per l'acconto di un appuntamento (metadata.appointment_id, kind=deposit)."""
    stripe = _client()
    amount = Decimal(str(appointment.deposit_amount or 0))
    if amount <= 0:
        raise HttpError(400, "Nessun acconto richiesto per questo appuntamento")
    customer_id = ensure_customer(appointment.client)
    return stripe.PaymentIntent.create(
        amount=_to_cents(amount),
        currency=_currency(appointment.salon),
        customer=customer_id,
        metadata={
            "appointment_id": appointment.id,
            "kind": "deposit",
            "salon_id": appointment.salon_id,
            "acct": account_token(appointment.salon),
        },
        idempotency_key=f"deposit-{appointment.salon_id}-{appointment.id}",
        **_account_opts(appointment.salon),
    )


def _deposit_return_urls(appointment) -> tuple[str, str]:
    base = (settings.CLIENT_APP_ORIGIN or settings.FRONTEND_ORIGIN).rstrip("/")
    slug = appointment.salon.slug
    return (
        f"{base}/{slug}?deposit=paid&appointment={appointment.id}",
        f"{base}/{slug}?deposit=cancelled&appointment={appointment.id}",
    )


def create_deposit_checkout(appointment) -> str:
    """Checkout Session Stripe per la caparra: ritorna l'URL da mandare alla cliente.

    Il PaymentIntent generato porta gli stessi metadata (appointment_id, kind=deposit),
    così `payment_intent.succeeded` marca la caparra come pagata. Se il salone ha
    una scadenza caparra la sessione scade con lei (Stripe ammette 30 min–24 h).
    """
    stripe = _client()
    amount = Decimal(str(appointment.deposit_amount or 0))
    if amount <= 0:
        raise HttpError(400, "Nessuna caparra richiesta per questo appuntamento")
    client = appointment.client
    metadata = {
        "appointment_id": str(appointment.id),
        "kind": "deposit",
        "salon_id": str(appointment.salon_id),
        # Account di OGGI, firmato: se il titolare collega o scollega Stripe
        # prima che la cliente paghi, l'evento arriva comunque riconoscibile.
        "acct": account_token(appointment.salon),
    }
    success_url, cancel_url = _deposit_return_urls(appointment)
    when = timezone.localtime(appointment.start).strftime("%d/%m %H:%M")
    params = {
        "mode": "payment",
        "line_items": [
            {
                "quantity": 1,
                "price_data": {
                    "currency": _currency(appointment.salon),
                    "unit_amount": _to_cents(amount),
                    "product_data": {"name": f"Caparra appuntamento {when} · {appointment.salon.name}"},
                },
            }
        ],
        "metadata": metadata,
        "payment_intent_data": {"metadata": metadata},
        "success_url": success_url,
        "cancel_url": cancel_url,
    }
    if client.email:
        params["customer_email"] = client.email
    due = appointment.deposit_due_at
    if due is not None:
        seconds = (due - timezone.now()).total_seconds()
        if 30 * 60 + 60 <= seconds <= 24 * 3600 - 60:
            params["expires_at"] = int(due.timestamp())
    try:
        session = stripe.checkout.Session.create(
            **params,
            idempotency_key=f"deposit-checkout-{appointment.salon_id}-{appointment.id}-{int(appointment.updated_at.timestamp())}",
            **_account_opts(appointment.salon),
        )
    except stripe.StripeError as exc:
        raise HttpError(400, f"Link di pagamento non creato: {getattr(exc, 'user_message', None) or exc}")
    return session["url"], session.get("id") or ""


def expire_deposit_checkout(appointment) -> None:
    """Chiude la Checkout Session precedente della caparra, se ce n'è una.

    Senza questo passaggio il sollecito lasciava aperto anche il link vecchio:
    se la cliente pagava tutti e due, il salone incassava due caparre e il
    gestionale ne registrava una sola.
    """
    session_id = appointment.deposit_checkout_session_id
    if not session_id or not payments_enabled(appointment.salon):
        return
    stripe = _client()
    try:
        stripe.checkout.Session.expire(session_id, **_account_opts(appointment.salon))
    except stripe.StripeError as exc:
        # Già scaduta, già pagata o sconosciuta: non è un motivo per non
        # mandare il nuovo link.
        logger.info("Sessione caparra %s non chiusa: %s", session_id, exc)


def ensure_deposit_link(appointment, *, resend: bool = False, actor=None) -> str:
    """Link di pagamento della caparra: lo crea se manca (e i pagamenti sono attivi),
    lo accoda alla cliente (`deposit.payment_link`, WhatsApp via Yourang) e lo salva
    sull'appuntamento. Ritorna "" se i pagamenti online non sono configurati."""
    from apps.core.services import emit_event, log_activity  # lazy

    if appointment.deposit_status != "required" or Decimal(str(appointment.deposit_amount or 0)) <= 0:
        return ""
    if not payments_enabled(appointment.salon):
        return ""
    created = False
    # Al sollecito il link viene sempre rifatto: la sessione di pagamento porta
    # la stessa scadenza della caparra, quindi rispedire quello vecchio significa
    # mandare alla cliente una pagina che Stripe ha già chiuso.
    if resend or not appointment.deposit_payment_link:
        expire_deposit_checkout(appointment)
        url, session_id = create_deposit_checkout(appointment)
        appointment.deposit_payment_link = url
        appointment.deposit_checkout_session_id = session_id
        appointment.save(
            update_fields=[
                "deposit_payment_link",
                "deposit_checkout_session_id",
                "updated_at",
            ]
        )
        created = not resend
    if created or resend:
        payload = {
            "appointment_id": appointment.id,
            "client_id": appointment.client_id,
            "client_name": appointment.client.full_name,
            "phone": appointment.client.phone,
            "lang": appointment.client.lang,
            "amount": str(appointment.deposit_amount),
            "url": appointment.deposit_payment_link,
            "due_at": appointment.deposit_due_at.isoformat() if appointment.deposit_due_at else None,
            "start": appointment.start.isoformat(),
            "resend": resend,
        }
        emit_event(appointment.salon, "deposit.payment_link", payload)
        log_activity(
            appointment.salon,
            "deposit.link_sent",
            ("Sollecito caparra" if resend else "Link caparra inviato") + f" — {appointment.client.full_name}",
            actor=actor,
            payload={"appointment_id": appointment.id, "amount": str(appointment.deposit_amount)},
        )
    return appointment.deposit_payment_link


def no_show_charge_amount(appointment) -> Decimal:
    """Quanto si addebita davvero per il no-show.

    Il totale della visita meno la caparra già trattenuta: quella è denaro
    incassato, addebitarla di nuovo farebbe pagare 130 un servizio da 100.
    """
    amount = Decimal(str(appointment.total_price or 0))
    if appointment.deposit_status == "forfeited":
        # Al NETTO di quanto è già tornato alla cliente: con 10 € rimborsati su
        # 30, in cassa ne restano 20 ed è solo quella parte a scalare
        # l'addebito. Sottraendo l'intera caparra il salone perdeva i 10.
        kept = Decimal(str(appointment.deposit_amount or 0)) - Decimal(
            str(appointment.deposit_refunded_amount or 0)
        )
        amount -= max(kept, Decimal("0.00"))
    return max(amount, Decimal("0.00")).quantize(Decimal("0.01"))


def charge_full_amount(appointment):
    """Addebito off-session (no-show) sulla carta salvata. Ritorna (intent, importo).

    L'importo torna insieme al PaymentIntent perché è quello davvero chiesto a
    Stripe: ricalcolarlo dal chiamante faceva scrivere nel registro attività
    l'intero prezzo della visita mentre alla carta ne erano stati chiesti meno.

    Un solo addebito per appuntamento: l'id del PaymentIntent viene salvato
    sull'appuntamento e la chiamata a Stripe porta una idempotency key, così
    né un doppio clic né una richiesta ripetuta producono due addebiti.
    """
    stripe = _client()
    if getattr(appointment, "status", "") != "no_show":
        raise HttpError(400, "L'addebito è previsto solo per gli appuntamenti segnati come no-show")
    if appointment.no_show_payment_intent_id:
        raise HttpError(409, "No-show già addebitato per questo appuntamento")
    client = appointment.client
    if not (client.consents or {}).get("card_charge"):
        raise HttpError(400, "Il cliente non ha autorizzato l'addebito sulla carta")
    # ensure_customer PRIMA del controllo sulla carta: se il salone ha collegato
    # il proprio account Stripe dopo il salvataggio, la carta appartiene a un
    # account diverso e viene azzerata qui. Controllarla prima farebbe partire
    # un addebito con un metodo di pagamento che su questo account non esiste.
    customer_id = ensure_customer(client)
    if not client.stripe_payment_method_id:
        raise HttpError(400, "Nessuna carta salvata per il cliente")
    amount = no_show_charge_amount(appointment)
    if amount <= 0:
        raise HttpError(400, "Nessun importo da addebitare: la caparra trattenuta copre già il servizio")
    try:
        intent = stripe.PaymentIntent.create(
            amount=_to_cents(amount),
            currency=_currency(appointment.salon),
            customer=customer_id,
            payment_method=client.stripe_payment_method_id,
            off_session=True,
            confirm=True,
            metadata={
                "appointment_id": appointment.id,
                "kind": "no_show",
                "salon_id": appointment.salon_id,
                "acct": account_token(appointment.salon),
            },
            # La carta fa parte della chiave: un addebito rifiutato bruciava la
            # chiave per 24 h e il ritentativo con un'altra carta si riprendeva
            # lo stesso errore invece di partire. Un doppio clic con la STESSA
            # carta continua a valere per un addebito solo.
            idempotency_key=(
                f"no-show-{appointment.salon_id}-{appointment.id}"
                f"-{client.stripe_payment_method_id}"
            ),
            **_account_opts(appointment.salon),
        )
    except stripe.StripeError as exc:
        raise HttpError(400, f"Addebito non riuscito: {getattr(exc, 'user_message', None) or exc}")
    appointment.no_show_payment_intent_id = intent["id"]
    appointment.save(update_fields=["no_show_payment_intent_id", "updated_at"])
    return intent, amount


def refund_deposit(appointment):
    """Rimborsa su Stripe la caparra pagata online. Ritorna il Refund, o None.

    None quando non è possibile farlo da qui — Stripe non configurato, caparra
    incassata fuori piattaforma (nessun PaymentIntent), errore Stripe: in quel
    caso il rimborso è manuale e l'appuntamento resta «da rimborsare».

    Il Refund torna intero perché il suo `status` conta: Stripe può rispondere
    «pending» e quel denaro non è ancora arrivato alla cliente. Chi chiama non
    deve dedurre «rimborsato» dal solo fatto che la chiamata non è esplosa.
    """
    intent_id = appointment.deposit_payment_intent_id
    if not settings.STRIPE_SECRET_KEY or not intent_id:
        return None
    stripe = _client()
    try:
        return stripe.Refund.create(
            payment_intent=intent_id,
            idempotency_key=f"deposit-refund-{appointment.salon_id}-{appointment.id}",
            **_account_opts(appointment.salon),
        )
    except stripe.StripeError as exc:
        logger.warning("Rimborso caparra non riuscito (appuntamento %s): %s", appointment.id, exc)
        return None


def refund_payment_intent(salon, intent_id: str, *, idempotency_key: str, amount_cents: int = 0):
    """Rimborsa un PaymentIntent qualsiasi del salone. Ritorna il Refund, o None.

    Serve per gli incassi in eccesso: una seconda caparra pagata su un link
    ancora aperto va restituita, non tenuta senza che nessuno se ne accorga.
    `amount_cents` rimborsa solo una parte (caparra più alta del conto finale);
    a zero restituisce tutto.
    """
    if not settings.STRIPE_SECRET_KEY or not intent_id:
        return None
    stripe = _client()
    params = {"payment_intent": intent_id, "idempotency_key": idempotency_key}
    if amount_cents and int(amount_cents) > 0:
        params["amount"] = int(amount_cents)
    try:
        return stripe.Refund.create(**params, **_account_opts(salon))
    except stripe.StripeError as exc:
        logger.warning("Rimborso %s non riuscito: %s", intent_id, exc)
        return None


def verify_webhook(payload: bytes, sig_header: str) -> dict:
    """Evento webhook con firma verificata.

    Senza STRIPE_WEBHOOK_SECRET il webhook viene RIFIUTATO: accettare eventi non
    firmati permetterebbe a chiunque di segnare una caparra come pagata con una
    POST anonima.
    """
    if not settings.STRIPE_WEBHOOK_SECRET:
        raise HttpError(503, "Webhook Stripe non configurato (STRIPE_WEBHOOK_SECRET mancante)")
    import stripe  # lazy

    try:
        return stripe.Webhook.construct_event(payload, sig_header, settings.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.SignatureVerificationError):
        raise HttpError(400, "Firma webhook non valida")
