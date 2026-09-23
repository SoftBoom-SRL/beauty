"""Servizi marketing: gift card, coupon, fedeltà, comunicazioni.

`create_gift_card`, `redeem_gift_card`, `accrue_loyalty`, `validate_coupon`,
`coupon_discount` e `mark_coupon_redeemed` sono API interne chiamate anche da
apps.sales.finalize_sale (import lazy lato sales): le firme NON vanno cambiate.
"""

import math
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import F
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity, supersede_events
from common.utils import human_code

from .models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram

# Sentinella per distinguere «non ho passato scheduled_at» da «l'ho passato a
# None perché voglio inviare adesso»: senza, una comunicazione già programmata
# non si poteva più forzare in invio immediato (il None veniva rimpiazzato dalla
# data salvata a database).
_UNSET = object()


def unique_code(model, salon, length: int) -> str:
    """Codice human_code unico per salone (coupon 8, gift card 12)."""
    while True:
        code = human_code(length)
        if not model.objects.filter(salon=salon, code=code).exists():
            return code


# ---- Gift card ---------------------------------------------------------------


def create_gift_card(
    salon,
    value,
    *,
    gift_service=None,
    buyer_client=None,
    recipient_client=None,
    recipient_name="",
    paid=False,
    paid_method="",
    sold_by=None,
    sale=None,
    cash_in=True,
):
    """Crea una gift card (usata anche da sales per le righe gift_card vendute).

    Se `gift_service` è valorizzato la carta regala quel trattamento: il valore
    passato deve già coincidere col prezzo del servizio (garantito dal chiamante).

    `cash_in=False` per le carte che nascono già pagate ma senza che nessuno
    abbia versato denaro (i premi fedeltà): la carta resta spendibile, ma nel
    registro attività non compare un incasso che non c'è stato."""
    value = Decimal(value)
    if value <= 0:
        raise HttpError(422, "Valore della gift card non valido")
    card = GiftCard.objects.create(
        salon=salon,
        code=unique_code(GiftCard, salon, 12),
        initial_value=value,
        balance=value,
        gift_service=gift_service,
        buyer_client=buyer_client,
        recipient_client=recipient_client,
        recipient_name=recipient_name,
        payment_status=GiftCard.PaymentStatus.PAID if paid else GiftCard.PaymentStatus.UNPAID,
        paid_at=timezone.now() if paid else None,
        paid_method=paid_method if paid else "",
    )
    log_activity(
        salon,
        "giftcard.created",
        f"Gift card {card.code} da €{card.initial_value}",
        actor=sold_by,
        payload={
            "gift_card_id": card.id,
            "code": card.code,
            "value": str(card.initial_value),
            "paid": paid,
            "sale_id": sale.id if sale else None,
        },
    )
    if paid and cash_in:
        log_activity(
            salon,
            "giftcard.paid",
            f"Incasso gift card {card.code}: €{card.initial_value} ({paid_method or 'n/d'})",
            actor=sold_by,
            payload={"gift_card_id": card.id, "amount": str(card.initial_value), "method": paid_method},
        )
    return card


def redeem_gift_card(salon, code, amount):
    """Scala `amount` dal saldo della gift card `code`. Ritorna la card aggiornata."""
    amount = Decimal(amount)
    if amount <= 0:
        raise HttpError(422, "Importo da scalare non valido")
    # L'eventuale errore viene sollevato FUORI dal blocco atomico: così la marcatura
    # EXPIRED sopravvive al rollback che l'eccezione provocherebbe.
    # Attenzione: quando questa funzione gira dentro finalize_sale l'atomic qui
    # sotto è solo un savepoint, e il rollback del checkout si porta via anche la
    # marcatura. Per questo la scadenza NON è mai un'informazione autoritativa in
    # lettura: ogni elenco che mostra carte spendibili filtra `expires_at` per
    # conto suo (vedi client_wallet e i KPI in api.py).
    error = None
    with transaction.atomic():
        card = (
            GiftCard.objects.select_for_update().filter(salon=salon, code=code).first()
        )
        if card is None:
            error = HttpError(404, "Gift card non trovata")
        elif card.status != GiftCard.Status.ACTIVE:
            error = HttpError(422, "Gift card non attiva")
        elif card.expires_at and card.expires_at < timezone.now():
            card.status = GiftCard.Status.EXPIRED
            card.save(update_fields=["status"])
            error = HttpError(422, "Gift card scaduta")
        elif card.payment_status != GiftCard.PaymentStatus.PAID:
            # Le carte comprate dall'app nascono "da pagare": finché il salone
            # non incassa, il saldo non è spendibile.
            error = HttpError(422, "Gift card non ancora pagata: incassala prima di usarla")
        elif card.balance < amount:
            error = HttpError(422, f"Saldo gift card insufficiente (residuo €{card.balance})")
    if error is not None:
        raise error
    with transaction.atomic():
        card = GiftCard.objects.select_for_update().get(pk=card.pk)
        if card.balance < amount:
            raise HttpError(422, f"Saldo gift card insufficiente (residuo €{card.balance})")
        card.balance -= amount
        if card.balance == 0:
            card.status = GiftCard.Status.REDEEMED
        card.save(update_fields=["balance", "status"])
        log_activity(
            salon,
            "giftcard.redeemed",
            f"Gift card {card.code}: scalati €{amount} (residuo €{card.balance})",
            payload={
                "gift_card_id": card.id,
                "code": card.code,
                "amount": str(amount),
                "balance": str(card.balance),
            },
        )
    return card


# ---- Fedeltà -----------------------------------------------------------------


def _issue_reward(program, client):
    """Emette il premio del programma. Ritorna None se non è emettibile.

    Ogni tipo di premio offerto dall'interfaccia ha qui la sua emissione:
    - buono € e sconto %: un Coupon, come prima;
    - servizio omaggio: una gift card legata a quel servizio, del suo prezzo —
      è il meccanismo che il banco sa già riscattare. Prima diventava un coupon
      da 0 €, perché la maschera manda reward_value=0 per questo tipo: la
      cliente raggiungeva la soglia, perdeva i punti e riceveva un buono che
      non scontava niente;
    - gift card: una carta del valore configurato.
    """
    salon = program.salon
    reward_type = program.reward_type
    value = Decimal(str(program.reward_value or 0))

    if reward_type in (
        LoyaltyProgram.RewardType.COUPON_AMOUNT,
        LoyaltyProgram.RewardType.DISCOUNT_PCT,
    ):
        if value <= 0:
            return None
        kind = (
            Coupon.Kind.PERCENT
            if reward_type == LoyaltyProgram.RewardType.DISCOUNT_PCT
            else Coupon.Kind.AMOUNT
        )
        coupon = Coupon.objects.create(
            salon=salon,
            client=client,
            code=unique_code(Coupon, salon, 8),
            kind=kind,
            value=value,
            origin=Coupon.Origin.LOYALTY,
        )
        suffix = "%" if kind == Coupon.Kind.PERCENT else "€"
        return {
            "label": f"coupon {coupon.code} ({value}{suffix})",
            "event": {"coupon_id": coupon.id, "coupon_code": coupon.code},
        }

    if reward_type == LoyaltyProgram.RewardType.FREE_SERVICE:
        service = program.reward_service
        # Un servizio a prezzo zero non diventa una carta (create_gift_card
        # rifiuta il valore 0): l'errore saliva dentro la transazione della
        # cassa e ogni scontrino di quella cliente veniva rifiutato. Il prezzo
        # può essere stato azzerato dopo aver salvato il programma, quindi il
        # controllo della maschera da solo non basta.
        if service is None or Decimal(str(service.price or 0)) <= 0:
            return None
        card = create_gift_card(
            salon,
            Decimal(str(service.price)),
            gift_service=service,
            recipient_client=client,
            recipient_name=client.full_name,
            paid=True,
            paid_method="loyalty",
            cash_in=False,
        )
        return {
            "label": f"servizio omaggio {service.name_it} (carta {card.code})",
            "event": {
                "gift_card_id": card.id,
                "gift_card_code": card.code,
                "service_id": service.id,
            },
        }

    if reward_type == LoyaltyProgram.RewardType.GIFT_CARD:
        if value <= 0:
            return None
        card = create_gift_card(
            salon,
            value,
            recipient_client=client,
            recipient_name=client.full_name,
            paid=True,
            paid_method="loyalty",
            cash_in=False,
        )
        return {
            "label": f"gift card {card.code} (€{value})",
            "event": {"gift_card_id": card.id, "gift_card_code": card.code},
        }

    return None


# Tetto ai premi che una singola vendita può emettere. Un programma configurato
# male (1000 punti per euro, soglia 10) trasformava un incasso da 100 € in
# diecimila premi: trentamila insert e diecimila messaggi WhatsApp dentro la
# transazione della cassa, con la cassiera bloccata a guardare la rotellina.
# Oltre il tetto i punti restano sul saldo del cliente — non si perde niente, i
# premi successivi arriveranno con le spese seguenti — e resta a registro una
# riga che segnala al salone che la configurazione è sbagliata.
MAX_REWARDS_PER_SALE = 10


def _loyalty_basis(sale) -> dict:
    """Quanto della vendita conta per la fedeltà: una volta per vendita, non
    una per programma.

    - Le gift card vendute non danno punti: li darà la spesa fatta con la
      carta. Contarle significava pagare due volte lo stesso denaro, una
      all'acquisto e una al riscatto. Per la stessa ragione una vendita fatta
      SOLO di gift card non è una visita: cinque carte di Natale in cinque
      scontrini valevano cinque timbri.
    - Il premio speso non fa guadagnare altro: una piega omaggio da 45 € pagata
      con la carta premio accreditava 45 punti, e con i timbri per servizio
      l'omaggio contava come timbro — il premio arrivava ogni nove visite
      pagate invece che ogni dieci. Le carte premio sono quelle con
      paid_method="loyalty" (vedi _issue_reward); i buoni premio abbassano già
      `sale.total`, e contano solo se il conto l'hanno pagato per intero.
    """
    sold_cards = Decimal("0")
    gift_card_lines = other_lines = services = 0
    for line in sale.lines.all():
        if line.line_type == "gift_card":
            gift_card_lines += 1
            sold_cards += Decimal(str(line.amount))
        else:
            other_lines += 1
            if line.line_type == "service":
                services += 1
    reward_paid = Decimal("0")
    reward_service_cards = set()
    for payment in sale.payments.filter(
        method="gift_card", gift_card__paid_method="loyalty"
    ).select_related("gift_card"):
        reward_paid += Decimal(str(payment.amount))
        if payment.gift_card.gift_service_id:
            reward_service_cards.add(payment.gift_card_id)
    reward_coupon = sale.coupons.filter(origin=Coupon.Origin.LOYALTY).exists()
    paid = Decimal(str(sale.total)) - sold_cards - reward_paid
    return {
        "paid": paid,
        "only_gift_cards": gift_card_lines > 0 and other_lines == 0,
        # Il conto l'ha pagato per intero un premio: non è una visita pagata.
        "reward_only": (reward_paid > 0 or reward_coupon) and paid <= 0,
        # Ogni carta «servizio omaggio» spesa copre un servizio del conto.
        "services": max(0, services - len(reward_service_cards)),
    }


def _points_earned(sale, program, basis=None) -> int:
    """Punti maturati dalla vendita secondo la metrica del programma."""
    basis = basis or _loyalty_basis(sale)
    metric = program.earn_metric
    # Un programma «A timbri» dà un timbro per visita o per servizio, MAI per
    # euro: la dashboard creava le tessere timbri con la metrica «per euro»
    # rimasta dal modello vuoto, e una piega da 45 € valeva 45 timbri — più
    # premi a ogni scontrino. L'API ora rifiuta la combinazione e la
    # migrazione 0004 ha corretto i programmi salvati; qui si resta al sicuro
    # anche con un programma scritto da un'altra via. Il rapporto non conta:
    # la maschera non lo mostra per i timbri, e un valore rimasto da «Punti»
    # (2, oppure 0,5 che arrotondato dava zero timbri) cambiava la tessera
    # senza che nessuno lo vedesse.
    stamps = program.type == LoyaltyProgram.Type.STAMPS
    if stamps and metric == LoyaltyProgram.EarnMetric.PER_EURO:
        metric = LoyaltyProgram.EarnMetric.PER_VISIT
    if metric == LoyaltyProgram.EarnMetric.PER_EURO:
        paid = basis["paid"]
        return math.floor(paid * program.earn_ratio) if paid > 0 else 0
    if basis["only_gift_cards"] or basis["reward_only"]:
        return 0
    if metric == LoyaltyProgram.EarnMetric.PER_VISIT:
        return 1 if stamps else math.floor(program.earn_ratio)
    # per_service
    n_services = basis["services"]
    return n_services if stamps else math.floor(program.earn_ratio * n_services)


def accrue_loyalty(sale):
    """Accredita punti per la vendita su ogni programma attivo; alla soglia genera
    un Coupon origin=loyalty ed emette `loyalty.reward`. No-op se la vendita è anonima."""
    client = sale.client
    if client is None:
        return
    salon = sale.salon
    basis = None  # calcolata al primo programma che serve, poi riusata
    for program in LoyaltyProgram.objects.filter(salon=salon, active=True):
        # Lettura del saldo, emissione dei premi e scrittura stanno in una sola
        # transazione con la riga del conto bloccata. Prima erano una lettura, una
        # somma in Python e un save: due casse che chiudevano insieme due scontrini
        # della stessa cliente leggevano entrambe 95 punti su una soglia di 100,
        # emettevano entrambe il premio e si sovrascrivevano il saldo a vicenda.
        with transaction.atomic():
            account = (
                LoyaltyAccount.objects.select_for_update()
                .filter(program=program, client=client)
                .first()
            )
            if account is None:
                if program.enrollment != LoyaltyProgram.Enrollment.AUTO:
                    continue  # iscrizione su richiesta/a pagamento: nessun auto-enroll
                # get_or_create ripiega su una get quando la unique scatta. Con la
                # create secca, due vendite simultanee della stessa cliente appena
                # iscritta facevano esplodere l'IntegrityError dentro l'atomic di
                # finalize_sale: 500 alla cassiera e scontrino annullato per intero.
                LoyaltyAccount.objects.get_or_create(program=program, client=client)
                account = LoyaltyAccount.objects.select_for_update().get(
                    program=program, client=client
                )

            if basis is None:
                basis = _loyalty_basis(sale)
            earned = _points_earned(sale, program, basis)
            if earned <= 0:
                continue

            points = account.points + earned
            issued = 0
            while (
                program.threshold > 0
                and points >= program.threshold
                and issued < MAX_REWARDS_PER_SALE
            ):
                reward = _issue_reward(program, client)
                if reward is None:
                    # Premio non emettibile (servizio omaggio senza servizio
                    # scelto, valore a zero): i punti NON si consumano, altrimenti
                    # la cliente pagherebbe la soglia per niente.
                    log_activity(
                        salon,
                        "loyalty.reward_misconfigured",
                        f"Premio fedeltà «{program.name}» non emesso: configurazione incompleta",
                        payload={"client_id": client.id, "program_id": program.id},
                    )
                    break
                points -= program.threshold
                issued += 1
                emit_event(
                    salon,
                    "loyalty.reward",
                    {
                        "client_id": client.id,
                        "client_name": client.full_name,
                        "phone": client.phone,
                        "lang": client.lang,
                        "program_id": program.id,
                        "program": program.name,
                        **reward["event"],
                    },
                )
                log_activity(
                    salon,
                    "loyalty.reward",
                    f"Premio fedeltà «{program.name}» per {client.full_name}: {reward['label']}",
                    payload={
                        "client_id": client.id,
                        "program_id": program.id,
                        "sale_id": sale.id,
                        **reward["event"],
                    },
                )
            if issued >= MAX_REWARDS_PER_SALE and points >= program.threshold > 0:
                log_activity(
                    salon,
                    "loyalty.reward_capped",
                    f"Programma «{program.name}»: raggiunto il tetto di {MAX_REWARDS_PER_SALE} "
                    "premi per vendita, i punti restanti restano sul saldo",
                    payload={
                        "client_id": client.id,
                        "program_id": program.id,
                        "sale_id": sale.id,
                        "points_left": points,
                    },
                )
            # Incremento in SQL: il delta si applica al valore che il database ha
            # davvero, non a una copia letta prima di emettere i premi.
            LoyaltyAccount.objects.filter(pk=account.pk).update(
                points=F("points") + (points - account.points)
            )


# ---- Coupon ------------------------------------------------------------------


def validate_coupon(salon, code, client=None):
    """Ritorna il coupon se attivo, non scaduto e (se client-bound) del cliente."""
    coupon = Coupon.objects.filter(salon=salon, code=code).first()
    if coupon is None:
        raise HttpError(404, "Coupon non trovato")
    if coupon.status == Coupon.Status.ACTIVE and coupon.expires_at and coupon.expires_at < timezone.now():
        coupon.status = Coupon.Status.EXPIRED
        coupon.save(update_fields=["status"])
        raise HttpError(422, "Coupon scaduto")
    if coupon.status != Coupon.Status.ACTIVE:
        raise HttpError(422, "Coupon non più valido")
    # Un coupon intestato vale SOLO per la sua cliente. Prima `client is None`
    # faceva passare il controllo: su una vendita anonima (il caso più comune al
    # banco) chiunque presentasse il codice di qualcun altro otteneva lo sconto.
    if coupon.client_id and (client is None or coupon.client_id != client.id):
        raise HttpError(422, "Coupon riservato a un altro cliente: intestalo alla vendita")
    return coupon


def coupon_discount(coupon, base) -> Decimal:
    """Sconto in euro che il coupon vale su un imponibile di `base`.

    Mai più dell'imponibile: un buono da 50 € su un conto da 30 sconta 30, non
    trasforma la cassa in un bancomat. Tutto in Decimal, come il resto del
    denaro: con i float un 33% su 89,90 arrivava a cifre che non si scrivono su
    uno scontrino.
    """
    base = Decimal(str(base or 0))
    if base <= 0:
        return Decimal("0.00")
    value = Decimal(str(coupon.value))
    if coupon.kind == Coupon.Kind.PERCENT:
        value = base * value / Decimal(100)
    return min(value, base).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def mark_coupon_redeemed(coupon, sale) -> bool:
    """Consuma il coupon legandolo alla vendita; False se qualcuno l'ha già usato.

    Una sola UPDATE filtrata su status='active': è il database a decidere chi
    arriva primo, come nell'endpoint di riscatto. Con il leggi-poi-scrivi, due
    banchi che battono lo stesso codice nello stesso istante lo troverebbero
    attivo entrambi e lo scalerebbero due volte.
    """
    return bool(
        Coupon.objects.filter(pk=coupon.pk, status=Coupon.Status.ACTIVE).update(
            status=Coupon.Status.REDEEMED, redeemed_at=timezone.now(), sale=sale
        )
    )


# ---- Comunicazioni -----------------------------------------------------------

SEND_EVENT = "communication.send"
# Annulla presso Yourang invii che potrebbe avere già in mano: payload
# {communication_id, outbox_event_ids}. Gli id sono quelli degli eventi
# `communication.send` consegnati, che Yourang ha ricevuto come `id` e come
# Idempotency-Key «outbox-<id>»: annullarli due volte non cambia niente.
CANCEL_EVENT = "communication.cancel"
# Consenso marketing cambiato: {client_id, phone, lang, marketing}. Con
# marketing=false Yourang toglie la cliente anche dagli invii che ha già.
CONSENT_EVENT = "client.marketing_consent"


def _scheduled_ahead(value, now) -> bool:
    """La data programmata scritta nel payload è ancora da venire?"""
    if not value:
        return False  # invio immediato: è già partito, non c'è niente da fermare
    try:
        when = datetime.fromisoformat(str(value))
    except ValueError:
        return True  # illeggibile: meglio un annullamento inutile che un invio in più
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    return when > now


def cancel_pending_send(comm: Communication) -> int:
    """Ferma l'invio di questa comunicazione che non è ancora partito.

    Una programmata ora resta TRATTENUTA in outbox fino alla sua data (vedi
    send_communication): modificarla, riprogrammarla o eliminarla la marca
    «superseded» e non partirà mai. Prima l'evento usciva subito, il worker lo
    consegnava in pochi secondi e questa pulizia — che guardava solo i
    `pending` — non trovava più niente: dopo «Modifica per riprogrammare» ogni
    cliente riceveva due messaggi, il primo col refuso, e una campagna
    eliminata partiva lo stesso (07-02).

    Quello che Yourang può avere già ricevuto — consegnato prima di questa
    correzione, preso in carico da un worker proprio adesso, o tentato e forse
    arrivato con la risposta persa — non si richiama dalla coda: per quello si
    accoda un `communication.cancel` con gli id da annullare, se la data non è
    ancora passata. Un evento già annullato non si annulla una seconda volta.

    Ritorna quanti invii sono stati fermati o annullati.
    """
    OutboxEvent = django_apps.get_model("core", "OutboxEvent")  # lazy: evita cicli
    sends = list(
        OutboxEvent.objects.filter(
            salon=comm.salon, event_type=SEND_EVENT, payload__communication_id=comm.id
        ).exclude(status=OutboxEvent.Status.SUPERSEDED)
    )
    if not sends:
        return 0
    supersede_events([e for e in sends if e.status == OutboxEvent.Status.PENDING])
    # Riletti dopo l'UPDATE: chi un worker ha preso in carico nel frattempo
    # resta vivo, ed è in volo.
    alive = set(
        OutboxEvent.objects.filter(pk__in=[e.pk for e in sends])
        .exclude(status=OutboxEvent.Status.SUPERSEDED)
        .values_list("pk", flat=True)
    )
    stopped = {e.pk for e in sends if e.pk not in alive}
    already = set()
    for cancel in OutboxEvent.objects.filter(
        salon=comm.salon, event_type=CANCEL_EVENT, payload__communication_id=comm.id
    ).exclude(status=OutboxEvent.Status.SUPERSEDED):
        already.update(cancel.payload.get("outbox_event_ids") or [])
    now = timezone.now()
    reached = [
        e.pk
        for e in sends
        if (e.pk in alive or e.attempts > 0)
        and e.pk not in already
        and _scheduled_ahead((e.payload or {}).get("scheduled_at"), now)
    ]
    if reached:
        emit_event(
            comm.salon,
            CANCEL_EVENT,
            {"communication_id": comm.id, "outbox_event_ids": reached},
        )
    return len(stopped | set(reached))


def settle_due_communications(salon, now=None) -> int:
    """Le programmate con la data passata diventano «inviate».

    Alla data l'evento parte (o è appena partito): restare «Programmata» per
    sempre lasciava la campagna modificabile e rinviabile anche dopo l'invio.
    `sent_at` è la data programmata, e `scheduled_at` si svuota come per
    l'invio immediato, perché l'interfaccia non creda che parta un'altra volta.
    """
    now = now or timezone.now()
    return Communication.objects.filter(
        salon=salon, status=Communication.Status.SCHEDULED, scheduled_at__lte=now
    ).update(
        status=Communication.Status.SENT, sent_at=F("scheduled_at"), scheduled_at=None
    )


def drop_from_pending_sends(client) -> int:
    """Toglie la cliente dagli invii marketing non ancora consegnati (07-03).

    I destinatari si fissano quando si preme «Programma»: la cliente che
    revocava il consenso il martedì riceveva comunque il sabato la promozione
    programmata il lunedì (GDPR art. 7.3). Si riscrivono solo gli eventi mai
    tentati; uno già tentato può essere arrivato, e per quello c'è
    CONSENT_EVENT. Ritorna quanti invii sono stati toccati.
    """
    OutboxEvent = django_apps.get_model("core", "OutboxEvent")  # lazy: evita cicli
    touched = 0
    with transaction.atomic():
        # Sotto lock: il worker che prende in carico l'evento aspetta la
        # riscrittura, oppure l'ha già preso e qui non compare più.
        events = OutboxEvent.objects.select_for_update().filter(
            salon_id=client.salon_id,
            event_type=SEND_EVENT,
            status=OutboxEvent.Status.PENDING,
            attempts=0,
        )
        for event in events:
            payload = dict(event.payload or {})
            ids = payload.get("client_ids") or []
            if client.id not in ids:
                continue
            payload["client_ids"] = [cid for cid in ids if cid != client.id]
            langs = dict(payload.get("langs") or {})
            langs.pop(str(client.id), None)
            payload["langs"] = langs
            event.payload = payload
            event.save(update_fields=["payload"])
            touched += 1
    return touched


def marketing_consent_changed(client, accepted: bool) -> None:
    """Da chiamare dopo aver salvato il consenso marketing di una cliente.

    La revoca vale anche per ciò che è già in coda: la cliente esce dagli invii
    non ancora partiti, e Yourang riceve CONSENT_EVENT per quelli che ha già in
    mano. Anche il consenso ridato si notifica, così Yourang toglie il blocco.
    """
    if not accepted:
        drop_from_pending_sends(client)
    emit_event(
        client.salon,
        CONSENT_EVENT,
        {
            "client_id": client.id,
            "phone": client.phone,
            "lang": client.lang,
            "marketing": bool(accepted),
        },
    )


def send_communication(comm: Communication, *, scheduled_at=_UNSET, actor=None):
    """Risolve l'audience in client ids (consents.marketing=True) ed emette
    `communication.send`.

    Programmata: l'evento resta TRATTENUTO in outbox fino a `scheduled_at`
    (next_attempt_at) e parte alla data, con scheduled_at nel payload. Finché è
    in coda modifica ed eliminazione lo fermano davvero (cancel_pending_send);
    prima usciva subito e da lì in poi nessuno lo richiamava più.

    `scheduled_at` omesso significa «usa la data salvata sulla comunicazione»;
    `scheduled_at=None` esplicito significa «invia adesso»."""
    salon = comm.salon
    Client = django_apps.get_model("clients", "Client")  # lazy: evita cicli

    if scheduled_at is _UNSET:
        scheduled_at = comm.scheduled_at
    now = timezone.now()
    if scheduled_at and timezone.is_naive(scheduled_at):
        scheduled_at = timezone.make_aware(scheduled_at)
    # Una bozza con una data vecchia diventava «Programmata» per sempre con la
    # data nel passato, e cosa facesse Yourang con un invio già scaduto non lo
    # sapeva nessuno (07-14).
    if scheduled_at and scheduled_at <= now:
        raise HttpError(
            422, "La data di invio è già passata: scegline una futura oppure invia subito"
        )

    # Solo chi ha il consenso marketing ATTIVO adesso: la revoca (GDPR art. 7.3)
    # si scrive sullo stesso campo, quindi chi l'ha ritirato sparisce da qui.
    audience_ids = [int(x) for x in (comm.audience or [])]
    qs = Client.objects.filter(salon=salon, is_active=True, consents__marketing=True)
    if comm.audience_type == Communication.AudienceType.LABELS:
        qs = qs.filter(categories__id__in=audience_ids).distinct()
    else:
        qs = qs.filter(id__in=audience_ids)
    clients = list(qs.order_by("id"))

    payload = {
        "communication_id": comm.id,
        "title": comm.title,
        "body": comm.body,
        "image_url": comm.image.url if comm.image else None,
        "cta_label": comm.cta_label,
        "cta_url": comm.cta_url,
        "client_ids": [c.id for c in clients],
        "langs": {str(c.id): c.lang for c in clients},
    }

    # Un invio nuovo sostituisce quello eventualmente ancora in coda: mai due
    # eventi vivi per la stessa comunicazione.
    cancel_pending_send(comm)
    delay = 0
    if scheduled_at:
        comm.status = Communication.Status.SCHEDULED
        comm.scheduled_at = scheduled_at
        payload["scheduled_at"] = scheduled_at.isoformat()
        # Per eccesso: l'evento non deve diventare consegnabile prima della data.
        delay = math.ceil((scheduled_at - now).total_seconds())
        summary = f"Comunicazione «{comm.title}» programmata ({len(clients)} destinatari)"
    else:
        comm.status = Communication.Status.SENT
        comm.sent_at = timezone.now()
        # Inviata adesso: la data programmata non vale più, lasciarla scritta
        # farebbe credere all'interfaccia che parta una seconda volta.
        comm.scheduled_at = None
        summary = f"Comunicazione «{comm.title}» inviata a {len(clients)} clienti"
    comm.save(update_fields=["status", "scheduled_at", "sent_at"])

    emit_event(
        salon,
        SEND_EVENT,
        payload,
        delay_seconds=delay,
        coalesce_key=f"communication:{comm.id}",
    )
    log_activity(
        salon,
        "communication.send",
        summary,
        actor=actor,
        payload={"communication_id": comm.id, "recipients": len(clients)},
    )
    return comm
