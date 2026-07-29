"""Integrazione Stripe: caparre, carte salvate, addebito no-show / annullo tardivo.

**Connect Standard + direct charges.** Ogni chiamata viene eseguita SULL'ACCOUNT
DEL SALONE (`stripe_account=acct_…`): è il salone il merchant of record, incassa
sul suo conto ed è il suo nome a comparire sull'estratto conto della cliente. La
piattaforma non trattiene commissioni (nessuna application_fee_amount).

Conseguenza importante: Customer e PaymentMethod delle clienti vivono
sull'account del salone. Gli identificativi salvati su `Client` sono quindi
relativi a QUEL salone — cosa coerente, perché un Client è già per-salone.

Senza chiave segreta della piattaforma → 503. Con chiave ma senza account
collegato → 412 (vedi integrations.stripe_connect.require_account).
Gli importi sono in centesimi.
"""

import json
from decimal import Decimal, ROUND_HALF_UP

from django.conf import settings
from ninja.errors import HttpError


def _client():
    """Modulo stripe configurato, o 503 se la chiave segreta non è impostata."""
    if not settings.STRIPE_SECRET_KEY:
        raise HttpError(503, "Stripe non configurato")
    import stripe  # lazy: dipendenza opzionale a runtime

    stripe.api_key = settings.STRIPE_SECRET_KEY
    return stripe


def _acct(salon) -> str:
    """Account Stripe del salone. Alza 412 con il motivo se non è utilizzabile."""
    from apps.integrations.stripe_connect import require_account  # lazy: evita cicli

    return require_account(salon)


def _to_cents(amount) -> int:
    return int((Decimal(str(amount)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _currency(salon) -> str:
    return (getattr(salon, "currency", "") or "EUR").lower()


def pct_of(amount, pct: int) -> Decimal:
    """Percentuale di un importo, arrotondata al centesimo."""
    return (Decimal(str(amount or 0)) * Decimal(int(pct)) / Decimal(100)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


# ---- Customer / carta salvata ----------------------------------------------


def ensure_customer(client) -> str:
    """stripe_customer_id del cliente SULL'ACCOUNT DEL SALONE, creandolo se assente."""
    stripe = _client()
    account = _acct(client.salon)
    if client.stripe_customer_id:
        return client.stripe_customer_id
    customer = stripe.Customer.create(
        name=f"{client.first_name} {client.last_name}".strip(),
        phone=client.phone or None,
        email=client.email or None,
        metadata={"client_id": client.id, "salon_id": client.salon_id},
        stripe_account=account,
    )
    client.stripe_customer_id = customer["id"]
    client.save(update_fields=["stripe_customer_id"])
    return client.stripe_customer_id


def create_setup_intent(client):
    """SetupIntent off-session per salvare la carta senza un pagamento contestuale."""
    stripe = _client()
    account = _acct(client.salon)
    customer_id = ensure_customer(client)
    return stripe.SetupIntent.create(
        customer=customer_id,
        usage="off_session",
        metadata={"client_id": client.id},
        stripe_account=account,
    )


# ---- Caparra ----------------------------------------------------------------


def create_deposit_checkout(appointment, *, success_url: str = "", cancel_url: str = ""):
    """Checkout ospitato da Stripe per la caparra.

    Scelta: Checkout invece di un campo carta nell'app. Nessun Stripe.js da
    mantenere, ambito PCI minimo, buona resa da telefono. `setup_future_usage`
    fa sì che **lo stesso pagamento salvi anche la carta**: così l'eventuale
    addebito no-show non richiede un secondo passaggio della cliente.
    """
    stripe = _client()
    salon = appointment.salon
    account = _acct(salon)
    amount = Decimal(str(appointment.deposit_amount or 0))
    if amount <= 0:
        raise HttpError(400, "Nessuna caparra richiesta per questo appuntamento")
    customer_id = ensure_customer(appointment.client)
    base = (success_url or settings.CLIENT_APP_ORIGIN).rstrip("/")
    return stripe.checkout.Session.create(
        mode="payment",
        customer=customer_id,
        line_items=[{
            "quantity": 1,
            "price_data": {
                "currency": _currency(salon),
                "unit_amount": _to_cents(amount),
                "product_data": {"name": f"Caparra — {salon.name}"},
            },
        }],
        payment_intent_data={
            # La carta resta utilizzabile off-session per l'eventuale no-show.
            "setup_future_usage": "off_session",
            "metadata": {"appointment_id": appointment.id, "kind": "deposit"},
        },
        metadata={"appointment_id": appointment.id, "kind": "deposit"},
        success_url=f"{base}/?deposit=ok",
        cancel_url=f"{(cancel_url or base).rstrip('/')}/?deposit=ko",
        stripe_account=account,
    )


def create_card_setup_checkout(client):
    """Checkout ospitato in modalità `setup`: salva la carta SENZA addebitare nulla.

    Perché serve: finora la carta si salvava solo pagando una caparra, quindi un
    centro che vuole tutelarsi dai no-show *senza* chiedere caparre non aveva modo
    di averne una. Con `mode="setup"` la cliente vede la stessa pagina Stripe del
    pagamento, non le viene addebitato niente, e la carta resta utilizzabile
    off-session per un eventuale addebito.

    Il webhook `setup_intent.succeeded` registra il metodo di pagamento leggendo
    `metadata.client_id`: per questo lo passiamo dentro `setup_intent_data`.
    """
    stripe = _client()
    account = _acct(client.salon)
    customer_id = ensure_customer(client)
    base = settings.CLIENT_APP_ORIGIN.rstrip("/")
    return stripe.checkout.Session.create(
        mode="setup",
        customer=customer_id,
        setup_intent_data={"metadata": {"client_id": client.id}},
        metadata={"client_id": client.id, "kind": "save_card"},
        success_url=f"{base}/?card=ok",
        cancel_url=f"{base}/?card=ko",
        stripe_account=account,
    )


# ---- Addebiti off-session (no-show, annullo tardivo, caparra a scadenza) -----


class ChargeAuthRequired(Exception):
    """L'addebito richiede l'autenticazione della cliente (PSD2/SCA).

    Non è un errore di sistema: sotto PSD2 un addebito off-session su carta
    salvata PUÒ richiedere che la cliente autentichi. Chi chiama deve trattarlo
    come "in attesa", non come incassato.
    """

    def __init__(self, payment_intent_id: str, message: str = ""):
        self.payment_intent_id = payment_intent_id
        super().__init__(message or "Addebito da autenticare dalla cliente")


def _error_code(exc) -> str:
    """Codice errore di un CardError.

    Va letto da `exc.code`: la libreria lo popola sempre, mentre `exc.error` può
    essere None. Leggendolo solo da `exc.error.code` il ramo PSD2 non scatterebbe
    e un addebito da autenticare verrebbe riportato come errore generico.
    """
    code = getattr(exc, "code", "") or ""
    if code:
        return str(code)
    err = getattr(exc, "error", None)
    return str(getattr(err, "code", "") or "") if err is not None else ""


def _intent_id_from(exc) -> str:
    """Id del PaymentIntent da un CardError, qualunque forma abbia.

    Attenzione: in stripe-python gli oggetti NON sono dizionari — non hanno
    `.get()` — ma supportano l'accesso per attributo e per chiave. Un dict
    semplice arriva invece dai test. Vanno gestite entrambe le forme, altrimenti
    un caso previsto (autenticazione richiesta) diventa un crash.
    """
    err = getattr(exc, "error", None)
    pi = getattr(err, "payment_intent", None) if err is not None else None
    if pi is None:
        pi = getattr(exc, "payment_intent", None)
    if pi is None:
        return ""
    if isinstance(pi, dict):
        return str(pi.get("id") or "")
    return str(getattr(pi, "id", "") or "")


def charge_off_session(appointment, amount, *, kind: str):
    """Addebito off-session sulla carta salvata, sull'account del salone.

    `kind` finisce nei metadata ed è ciò che permette al webhook di distinguere
    una caparra da un addebito no-show (senza, un incasso no-show verrebbe letto
    come "caparra pagata").
    """
    stripe = _client()
    client = appointment.client
    account = _acct(appointment.salon)
    if not (client.consents or {}).get("card_charge"):
        raise HttpError(400, "Il cliente non ha autorizzato l'addebito sulla carta")
    if not client.stripe_payment_method_id:
        raise HttpError(400, "Nessuna carta salvata per il cliente")
    amount = Decimal(str(amount or 0))
    if amount <= 0:
        raise HttpError(400, "Nessun importo da addebitare")
    customer_id = ensure_customer(client)
    try:
        return stripe.PaymentIntent.create(
            amount=_to_cents(amount),
            currency=_currency(appointment.salon),
            customer=customer_id,
            payment_method=client.stripe_payment_method_id,
            off_session=True,
            confirm=True,
            metadata={"appointment_id": appointment.id, "kind": kind},
            stripe_account=account,
        )
    except stripe.CardError as exc:
        if _error_code(exc) == "authentication_required":
            raise ChargeAuthRequired(_intent_id_from(exc)) from exc
        raise HttpError(400, f"Addebito non riuscito: {getattr(exc, 'user_message', None) or exc}")
    except stripe.StripeError as exc:
        raise HttpError(400, f"Addebito non riuscito: {getattr(exc, 'user_message', None) or exc}")


def charge_no_show(appointment, *, pct: int = 100):
    """Addebito per mancata presentazione: percentuale del totale (default 100%)."""
    return charge_off_session(
        appointment, pct_of(appointment.total_price, pct), kind="no_show"
    )


def charge_late_cancel(appointment, *, pct: int):
    """Addebito per annullamento tardivo: percentuale decisa dal salone."""
    return charge_off_session(
        appointment, pct_of(appointment.total_price, pct), kind="late_cancel"
    )


def charge_deposit_off_session(appointment):
    """Incassa la caparra scaduta sulla carta già salvata (senza far agire la cliente)."""
    return charge_off_session(appointment, appointment.deposit_amount, kind="deposit")


# ---- Rimborsi --------------------------------------------------------------


def refund_payment(salon, payment_intent_id: str, amount=None, *, reason: str = ""):
    """Rimborsa (in tutto o in parte) un incasso già andato a buon fine.

    Serve perché l'addebito automatico può sbagliare: se lo staff dimentica il
    check-in, una cliente presente viene marcata no-show e addebitata. Senza un
    percorso di rimborso nel prodotto, il salone dovrebbe entrare nel cruscotto
    Stripe — e chi non sa farlo resterebbe bloccato con una cliente arrabbiata.

    `amount` None = rimborso totale. Il rimborso avviene sull'account del salone,
    quindi i soldi tornano da dove sono partiti.
    """
    stripe = _client()
    account = _acct(salon)
    if not payment_intent_id:
        raise HttpError(400, "Incasso da rimborsare non indicato")
    params = {
        "payment_intent": payment_intent_id,
        "metadata": {"reason": reason[:200]} if reason else {},
        "stripe_account": account,
    }
    if amount is not None:
        value = Decimal(str(amount))
        if value <= 0:
            raise HttpError(400, "L'importo da rimborsare deve essere positivo")
        params["amount"] = _to_cents(value)
    try:
        return stripe.Refund.create(**params)
    except stripe.StripeError as exc:
        raise HttpError(
            400, f"Rimborso non riuscito: {getattr(exc, 'user_message', None) or exc}"
        )


# ---- Webhook ---------------------------------------------------------------


def verify_webhook(payload: bytes, sig_header: str) -> dict:
    """Evento webhook verificato (firma se STRIPE_WEBHOOK_SECRET, altrimenti parse diretto)."""
    if settings.STRIPE_WEBHOOK_SECRET:
        import stripe  # lazy

        try:
            return stripe.Webhook.construct_event(
                payload, sig_header, settings.STRIPE_WEBHOOK_SECRET
            )
        except (ValueError, stripe.SignatureVerificationError):
            raise HttpError(400, "Firma webhook non valida")
    try:
        return json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HttpError(400, "Payload webhook non valido")
