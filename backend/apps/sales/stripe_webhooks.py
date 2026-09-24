"""Webhook Stripe: che cosa fa il gestionale per ogni evento.

L'endpoint (`api.stripe_webhook`) verifica la firma e passa qui l'evento, già
come dict. Si ascoltano i pagamenti (caparre e addebiti no-show), le sessioni
Checkout dei link caparra, i rimborsi — anche quelli fatti a mano dalla
dashboard Stripe — e le carte salvate dalla web app; gli altri eventi si
ignorano. Le scritture sulla caparra sotto lock e i rimborsi di quanto è
arrivato in più stanno in deposits.py. Stava tutto dentro api.py.
"""

import logging

from django.db import transaction

from apps.agenda.models import Appointment
from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon
from apps.core.services import emit_event, log_activity

from . import deposits, stripe_service

logger = logging.getLogger("youty.stripe")

# Rimborso fatto da Stripe (anche a mano dalla dashboard): allineiamo lo
# stato locale, altrimenti al checkout la caparra verrebbe detratta di nuovo
# da un anticipo che è già tornato alla cliente. Si ascoltano anche gli
# aggiornamenti: un rimborso creato «pending» può poi fallire, e senza quel
# secondo evento resterebbe scritto «rimborsata» per sempre.
REFUND_EVENTS = (
    "charge.refunded",
    "refund.created",
    "refund.updated",
    "refund.failed",
    "charge.refund.updated",
)


def _stripe_id(value) -> str:
    """Id di un riferimento Stripe (intent, metodo di pagamento, Customer).

    Stripe lo manda come stringa, oppure come oggetto quando è «espanso»: si
    accettano tutti e due, e un valore vuoto diventa "".
    """
    value = value or ""
    if isinstance(value, dict):
        return value.get("id") or ""
    return value


def handle_event(event: dict) -> None:
    """Esegue un evento Stripe con la firma già verificata (`stripe_service.verify_webhook`)."""
    event_type = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    metadata = obj.get("metadata") or {}
    # Con Stripe Connect l'evento dichiara l'account collegato che l'ha generato:
    # serve a verificare che riguardi davvero il salone indicato nei metadata.
    account = event.get("account") or ""

    if event_type == "payment_intent.succeeded":
        on_payment_intent_succeeded(obj, metadata, account)
    elif event_type == "checkout.session.completed":
        on_checkout_session_completed(obj, metadata, account)
    elif event_type in REFUND_EVENTS:
        on_refund_event(obj, event_type)
    elif event_type == "setup_intent.succeeded":
        on_setup_intent_succeeded(obj, metadata, account)


# ---- Account dell'evento -------------------------------------------------------


def _salon_account_recognised(salon, account: str, metadata: dict) -> bool:
    """L'account dell'evento è quello del salone, o quello firmato nei metadata?"""
    expected = stripe_service.salon_account_id(salon)
    if (account or "") == (expected or ""):
        return True
    return stripe_service.account_token_matches(salon, metadata.get("acct") or "", account)


def _account_recognised(appointment, account: str, metadata: dict) -> bool:
    """L'evento arriva da un account Stripe che abbiamo usato noi per questo salone?

    Serve a tenere fuori gli eventi di un salone collegato che dichiari nei
    metadata l'id di un appuntamento altrui. Non basta però confrontare con
    l'account ATTUALE: il PaymentIntent è nato sull'account di ALLORA, e
    collegare o scollegare Stripe faceva scartare i pagamenti dei link già in
    volo (`deposit.payment_ignored`), con lo slot liberato e i soldi fermi sulla
    piattaforma. Per questo si accetta anche l'account firmato nei metadata al
    momento della creazione (`acct`, vedi stripe_service.account_token): la
    firma è nostra, quindi nessuno può dichiararne uno a piacere.
    """
    if _salon_account_recognised(appointment.salon, account, metadata):
        return True
    expected = stripe_service.salon_account_id(appointment.salon)
    log_activity(
        appointment.salon,
        "deposit.payment_ignored",
        f"Evento Stripe da un account non riconosciuto — {appointment.client.full_name}",
        payload={"appointment_id": appointment.id, "account": account or "", "expected": expected or ""},
    )
    return False


# ---- Pagamenti -----------------------------------------------------------------


def on_payment_intent_succeeded(obj: dict, metadata: dict, account: str = "") -> None:
    """payment_intent.succeeded: solo un intent di tipo `deposit` paga la caparra.

    Gli intent sono creati da noi con `metadata.kind` (deposit | no_show): un
    addebito no-show non deve far comparire la caparra come versata. La
    transizione avviene solo da «richiesta», una volta sola (Stripe può
    reinviare lo stesso evento) e solo se l'importo copre la caparra attesa.

    L'appuntamento viene cercato DENTRO il salone dichiarato nei metadata, e
    l'account Connect che ha generato l'evento deve essere uno di quelli usati
    da noi per quel salone (vedi `_account_recognised`): senza questi due
    controlli un salone collegato poteva creare sul proprio account un intent
    con l'id di un appuntamento altrui e farne risultare pagata la caparra.
    """
    appointment_id = metadata.get("appointment_id")
    salon_id = metadata.get("salon_id")
    if not appointment_id:
        return
    kind = metadata.get("kind") or "deposit"
    qs = Appointment.objects.select_related("salon", "salon__settings", "client")
    if salon_id:
        qs = qs.filter(salon_id=salon_id)
    appointment = qs.filter(pk=appointment_id).first()
    if appointment is None:
        if kind == "deposit":
            _orphan_deposit_payment(obj, metadata, account)
        return
    if not _account_recognised(appointment, account, metadata):
        return
    intent_id = obj.get("id") or ""
    client_name = appointment.client.full_name

    if kind == "no_show":
        if not appointment.no_show_payment_intent_id and intent_id:
            appointment.no_show_payment_intent_id = intent_id
            appointment.save(update_fields=["no_show_payment_intent_id", "updated_at"])
        log_activity(
            appointment.salon,
            "sale.no_show_paid",
            f"Addebito no-show incassato — {client_name}",
            payload={"appointment_id": appointment.id, "payment_intent_id": intent_id},
        )
        return
    if kind != "deposit":
        return

    outcome, excess_cents = deposits.apply_deposit_payment(appointment, intent_id, obj, account)

    # Le chiamate a Stripe e gli eventi stanno FUORI dal lock: una rete lenta
    # non deve tenere bloccato l'appuntamento (e quindi l'agenda).
    if outcome == "duplicate":
        deposits.refund_duplicate_deposit(appointment, intent_id, obj, account)
    elif outcome == "refund_due":
        from apps.agenda.services.messages import appointment_event_key  # lazy
        from apps.agenda.services.refunds import settle_deposit_refund  # lazy

        emit_event(
            appointment.salon,
            "deposit.paid_after_release",
            {
                "appointment_id": appointment.id,
                "client_id": appointment.client_id,
                "client_name": client_name,
                "phone": appointment.client.phone,
                "lang": appointment.client.lang,
                "amount": str(appointment.deposit_amount),
            },
            coalesce_key=appointment_event_key(appointment.id),
        )
        settle_deposit_refund(appointment)
    elif outcome == "paid":
        from apps.agenda.services.messages import appointment_event_key, deposit_paid_payload  # lazy

        # Lo stesso payload dell'incasso al banco: scritto qui a mano non
        # portava le preferenze WhatsApp della cliente (vedi deposit_paid_payload).
        emit_event(
            appointment.salon,
            "deposit.paid",
            deposit_paid_payload(appointment),
            coalesce_key=appointment_event_key(appointment.id),
        )
        if excess_cents > 0:
            deposits.refund_overpaid_deposit(appointment, intent_id, excess_cents, account)


def on_checkout_session_completed(obj: dict, metadata: dict, account: str = "") -> None:
    """checkout.session.completed: il link caparra (Checkout) pagato.

    La sessione porta gli stessi metadata dell'intent; l'intent è in
    `payment_intent`. Elaborato solo se il pagamento è andato a buon fine.
    """
    if obj.get("payment_status") in (None, "paid"):
        intent = _stripe_id(obj.get("payment_intent"))
        on_payment_intent_succeeded(
            {"id": intent, "amount_received": obj.get("amount_total"), "amount": obj.get("amount_total")},
            metadata,
            account,
        )


def _orphan_deposit_payment(obj: dict, metadata: dict, account: str) -> None:
    """Caparra pagata per un appuntamento che non esiste più: si restituisce e si scrive.

    Succede dopo «Torna indietro» su una prenotazione appena creata: la riga
    sparisce, ma il link di pagamento era già partito verso la cliente. Prima
    il webhook tornava indietro in silenzio — soldi incassati su Stripe,
    nessuna vendita, nessun rimborso, nessuna traccia (02-07, 03-02, 05-08,
    18-01). Il rimborso parte sull'account dove è arrivato il pagamento, e solo
    se è un account che usiamo per quel salone.
    """
    intent_id = obj.get("id") or ""
    try:
        salon_id = int(metadata.get("salon_id") or 0)
    except (TypeError, ValueError):
        salon_id = 0
    salon = Salon.objects.select_related("settings").filter(pk=salon_id).first() if salon_id else None
    if salon is None or not intent_id or not _salon_account_recognised(salon, account, metadata):
        logger.warning(
            "Caparra %s pagata per l'appuntamento %s, che non esiste: salone o account non riconosciuti (%r)",
            intent_id, metadata.get("appointment_id"), account,
        )
        return
    from apps.agenda.services.locking import lock_salon  # lazy

    summary = "Caparra pagata per un appuntamento che non esiste più: {}"
    cents = deposits.amount_received(obj) or 0
    payload = {
        "appointment_id": metadata.get("appointment_id"),
        "payment_intent_id": intent_id,
        "amount_cents": int(cents),
        "refund_id": "",
        "refund_status": "in_progress",
        "account": account or "",
    }
    # La riga si prende subito, sotto il lock del salone, con l'esito «in
    # corso». Stripe manda `payment_intent.succeeded` e
    # `checkout.session.completed` quasi insieme: senza lock passavano tutte e
    # due il controllo e le righe erano due, e la seconda poteva dire «da
    # rimborsare a mano» se Stripe le rifiutava la chiave ancora in uso. Ora la
    # seconda consegna trova la riga ed esce senza chiamare Stripe.
    with transaction.atomic():
        lock_salon(salon)
        if ActivityLog.objects.filter(
            salon=salon, type="deposit.orphan_payment", payload__payment_intent_id=intent_id
        ).exists():
            return  # stesso pagamento già trattato (Stripe manda intent e sessione)
        log = log_activity(
            salon, "deposit.orphan_payment", summary.format("rimborso in corso"), payload=payload
        )
    # Il rimborso fuori dalla transazione: con il lock tenuto durante la
    # chiamata, una risposta lenta di Stripe fermava l'agenda del salone per
    # tutto quel tempo. Poi la stessa riga prende l'esito vero, anche se la
    # chiamata esplode (worker fermato, per esempio): non resta «in corso»
    # per sempre, e dice di controllare a mano.
    refund = None
    try:
        refund = stripe_service.refund_payment_intent(
            salon,
            intent_id,
            idempotency_key=f"orphan-deposit-{salon.id}-{intent_id}",
            account=account or "",
        )
    finally:
        status = (refund or {}).get("status") or ""
        if refund is None:
            outcome = "da rimborsare a mano su Stripe"
        elif status in ("pending", "requires_action"):
            outcome = "rimborso in corso"
        else:
            outcome = "rimborsata"
        log.summary = summary.format(outcome)
        log.payload = {**payload, "refund_id": (refund or {}).get("id", ""), "refund_status": status}
        log.save(update_fields=["summary", "payload"])


# ---- Rimborsi ------------------------------------------------------------------


def _refund_facts(event_type: str, obj: dict) -> dict:
    """Estrae dall'evento Stripe (intent, id rimborso, centesimi, stato, soglia)."""
    intent_id = _stripe_id(obj.get("payment_intent"))
    if event_type == "charge.refunded":
        # obj è la Charge: `amount_refunded` è il totale già restituito, conta
        # solo i rimborsi riusciti e non porta l'id del singolo rimborso.
        return {
            "intent_id": intent_id,
            "refund_id": "",
            "cents": 0,
            "status": "",
            "floor_cents": int(obj.get("amount_refunded") or 0),
        }
    # obj è un Refund: `amount` è quel rimborso, `status` dice se è avvenuto.
    return {
        "intent_id": intent_id or obj.get("id") or "",
        "refund_id": obj.get("id") or "",
        "cents": int(obj.get("amount") or 0),
        "status": obj.get("status") or "succeeded",
        "floor_cents": 0,
    }


def on_refund_event(obj: dict, event_type: str = "charge.refunded") -> None:
    """Rimborso su un PaymentIntent nostro: aggiorna caparra rimborsata e stato.

    Copre anche il rimborso fatto a mano dalla dashboard Stripe, che altrimenti
    resterebbe invisibile al gestionale. Un rimborso parziale riduce solo la
    quota detraibile; uno ancora «pending» non vale come restituito. Vale per
    tutti gli eventi di `REFUND_EVENTS`: la Charge di `charge.refunded` e il
    Refund degli altri (vedi `_refund_facts`).
    """
    facts = _refund_facts(event_type, obj)
    if not facts["intent_id"]:
        return
    appointment = (
        Appointment.objects.select_related("salon", "client")
        .filter(deposit_payment_intent_id=facts["intent_id"])
        .first()
    )
    if appointment is None or appointment.deposit_status not in deposits.DEPOSIT_RECEIVED_STATUSES:
        return
    from apps.agenda.services.refunds import record_deposit_refund  # lazy

    record_deposit_refund(
        appointment,
        refund_id=facts["refund_id"],
        cents=facts["cents"],
        status=facts["status"],
        floor_cents=facts["floor_cents"],
    )


# ---- Carte salvate -------------------------------------------------------------


def on_setup_intent_succeeded(obj: dict, metadata: dict, account: str = "") -> None:
    """setup_intent.succeeded: la carta salvata dalla web app va sulla scheda della cliente."""
    client_id = metadata.get("client_id")
    payment_method = _stripe_id(obj.get("payment_method"))
    salon_id = metadata.get("salon_id")
    if client_id and payment_method:
        clients = Client.objects.select_related("salon", "salon__settings")
        # Filtro per salone come per i PaymentIntent: l'id nei metadata
        # arriva dall'evento, e senza vincolo un account collegato potrebbe
        # scrivere sulla scheda di un cliente di un altro salone.
        if salon_id:
            clients = clients.filter(salon_id=salon_id)
        client = clients.filter(pk=client_id).first()
        # L'account si riconosce come per i pagamenti: quello di oggi del
        # salone o quello firmato nei metadata alla creazione. Col solo
        # confronto con quello di oggi, la carta salvata mentre il titolare
        # collegava Stripe veniva scartata: la cliente credeva di averla
        # salvata e il salone non poteva addebitarle un no-show.
        if client and not _salon_account_recognised(client.salon, account, metadata):
            logger.warning(
                "setup_intent.succeeded ignorato: account %r non è quello del salone %s",
                account, client.salon_id,
            )
            client = None
        if client:
            client.stripe_payment_method_id = payment_method
            # La carta vale solo sull'account su cui è stata salvata.
            client.stripe_account_id = account
            fields = ["stripe_payment_method_id", "stripe_account_id"]
            # …e solo col Customer a cui è agganciata: se due richieste ne
            # avevano creati due, sulla scheda poteva restare quello
            # sbagliato e l'addebito no-show veniva rifiutato (18-11).
            customer = _stripe_id(obj.get("customer"))
            if customer:
                client.stripe_customer_id = customer
                fields.append("stripe_customer_id")
            client.save(update_fields=fields)
            log_activity(
                client.salon,
                "client.card_saved",
                f"Carta salvata — {client.full_name}",
                payload={"client_id": client.id},
            )
