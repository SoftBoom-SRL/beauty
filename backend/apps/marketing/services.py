"""Servizi marketing: gift card, coupon, fedeltà, comunicazioni.

`create_gift_card`, `redeem_gift_card`, `accrue_loyalty` e `validate_coupon`
sono API interne chiamate anche da apps.sales.finalize_sale (import lazy lato sales):
le firme NON vanno cambiate.
"""

import math
from decimal import Decimal

from django.apps import apps as django_apps
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import emit_event, log_activity
from common.utils import human_code

from .models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram


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
):
    """Crea una gift card (usata anche da sales per le righe gift_card vendute).

    Se `gift_service` è valorizzato la carta regala quel trattamento: il valore
    passato deve già coincidere col prezzo del servizio (garantito dal chiamante)."""
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
    if paid:
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
        if service is None:
            return None
        card = create_gift_card(
            salon,
            Decimal(str(service.price)),
            gift_service=service,
            recipient_client=client,
            recipient_name=client.full_name,
            paid=True,
            paid_method="loyalty",
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
        )
        return {
            "label": f"gift card {card.code} (€{value})",
            "event": {"gift_card_id": card.id, "gift_card_code": card.code},
        }

    return None


def accrue_loyalty(sale):
    """Accredita punti per la vendita su ogni programma attivo; alla soglia genera
    un Coupon origin=loyalty ed emette `loyalty.reward`. No-op se la vendita è anonima."""
    client = sale.client
    if client is None:
        return
    salon = sale.salon
    for program in LoyaltyProgram.objects.filter(salon=salon, active=True):
        account = LoyaltyAccount.objects.filter(program=program, client=client).first()
        if account is None:
            if program.enrollment != LoyaltyProgram.Enrollment.AUTO:
                continue  # iscrizione su richiesta/a pagamento: nessun auto-enroll
            account = LoyaltyAccount.objects.create(program=program, client=client)

        if program.earn_metric == LoyaltyProgram.EarnMetric.PER_EURO:
            # Le gift card vendute non danno punti: li darà la spesa fatta con
            # la carta. Contarle qui significava pagare due volte lo stesso
            # denaro, una all'acquisto e una al riscatto.
            gift_card_sold = sale.lines.filter(line_type="gift_card").aggregate(
                total=Sum("amount")
            )["total"] or Decimal("0")
            base = Decimal(sale.total) - Decimal(gift_card_sold)
            earned = math.floor(base * program.earn_ratio) if base > 0 else 0
        elif program.earn_metric == LoyaltyProgram.EarnMetric.PER_VISIT:
            earned = math.floor(program.earn_ratio)
        else:  # per_service
            n_services = sale.lines.filter(line_type="service").count()
            earned = math.floor(program.earn_ratio * n_services)
        if earned <= 0:
            continue

        account.points += earned
        while program.threshold > 0 and account.points >= program.threshold:
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
            account.points -= program.threshold
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
        account.save(update_fields=["points"])


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
    if coupon.client_id and client is not None and coupon.client_id != client.id:
        raise HttpError(422, "Coupon riservato a un altro cliente")
    return coupon


# ---- Comunicazioni -----------------------------------------------------------


def send_communication(comm: Communication, *, scheduled_at=None, actor=None):
    """Risolve l'audience in client ids (consents.marketing=True) ed emette
    `communication.send`. Se programmata l'evento esce SUBITO con scheduled_at
    nel payload: l'invio alla data è demandato a Yourang."""
    salon = comm.salon
    Client = django_apps.get_model("clients", "Client")  # lazy: evita cicli

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

    scheduled_at = scheduled_at or comm.scheduled_at
    if scheduled_at:
        comm.status = Communication.Status.SCHEDULED
        comm.scheduled_at = scheduled_at
        payload["scheduled_at"] = scheduled_at.isoformat()
        summary = f"Comunicazione «{comm.title}» programmata ({len(clients)} destinatari)"
    else:
        comm.status = Communication.Status.SENT
        comm.sent_at = timezone.now()
        summary = f"Comunicazione «{comm.title}» inviata a {len(clients)} clienti"
    comm.save(update_fields=["status", "scheduled_at", "sent_at"])

    emit_event(salon, "communication.send", payload)
    log_activity(
        salon,
        "communication.send",
        summary,
        actor=actor,
        payload={"communication_id": comm.id, "recipients": len(clients)},
    )
    return comm
