"""Integrazione Stripe: carte salvate, acconti, addebito no-show, rimborso caparra.

Stripe è opzionale: senza STRIPE_SECRET_KEY ogni funzione risponde
HttpError(503, "Stripe non configurato"). Gli importi sono in centesimi.
"""

import datetime as dt
import logging
from decimal import Decimal
from urllib.parse import urlencode

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from common.money import CENT, to_cents

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


def as_dict(obj) -> dict:
    """Risposta Stripe come dict semplice (anche gli oggetti annidati).

    Da stripe-python 12 `StripeObject` non è più un dict: con la 15 installata
    ogni `.get()` su Event, Session, Refund o OAuthToken sollevava
    AttributeError. Il webhook rispondeva 500 e la caparra pagata restava
    «richiesta» fino al rilascio dello slot, «Invia link» e «Collega Stripe»
    fallivano DOPO che Stripe aveva già creato la sessione o consumato il code,
    l'annullamento esplodeva a rimborso già eseguito. I test passavano perché i
    mock restituivano dict: per questo ogni risposta passa da qui subito dopo la
    chiamata, e un dict (mock o versioni vecchie della libreria) va bene uguale.
    """
    if isinstance(obj, dict):
        return obj
    to_dict = getattr(obj, "to_dict", None)
    if callable(to_dict):
        data = to_dict()
        if isinstance(data, dict):
            return data
    return {}


# ---- Account del salone (Stripe Connect) -------------------------------------


def salon_account_id(salon) -> str:
    """Account Stripe collegato dal titolare ("" = si usa l'account della piattaforma)."""
    salon_settings = getattr(salon, "settings", None)
    return getattr(salon_settings, "stripe_account_id", "") or ""


def _account_opts(salon) -> dict:
    """kwargs per le chiamate Stripe: instradano sull'account del salone se collegato."""
    return _account_kwargs(salon_account_id(salon))


def _account_kwargs(account: str) -> dict:
    """kwargs per una chiamata su un account preciso ("" = piattaforma)."""
    return {"stripe_account": account} if account else {}


def deposit_account(appointment) -> str:
    """Account Stripe su cui vive la caparra dell'appuntamento ("" = piattaforma).

    È quello salvato alla creazione del link e all'arrivo del pagamento, non
    l'account attuale del salone: dopo aver collegato (o scollegato) Stripe i
    rimborsi partivano sull'account nuovo, dove quel PaymentIntent non esiste,
    e la caparra restava «da rimborsare» con i soldi fermi sull'altro. Per le
    caparre registrate prima del campo si ricade sull'account attuale.
    """
    account = getattr(appointment, "deposit_stripe_account", None)
    if account is None:
        return salon_account_id(appointment.salon)
    return account


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
        response = as_dict(stripe.OAuth.token(grant_type="authorization_code", code=code))
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

    # Lock della riga cliente e rilettura prima di creare: con un doppio tocco
    # su «salva carta» (o carta salvata e addebito no-show insieme) le due
    # richieste creavano due Customer, la carta si agganciava a uno e sulla
    # scheda restava l'altro — e l'addebito no-show veniva rifiutato (18-11).
    # La seconda richiesta aspetta qui e trova il codice già scritto.
    with transaction.atomic():
        current = type(client).objects.select_for_update().filter(pk=client.pk).first()
        if current is not None and current.stripe_customer_id and current.stripe_account_id == account:
            client.stripe_customer_id = current.stripe_customer_id
            client.stripe_account_id = current.stripe_account_id
            client.stripe_payment_method_id = current.stripe_payment_method_id
            return client.stripe_customer_id
        customer = as_dict(
            stripe.Customer.create(
                name=f"{client.first_name} {client.last_name}".strip(),
                phone=client.phone or None,
                email=client.email or None,
                metadata={"client_id": client.id, "salon_id": client.salon_id},
                **_account_opts(client.salon),
            )
        )
        if client.stripe_customer_id:
            logger.info(
                "Cliente %s ricreato su un altro account Stripe (%s → %s): carta salvata rimossa",
                client.id, client.stripe_account_id or "piattaforma", account or "piattaforma",
            )
        client.stripe_customer_id = customer.get("id") or ""
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
    return as_dict(
        stripe.SetupIntent.create(
            customer=customer_id,
            usage="off_session",
            metadata={"client_id": client.id},
            **_account_opts(client.salon),
        )
    )


def _deposit_return_urls(appointment) -> tuple[str, str]:
    base = (settings.CLIENT_APP_ORIGIN or settings.FRONTEND_ORIGIN).rstrip("/")
    slug = appointment.salon.slug
    return (
        f"{base}/{slug}?deposit=paid&appointment={appointment.id}",
        f"{base}/{slug}?deposit=cancelled&appointment={appointment.id}",
    )


# Stripe chiude comunque una sessione Checkout dopo 24 ore, e una scadenza
# esplicita la accetta solo fra 30 minuti e 24 ore dalla creazione.
CHECKOUT_DEFAULT_LIFETIME = dt.timedelta(hours=24)
# Un link che scade fra pochi minuti non si manda più: la cliente lo aprirebbe
# già chiuso. Si rifà.
LINK_MIN_REMAINING = dt.timedelta(minutes=10)
# Stati in cui la visita è ancora in piedi e la caparra ha senso di pagarla.
OPEN_APPOINTMENT_STATUSES = ("confirmed", "checked_in", "in_progress")


def _from_timestamp(value):
    """Timestamp Unix di Stripe → datetime aware (None se assente o illeggibile)."""
    try:
        return dt.datetime.fromtimestamp(int(value), tz=dt.timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def create_deposit_checkout(appointment) -> dict:
    """Checkout Session Stripe per la caparra: {"url", "id", "expires_at", "account"}.

    Il PaymentIntent generato porta gli stessi metadata (appointment_id, kind=deposit),
    così `payment_intent.succeeded` marca la caparra come pagata. Se il salone ha
    una scadenza caparra la sessione scade con lei (Stripe ammette 30 min–24 h).

    Tornano anche la scadenza della sessione e l'account su cui è stata creata:
    vanno salvate sull'appuntamento, perché il link muore al più tardi dopo 24
    ore (05-10) e va chiuso sull'account dove vive anche se nel frattempo il
    titolare ha collegato o scollegato Stripe (05-12).
    """
    stripe = _client()
    amount = Decimal(str(appointment.deposit_amount or 0))
    if amount <= 0:
        raise HttpError(400, "Nessuna caparra richiesta per questo appuntamento")
    client = appointment.client
    account = salon_account_id(appointment.salon)
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
                    "unit_amount": to_cents(amount),
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
    now = timezone.now()
    due = appointment.deposit_due_at
    if due is not None:
        seconds = (due - now).total_seconds()
        if 30 * 60 + 60 <= seconds <= 24 * 3600 - 60:
            params["expires_at"] = int(due.timestamp())
    # Chiave al microsecondo: con i secondi interi due link rifatti nello
    # stesso secondo riprendevano da Stripe la sessione di prima — quella che
    # subito dopo veniva chiusa come «vecchia».
    stamp = int(appointment.updated_at.timestamp() * 1_000_000)
    try:
        session = as_dict(
            stripe.checkout.Session.create(
                **params,
                idempotency_key=f"deposit-checkout-{appointment.salon_id}-{appointment.id}-{stamp}",
                **_account_kwargs(account),
            )
        )
    except stripe.StripeError as exc:
        raise HttpError(400, f"Link di pagamento non creato: {getattr(exc, 'user_message', None) or exc}")
    expires_at = (
        _from_timestamp(session.get("expires_at"))
        or _from_timestamp(params.get("expires_at"))
        or now + CHECKOUT_DEFAULT_LIFETIME
    )
    return {
        "url": session.get("url") or "",
        "id": session.get("id") or "",
        "expires_at": expires_at,
        "account": account,
    }


def expire_deposit_checkout(appointment) -> None:
    """Chiude la Checkout Session precedente della caparra, se ce n'è una.

    Senza questo passaggio il sollecito lasciava aperto anche il link vecchio:
    se la cliente pagava tutti e due, il salone incassava due caparre e il
    gestionale ne registrava una sola. Si chiude sull'account dove la sessione
    è nata (vedi `deposit_account`). Senza sessione non fa niente.
    """
    session_id = appointment.deposit_checkout_session_id
    if not session_id or not payments_enabled(appointment.salon):
        return
    stripe = _client()
    try:
        stripe.checkout.Session.expire(session_id, **_account_kwargs(deposit_account(appointment)))
    except stripe.StripeError as exc:
        # Già scaduta, già pagata o sconosciuta: non è un motivo per non
        # mandare il nuovo link.
        logger.info("Sessione caparra %s non chiusa: %s", session_id, exc)


def _retrieve_deposit_session(appointment) -> dict:
    """La sessione del link com'è adesso su Stripe ({} se non si riesce a saperlo)."""
    session_id = appointment.deposit_checkout_session_id
    if not session_id or not payments_enabled(appointment.salon):
        return {}
    stripe = _client()
    try:
        return as_dict(
            stripe.checkout.Session.retrieve(session_id, **_account_kwargs(deposit_account(appointment)))
        )
    except stripe.StripeError as exc:
        logger.info("Sessione caparra %s non letta: %s", session_id, exc)
        return {}


def deposit_link_usable(appointment) -> bool:
    """Il link salvato si può ancora pagare?

    La sessione Checkout muore dopo 24 ore anche se la caparra scade fra tre
    giorni: la cliente che apriva «Paga ora» il giorno dopo, o il sollecito,
    trovava una pagina già chiusa da Stripe e non aveva modo di pagare (05-10).
    Si guarda la scadenza salvata; se è passata (o manca, per i link di prima)
    si chiede a Stripe: una sessione già PAGATA vale ancora — il webhook sta
    arrivando, un link nuovo farebbe pagare la caparra due volte.
    """
    if not appointment.deposit_payment_link:
        return False
    now = timezone.now()
    known = appointment.deposit_link_expires_at
    if known is not None and known - now > LINK_MIN_REMAINING:
        return True
    session = _retrieve_deposit_session(appointment)
    status = session.get("status") or ""
    if status == "complete":
        return True
    if status == "expired":
        return False
    live_until = _from_timestamp(session.get("expires_at"))
    if status == "open" and live_until is not None:
        # Solo la colonna della scadenza: è un dato letto da Stripe, non una
        # modifica dell'appuntamento.
        type(appointment).objects.filter(pk=appointment.pk).update(deposit_link_expires_at=live_until)
        appointment.deposit_link_expires_at = live_until
        return live_until - now > LINK_MIN_REMAINING
    # Stripe non ha risposto: un link di prima senza scadenza nota si tiene
    # (come sempre), uno scaduto per davvero si rifà.
    return known is None


def _link_not_created(appointment, exc, *, suspend_hold: bool) -> None:
    """Il link non si è potuto creare: lo si scrive e, se serve, si ferma la scadenza.

    Senza un link pagabile la cliente non ha modo di versare la caparra: se la
    scadenza restava in piedi lo slot si liberava da solo e le arrivava
    «caparra non versata» per un link mai ricevuto (account Connect non ancora
    attivo, errore di rete: 05-11). La scadenza si toglie solo se NON c'è un
    link ancora valido; lo staff può rimandarlo o incassare al banco.
    """
    from apps.agenda.services import clear_deposit_hold  # lazy
    from apps.core.services import log_activity  # lazy

    suspended = suspend_hold and appointment.deposit_due_at is not None
    if suspended:
        clear_deposit_hold(appointment)
    log_activity(
        appointment.salon,
        "deposit.link_failed",
        "Link caparra non creato"
        + (": scadenza sospesa, lo slot non si libera da solo" if suspended else "")
        + f" — {appointment.client.full_name}",
        payload={
            "appointment_id": appointment.id,
            "error": str(exc)[:300],
            "hold_suspended": suspended,
        },
    )


def _renew_deposit_link(appointment, *, previous_usable: bool) -> None:
    """Apre una nuova sessione di pagamento e chiude quella di prima.

    La nuova si crea PRIMA di chiudere la vecchia: se Stripe non risponde, alla
    cliente resta il link che ha già in mano.
    """
    try:
        session = create_deposit_checkout(appointment)
    except Exception as exc:
        _link_not_created(appointment, exc, suspend_hold=not previous_usable)
        raise
    if session["id"] != appointment.deposit_checkout_session_id:
        expire_deposit_checkout(appointment)
    appointment.deposit_payment_link = session["url"]
    appointment.deposit_checkout_session_id = session["id"]
    appointment.deposit_link_expires_at = session["expires_at"]
    appointment.deposit_stripe_account = session["account"]
    appointment.save(
        update_fields=[
            "deposit_payment_link",
            "deposit_checkout_session_id",
            "deposit_link_expires_at",
            "deposit_stripe_account",
            "updated_at",
        ]
    )


def refresh_deposit_link(appointment) -> bool:
    """Rifà in silenzio il link se non è più pagabile; dice se ora ce n'è uno valido.

    Per il sollecito automatico: porta il link salvato, e con una sessione già
    scaduta la cliente riceveva di nuovo una pagina chiusa (05-10). Nessun
    messaggio parte da qui: il sollecito lo manda chi chiama.
    """
    if not payments_enabled(appointment.salon):
        return bool(appointment.deposit_payment_link)
    if deposit_link_usable(appointment):
        return True
    try:
        _renew_deposit_link(appointment, previous_usable=False)
    except Exception:  # noqa: BLE001 — già scritto nel registro da _link_not_created
        logger.warning("Link caparra non rifatto per il sollecito (appuntamento %s)", appointment.id, exc_info=True)
        return False
    return True


def ensure_deposit_link(appointment, *, resend: bool = False, actor=None, reason: str = "") -> str:
    """Link di pagamento della caparra: lo crea se manca (e i pagamenti sono attivi),
    lo accoda alla cliente (`deposit.payment_link`, WhatsApp via Yourang) e lo salva
    sull'appuntamento. Ritorna "" se i pagamenti online non sono configurati o se
    la visita non è più in piedi.

    Un link salvato ma non più pagabile (sessione scaduta) viene rifatto come se
    mancasse. `reason="amount_changed"`: la caparra è cambiata e il link vecchio
    chiedeva l'importo di prima.
    """
    from apps.core.services import emit_event, log_activity  # lazy

    if appointment.deposit_status != "required" or Decimal(str(appointment.deposit_amount or 0)) <= 0:
        return ""
    # Visita annullata, liberata, chiusa o no-show: un link pagabile porterebbe
    # solo a un rimborso, con le commissioni Stripe perse.
    if appointment.status not in OPEN_APPOINTMENT_STATUSES:
        return ""
    if not payments_enabled(appointment.salon):
        return ""
    usable = deposit_link_usable(appointment)
    # Al sollecito il link viene sempre rifatto: la sessione di pagamento porta
    # la stessa scadenza della caparra, quindi rispedire quello vecchio significa
    # mandare alla cliente una pagina che Stripe ha già chiuso.
    if not (resend or not usable):
        return appointment.deposit_payment_link
    _renew_deposit_link(appointment, previous_usable=usable)
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
        "reason": reason,
    }
    # Stessa chiave degli eventi dell'appuntamento: un messaggio della visita
    # in ritentativo non viene scavalcato (vedi flush_outbox). Non si fonde
    # con loro (le fusioni guardano solo i tipi `appointment.*`) e non aspetta
    # quelli solo trattenuti: il termine per pagare corre già.
    from apps.agenda.services import appointment_event_key  # lazy

    emit_event(
        appointment.salon,
        "deposit.payment_link",
        payload,
        coalesce_key=appointment_event_key(appointment.id),
    )
    if reason == "amount_changed":
        label = "Link caparra rifatto col nuovo importo"
    else:
        label = "Sollecito caparra" if resend else "Link caparra inviato"
    log_activity(
        appointment.salon,
        "deposit.link_sent",
        f"{label} — {appointment.client.full_name}",
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
    return max(amount, Decimal("0.00")).quantize(CENT)


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
        intent = as_dict(
            stripe.PaymentIntent.create(
                amount=to_cents(amount),
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
        )
    except stripe.StripeError as exc:
        raise HttpError(400, f"Addebito non riuscito: {getattr(exc, 'user_message', None) or exc}")
    appointment.no_show_payment_intent_id = intent.get("id") or ""
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
        return as_dict(
            stripe.Refund.create(
                payment_intent=intent_id,
                idempotency_key=f"deposit-refund-{appointment.salon_id}-{appointment.id}",
                # Sull'account dove la caparra è stata pagata, non su quello
                # collegato oggi (vedi `deposit_account`).
                **_account_kwargs(deposit_account(appointment)),
            )
        )
    except stripe.StripeError as exc:
        logger.warning("Rimborso caparra non riuscito (appuntamento %s): %s", appointment.id, exc)
        return None


def refund_payment_intent(
    salon, intent_id: str, *, idempotency_key: str, amount_cents: int = 0, account: str | None = None
):
    """Rimborsa un PaymentIntent qualsiasi del salone. Ritorna il Refund, o None.

    Serve per gli incassi in eccesso: una seconda caparra pagata su un link
    ancora aperto va restituita, non tenuta senza che nessuno se ne accorga.
    `amount_cents` rimborsa solo una parte (caparra più alta del conto finale);
    a zero restituisce tutto. `account` è l'account Stripe su cui vive il
    pagamento ("" = piattaforma); None = quello collegato oggi dal salone.
    """
    if not settings.STRIPE_SECRET_KEY or not intent_id:
        return None
    stripe = _client()
    params = {"payment_intent": intent_id, "idempotency_key": idempotency_key}
    if amount_cents and int(amount_cents) > 0:
        params["amount"] = int(amount_cents)
    opts = _account_opts(salon) if account is None else _account_kwargs(account)
    try:
        return as_dict(stripe.Refund.create(**params, **opts))
    except stripe.StripeError as exc:
        logger.warning("Rimborso %s non riuscito: %s", intent_id, exc)
        return None


def webhook_secrets() -> list[str]:
    """Segreti di firma accettati dal webhook, nell'ordine e senza doppioni.

    L'endpoint della piattaforma e quello Connect hanno segreti diversi (vedi
    settings): con uno solo, le caparre dei saloni collegati — eventi Connect —
    venivano rifiutate tutte, oppure lo erano quelle della piattaforma.
    """
    extra = getattr(settings, "STRIPE_WEBHOOK_SECRETS", None) or []
    if isinstance(extra, str):
        extra = extra.split(",")
    candidates = [
        getattr(settings, "STRIPE_WEBHOOK_SECRET", ""),
        getattr(settings, "STRIPE_CONNECT_WEBHOOK_SECRET", ""),
        *extra,
    ]
    secrets: list[str] = []
    for secret in candidates:
        secret = (secret or "").strip()
        if secret and secret not in secrets:
            secrets.append(secret)
    return secrets


def verify_webhook(payload: bytes, sig_header: str) -> dict:
    """Evento webhook con firma verificata, come dict (vedi `as_dict`).

    Senza nessun segreto il webhook viene RIFIUTATO: accettare eventi non
    firmati permetterebbe a chiunque di segnare una caparra come pagata con una
    POST anonima. La firma è valida se torna con UNO dei segreti configurati.
    """
    secrets = webhook_secrets()
    if not secrets:
        raise HttpError(503, "Webhook Stripe non configurato (STRIPE_WEBHOOK_SECRET mancante)")
    import stripe  # lazy

    for secret in secrets:
        try:
            event = stripe.Webhook.construct_event(payload, sig_header, secret)
        except stripe.SignatureVerificationError:
            continue  # firmato con un altro dei segreti, forse
        except ValueError:
            # Firma giusta ma corpo illeggibile: nessun altro segreto lo rende valido.
            raise HttpError(400, "Firma webhook non valida")
        return as_dict(event)
    raise HttpError(400, "Firma webhook non valida")
