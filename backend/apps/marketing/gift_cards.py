"""Gift card: emissione e riscatto, vendita e incasso al banco, KPI degli elenchi.

Emissione e riscatto stavano in services.py; la vendita dallo staff e
l'incasso della carta comprata dall'app — con la vendita che porta il denaro
in cassa — e le regole dei KPI stavano dentro gli endpoint di api.py.
`create_gift_card` e `redeem_gift_card` li chiama anche la cassa
(apps.sales.services, import pigro): le firme NON vanno cambiate.

Una carta può essere un regalo, un trattamento già pagato dalla cliente o le
sedute di un pacchetto (`GiftCard.kind`); `has_remaining_q` dice quali hanno
ancora qualcosa da dare, saldo o sedute (agenda, caparra, portafoglio).
"""

from decimal import Decimal

from django.db import transaction
from django.db.models import DecimalField, F, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity
from apps.sales.models import Payment
from common.money import MAX_MONEY

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

# Sedute massime su una carta: un abbonamento annuale settimanale ci sta.
MAX_SESSIONS = 100

_ZERO = Value(Decimal("0"), output_field=DecimalField(max_digits=12, decimal_places=2))


def _require_payment_method(method: str) -> None:
    """422 se il metodo d'incasso di una carta non è uno di quelli della cassa.

    Passava qualunque stringa: una più lunga della colonna (20 caratteri)
    arrivava al database e PostgreSQL rifiutava la riga, con un 500; una corta
    ma inventata («bonifico») restava sulla carta mentre in cassa il pagamento
    diventava «other». Vuoto vuol dire «non indicato», come prima: in cassa
    resta «other» (vedi `record_gift_card_cashed`).
    """
    if method and method not in Payment.Method.values:
        raise HttpError(422, "Metodo di pagamento non valido")


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
    kind=GiftCard.Kind.GIFT,
    sessions=1,
    package=None,
    package_line=None,
    expires_at=None,
):
    """Crea una gift card (usata anche da sales per le righe gift_card vendute).

    Se `gift_service` è valorizzato la carta regala quel trattamento: il valore
    passato deve già coincidere col prezzo del servizio (garantito dal chiamante).
    Con `sessions` > 1 la carta copre più sedute di quel trattamento (pacchetto
    o trattamenti pagati in anticipo): `value` è il prezzo di TUTTE le sedute.

    `kind` dice come la si legge in agenda e in cassa: regalo, già pagato dalla
    cliente stessa, sedute di un pacchetto (`package`, `package_line`).

    `cash_in=False` per le carte che nascono già pagate ma senza che nessuno
    abbia versato denaro (i premi fedeltà): la carta resta spendibile, ma nel
    registro attività non compare un incasso che non c'è stato."""
    value = Decimal(value)
    # Zero solo per un trattamento (pacchetto o seduta in omaggio): una carta a
    # importo da zero euro non serve a niente. Oltre MAX_MONEY il valore non
    # entra nella colonna: la carta venduta dallo staff non aveva tetto, e un
    # miliardo diventava un 500 di PostgreSQL invece di un errore.
    if value < 0 or value > MAX_MONEY or (value == 0 and gift_service is None):
        raise HttpError(422, "Valore della gift card non valido")
    if kind not in GiftCard.Kind.values:
        raise HttpError(422, "Tipo di gift card non valido")
    try:
        sessions = int(sessions or 1)
    except (TypeError, ValueError):
        raise HttpError(422, "Numero di sedute non valido") from None
    if sessions < 1 or sessions > MAX_SESSIONS:
        raise HttpError(422, "Numero di sedute non valido")
    if sessions > 1 and gift_service is None:
        # Le sedute contano un trattamento: una carta a importo non ne ha.
        raise HttpError(422, "Le sedute si indicano solo per un trattamento")
    card = GiftCard.objects.create(
        salon=salon,
        kind=kind,
        code=unique_code(GiftCard, salon, GIFT_CARD_CODE_LENGTH),
        initial_value=value,
        balance=value,
        gift_service=gift_service,
        sessions_total=sessions,
        sessions_left=sessions,
        package=package,
        package_line=package_line,
        buyer_client=buyer_client,
        recipient_client=recipient_client,
        recipient_name=recipient_name,
        payment_status=GiftCard.PaymentStatus.PAID if paid else GiftCard.PaymentStatus.UNPAID,
        paid_at=timezone.now() if paid else None,
        paid_method=paid_method if paid else "",
        expires_at=expires_at,
    )
    log_activity(
        salon,
        "giftcard.created",
        _created_summary(card),
        actor=sold_by,
        payload={
            "gift_card_id": card.id,
            "code": card.code,
            "value": str(card.initial_value),
            "paid": paid,
            "sale_id": sale.id if sale else None,
            "kind": card.kind,
            "sessions": card.sessions_total,
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


def _created_summary(card) -> str:
    """La riga del registro attività per una carta appena creata, secondo il tipo.

    Una carta di sedute di un pacchetto o un trattamento pagato in anticipo
    scritti «Gift card … da €…» si confondevano nel registro con i regali.
    """
    what = f"€{card.initial_value}"
    if card.gift_service_id:
        sessions = f" ×{card.sessions_total}" if card.sessions_total > 1 else ""
        what = f"{card.gift_service.name_it}{sessions} (€{card.initial_value})"
    if card.kind == GiftCard.Kind.PACKAGE:
        name = f" «{card.package.name}»" if card.package_id else ""
        return f"Pacchetto{name} {card.code}: {what}"
    if card.kind == GiftCard.Kind.PREPAID:
        return f"Già pagato {card.code}: {what}"
    return f"Gift card {card.code} da €{card.initial_value}"


def has_remaining_q() -> Q:
    """Carte che hanno ancora qualcosa da dare: saldo, oppure sedute di un trattamento.

    Un pacchetto in omaggio ha saldo zero dall'inizio, e una carta a sedute di
    cui la cassa ha già scalato tutto il saldo ha ancora le sedute pagate: con
    il solo «saldo > 0» sparivano dall'agenda e dal portafoglio, e la caparra
    si chiedeva su trattamenti che la cliente non pagherà. Lo stato (attiva,
    pagata, non scaduta) lo filtra chi chiama.
    """
    return Q(balance__gt=0) | Q(gift_service__isnull=False, sessions_left__gt=0)


def has_remaining(card) -> bool:
    """La stessa regola di `has_remaining_q`, su una carta già letta."""
    return card.balance > 0 or bool(card.gift_service_id and card.sessions_left > 0)


def _counts_sessions(card) -> bool:
    """Vero per le carte a trattamento con più sedute: lì il riscatto conta le sedute."""
    return bool(card.gift_service_id) and (card.sessions_total or 1) > 1


def redeem_gift_card(salon, code, amount, sessions=1):
    """Scala `amount` dal saldo della gift card `code`. Ritorna la card aggiornata.

    Sulle carte a più sedute (`gift_service` e `sessions_total` > 1) toglie
    anche `sessions` sedute: una per ogni riga del servizio coperta in questo
    conto. All'ultima seduta il saldo va a zero anche se `amount` è minore (le
    sedute erano pagate per intero: il resto non diventa denaro spendibile) e
    la carta è esaurita. Le carte a una seduta restano com'erano: si scala
    l'importo, e il residuo resta spendibile finché non arriva a zero.
    """
    amount = Decimal(amount)
    # Zero vale solo per una seduta di un trattamento regalato o in omaggio:
    # su una carta a importo non scalerebbe niente (controllo sotto).
    if amount < 0:
        raise HttpError(422, "Importo da scalare non valido")
    try:
        sessions = int(sessions or 1)
    except (TypeError, ValueError):
        raise HttpError(422, "Numero di sedute non valido") from None
    if sessions < 1:
        raise HttpError(422, "Numero di sedute non valido")
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
        elif amount == 0 and not card.gift_service_id:
            error = HttpError(422, "Importo da scalare non valido")
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
        elif _counts_sessions(card) and card.sessions_left < sessions:
            error = HttpError(422, f"Sedute insufficienti (ne restano {card.sessions_left})")
    if error is not None:
        raise error
    with transaction.atomic():
        card = GiftCard.objects.select_for_update().get(pk=card.pk)
        if card.balance < amount:
            raise HttpError(422, f"Saldo gift card insufficiente (residuo €{card.balance})")
        fields = ["balance", "status", "sessions_left"]
        card.balance -= amount
        if _counts_sessions(card):
            # A sedute la carta finisce con l'ultima seduta, non col saldo: un
            # pacchetto in omaggio ha saldo zero dall'inizio.
            if card.sessions_left < sessions:
                raise HttpError(422, f"Sedute insufficienti (ne restano {card.sessions_left})")
            card.sessions_left -= sessions
            if card.sessions_left == 0:
                card.balance = Decimal("0.00")
                card.status = GiftCard.Status.REDEEMED
        elif card.balance == 0:
            card.status = GiftCard.Status.REDEEMED
            card.sessions_left = 0
        card.save(update_fields=fields)
        log_activity(
            salon,
            "giftcard.redeemed",
            f"Gift card {card.code}: scalati €{amount} (residuo €{card.balance})",
            payload={
                "gift_card_id": card.id,
                "code": card.code,
                "amount": str(amount),
                "balance": str(card.balance),
                "sessions_left": card.sessions_left,
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


def _staff_sessions(sessions, gift_service) -> int:
    """Le sedute chieste dallo staff: un intero fra 1 e MAX_SESSIONS, e solo per un trattamento.

    `create_gift_card` legge 0 come «una seduta» (lo usa la cassa, che non le
    indica): dalla maschera uno 0 è un errore da dire, non una seduta in regalo.
    """
    if isinstance(sessions, bool) or not isinstance(sessions, int):
        raise HttpError(422, "Numero di sedute non valido")
    if not 1 <= sessions <= MAX_SESSIONS:
        raise HttpError(422, f"Le sedute vanno da 1 a {MAX_SESSIONS}")
    if sessions > 1 and gift_service is None:
        raise HttpError(422, "Le sedute si indicano solo per un trattamento")
    return sessions


def _prepaid_owner(buyer, recipient):
    """(acquirente, destinataria, nome) di un trattamento già pagato: la stessa cliente.

    «Già pagato» è il trattamento che la cliente paga oggi e farà più avanti:
    non c'è nessuno che regala. Con due schede diverse sarebbe un regalo
    dall'una all'altra, e per quello c'è «Regalo»: in agenda e in cassa i due
    casi si leggono diversi. Basta indicarne una delle due.
    """
    owner = recipient or buyer
    if owner is None:
        raise HttpError(422, "Un trattamento già pagato va intestato a una cliente")
    if buyer is not None and recipient is not None and buyer.pk != recipient.pk:
        raise HttpError(422, "Già pagato: chi paga e chi fa il trattamento sono la stessa cliente")
    return owner, owner, owner.full_name[:120]


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
    kind=GiftCard.Kind.GIFT,
    sessions=1,
) -> GiftCard:
    """Carta venduta dallo staff: pagata subito (con la sua vendita in cassa) o da pagare.

    `kind` è «gift» (un regalo) o «prepaid» (un trattamento che la cliente paga
    oggi e farà più avanti: acquirente e destinataria sono lei). Le sedute di un
    pacchetto nascono solo vendendo il pacchetto in cassa (`credits`), con la
    sua riga di vendita: qui si rifiutano.

    Con `gift_service` il valore è il prezzo di listino per `sessions` sedute
    (tre pieghe da 25 € = 75 €) e quello inviato si ignora: la carta vale
    esattamente i trattamenti che promette.
    """
    if kind == GiftCard.Kind.PACKAGE:
        raise HttpError(422, "Le sedute di un pacchetto nascono vendendo il pacchetto in cassa")
    if kind not in GiftCard.Kind.values:
        raise HttpError(422, "Tipo di gift card non valido")
    sessions = _staff_sessions(sessions, gift_service)
    if gift_service is not None:
        value = Decimal(gift_service.price) * sessions
    if kind == GiftCard.Kind.PREPAID:
        buyer, recipient, recipient_name = _prepaid_owner(buyer, recipient)
    if paid:
        _require_payment_method(paid_method)
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
            kind=kind,
            sessions=sessions,
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
    _require_payment_method(method)
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
