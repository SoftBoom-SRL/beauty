"""Gift card: emissione e riscatto, vendita e incasso al banco, KPI degli elenchi.

Emissione e riscatto stavano in services.py; la vendita dallo staff e
l'incasso della carta comprata dall'app — con la vendita che porta il denaro
in cassa — e le regole dei KPI stavano dentro gli endpoint di api.py.
`create_gift_card` e `redeem_gift_card` li chiama anche la cassa
(apps.sales.services, import pigro): le firme NON vanno cambiate.
"""

from decimal import Decimal

from django.db import transaction
from django.db.models import DecimalField, F, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity

from .codes import GIFT_CARD_CODE_LENGTH, mark_expired_if_past, not_expired_q, unique_code
from .models import GiftCard

# Metodo di pagamento delle carte che il programma fedeltà regala come premio:
# nascono «pagate» ma nessuno le ha pagate. Non sono ricavi (KPI «Venduto») e
# spenderle non fa guadagnare altri punti.
LOYALTY_PAID_METHOD = "loyalty"

# Una gift card comprata dall'app è un impegno che il salone dovrà onorare: il
# tetto è quello che una cliente può ragionevolmente regalare. Senza, un POST
# con value=99999999.99 creava una carta da cento milioni che entrava nei KPI
# del salone, e in ciclo riempiva la tabella.
CLIENT_GIFT_CARD_MIN = Decimal("5")
CLIENT_GIFT_CARD_MAX = Decimal("1000")
CLIENT_GIFT_CARD_PER_DAY = 5

_ZERO = Value(Decimal("0"), output_field=DecimalField(max_digits=12, decimal_places=2))


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
        code=unique_code(GiftCard, salon, GIFT_CARD_CODE_LENGTH),
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
    # conto suo (vedi il portafoglio della cliente e `gift_card_kpis`).
    error = None
    with transaction.atomic():
        card = (
            GiftCard.objects.select_for_update().filter(salon=salon, code=code).first()
        )
        if card is None:
            error = HttpError(404, "Gift card non trovata")
        elif card.status != GiftCard.Status.ACTIVE:
            error = HttpError(422, "Gift card non attiva")
        elif mark_expired_if_past(card):
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


def gift_card_kpis(qs) -> dict:
    """I KPI dell'elenco, sulle carte filtrate: {sold_total, redeemed_total, outstanding}."""
    # «Venduto» è il denaro davvero incassato: le carte ancora da pagare non
    # sono ricavi, e i premi fedeltà (paid_method="loyalty") non li ha pagati
    # nessuno — contarli gonfiava il KPI di soldi mai entrati in cassa.
    sold = Q(payment_status=GiftCard.PaymentStatus.PAID) & ~Q(paid_method=LOYALTY_PAID_METHOD)
    # «Da spendere» è il credito che il salone deve ancora onorare: solo carte
    # attive, pagate e non scadute.
    spendable = (
        Q(status=GiftCard.Status.ACTIVE)
        & Q(payment_status=GiftCard.PaymentStatus.PAID)
        & not_expired_q(timezone.now())
    )
    return qs.aggregate(
        sold_total=Coalesce(Sum("initial_value", filter=sold), _ZERO),
        redeemed_total=Coalesce(
            Sum(
                F("initial_value") - F("balance"),
                output_field=DecimalField(max_digits=12, decimal_places=2),
            ),
            _ZERO,
        ),
        outstanding=Coalesce(Sum("balance", filter=spendable), _ZERO),
    )


def sell_gift_card(
    salon,
    value,
    *,
    gift_service=None,
    buyer=None,
    recipient=None,
    recipient_name="",
    paid=False,
    paid_method="",
    delivery_date=None,
    expires_at=None,
    actor=None,
) -> GiftCard:
    """Carta venduta dallo staff: pagata subito (con la sua vendita in cassa) o da pagare."""
    # Carta e incasso nascono insieme o non nascono: una carta «pagata» senza la
    # sua vendita è esattamente il buco che stiamo chiudendo.
    with transaction.atomic():
        card = create_gift_card(
            salon,
            value,
            gift_service=gift_service,
            buyer_client=buyer,
            recipient_client=recipient,
            recipient_name=recipient_name,
            paid=paid,
            paid_method=paid_method,
            sold_by=actor,
        )
        extra = []
        if delivery_date:
            card.delivery_date = delivery_date
            extra.append("delivery_date")
        if expires_at:
            card.expires_at = expires_at
            extra.append("expires_at")
        if extra:
            card.save(update_fields=extra)
        if paid:
            # «Vendo e segno pagata subito» è il caso normale al banco (la
            # maschera manda paid=true di default), ma nasceva una carta
            # payment_status=paid senza nessuna vendita a registro: quei soldi
            # non comparivano nei ricavi né nel riepilogo di giornata, e al
            # riscatto venivano perfino sottratti dall'incasso. La carta faceva
            # SPARIRE il suo valore dai conti invece di aggiungerlo, e non c'era
            # modo di rimediare dopo (mark-paid rispondeva «già pagata»).
            # record_gift_card_cashed si difende da sola dal doppio conteggio.
            from apps.sales.services import record_gift_card_cashed  # lazy

            record_gift_card_cashed(salon, card, method=paid_method, actor=actor)
    return card


def cash_gift_card(salon, card, *, method: str, actor=None) -> GiftCard:
    """Incasso al banco di una carta «da pagare» (comprata dall'app): pagata e in cassa."""
    # La marcatura «scaduta» si scrive FUORI dalla transazione dell'incasso: se
    # stesse dentro, il rollback provocato dall'errore se la porterebbe via.
    if mark_expired_if_past(card):
        raise HttpError(422, "Gift card scaduta: non può essere incassata")
    # Tutto l'incasso sta in una transazione con la riga bloccata: il doppio clic
    # su «Segna come pagata» trovava la carta ancora da pagare in entrambe le
    # richieste e registrava due vendite (e due pagamenti) per gli stessi soldi.
    from apps.sales.services import record_gift_card_cashed  # lazy

    with transaction.atomic():
        card = GiftCard.objects.select_for_update().get(pk=card.pk)
        if card.payment_status == GiftCard.PaymentStatus.PAID:
            raise HttpError(422, "Gift card già pagata")
        # Una carta annullata o scaduta non si incassa: il salone prenderebbe soldi
        # per un credito che non è più spendibile.
        if card.status != GiftCard.Status.ACTIVE:
            raise HttpError(422, "Gift card non attiva: non può essere incassata")
        card.payment_status = GiftCard.PaymentStatus.PAID
        card.paid_at = timezone.now()
        card.paid_method = method
        card.save(update_fields=["payment_status", "paid_at", "paid_method"])
        # L'incasso diventa una vendita, altrimenti il denaro non entra nei ricavi
        # e al riscatto viene addirittura sottratto.
        record_gift_card_cashed(salon, card, method=method, actor=actor)
    log_activity(
        salon,
        "giftcard.paid",
        f"Incasso gift card {card.code}: €{card.initial_value} ({method})",
        actor=actor,
        payload={"gift_card_id": card.id, "amount": str(card.initial_value), "method": method},
    )
    return card
