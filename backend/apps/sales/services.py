"""Scritture delle vendite: `finalize_sale` condiviso da checkout e POS, e le vendite di
una riga per il denaro incassato fuori dal conto (gift card, caparra, no-show).

In sales è l'unico modulo che scrive Sale, SaleLine e Payment: il riepilogo di
giornata e lo storico stanno in reports.py, la cassa delle caparre in deposits.py.

Le integrazioni cross-app (magazzino, gift card, fedeltà) sono importate lazy
dentro le funzioni, come da convenzione SPEC §1: le firme di riferimento sono

    inventory.services.deduct_stock_for_sale(sale)
    marketing.services.redeem_gift_card(salon, code, amount)
    marketing.services.create_gift_card(salon, value, *, buyer_client=None,
        recipient_name="", paid=False, paid_method="", sold_by=None, sale=None)
    marketing.services.accrue_loyalty(sale)
"""

from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.money import CENT

# compat refactoring: rimuovere dopo l'integrazione — l'agenda chiama queste
# tre funzioni come `apps.sales.services.<nome>`, anche con `getattr(...,
# None)`: un nome che manca qui spegnerebbe in silenzio la cassa delle caparre.
# Vivono in deposits.py, che non importa services in testa: niente ciclo.
from .deposits import deposit_retained, settle_deposit_excess, sync_deposit_refunds  # noqa: F401
from .models import Payment, Sale, SaleLine

# Scarto ammesso fra pagamenti e dovuto: vale un centesimo come `CENT`, ma è
# una tolleranza, non un arrotondamento.
PAYMENT_TOLERANCE = Decimal("0.01")
# Tetti di sanità su una riga di vendita: un errore di battitura (o una
# richiesta costruita a mano) non deve poter scrivere a registro una cifra
# che poi va corretta a mano in tutti i conteggi.
MAX_QTY = 999
MAX_UNIT_PRICE = Decimal("100000.00")


def line_amount(qty, unit_price, discount_pct: int = 0, is_gift: bool = False) -> Decimal:
    """Importo riga: qty × unit_price × (1 − discount/100); 0 se omaggio."""
    if is_gift:
        return Decimal("0.00")
    gross = Decimal(qty) * Decimal(str(unit_price))
    if discount_pct:
        gross = gross * (Decimal(100) - Decimal(discount_pct)) / Decimal(100)
    return gross.quantize(CENT, rounding=ROUND_HALF_UP)


def _prepare_lines(blocks: list[dict]) -> tuple[list[dict], Decimal]:
    """Normalizza i blocchi {operator_id, lines} in righe piatte e calcola il totale."""
    prepared: list[dict] = []
    total = Decimal("0.00")
    for block in blocks:
        operator_id = block.get("operator_id")
        for raw in block.get("lines") or []:
            line_type = raw.get("line_type")
            if line_type not in SaleLine.LineType.values:
                raise HttpError(422, "Tipo di riga non valido")
            unit_price = raw.get("unit_price")
            # vendita gift card dal POS: il valore della card è il prezzo unitario
            if line_type == SaleLine.LineType.GIFT_CARD and raw.get("value") is not None:
                unit_price = raw["value"]
            if unit_price is None:
                raise HttpError(422, "Prezzo mancante su una riga di vendita")
            if Decimal(str(unit_price)) < 0:
                raise HttpError(422, "Prezzo negativo su una riga di vendita")
            if Decimal(str(unit_price)) > MAX_UNIT_PRICE:
                raise HttpError(422, "Prezzo fuori scala su una riga di vendita")
            qty = int(raw.get("qty") or 1)
            if not 1 <= qty <= MAX_QTY:
                raise HttpError(422, "Quantità non valida su una riga di vendita")
            discount_pct = int(raw.get("discount_pct") or 0)
            if not 0 <= discount_pct <= 100:
                raise HttpError(422, "Sconto non valido su una riga di vendita")
            # Una riga prodotto senza prodotto veniva incassata senza scaricare
            # il magazzino: il pezzo usciva dal negozio e restava a giacenza.
            if line_type == SaleLine.LineType.PRODUCT and not raw.get("product_id"):
                raise HttpError(422, "Riga prodotto senza prodotto selezionato")
            # Su una gift card il prezzo È il valore caricato sulla carta: uno
            # sconto emetteva una carta da 100 € incassandone 80, regalando la
            # differenza. Una promozione si fa abbassando il valore.
            if line_type == SaleLine.LineType.GIFT_CARD and discount_pct:
                raise HttpError(
                    422,
                    "Sconto non applicabile a una gift card: indica direttamente il valore",
                )
            is_gift = bool(raw.get("is_gift"))
            amount = line_amount(qty, unit_price, discount_pct, is_gift)
            entry = {
                "operator_id": operator_id,
                "line_type": line_type,
                "service_id": raw.get("service_id"),
                "product_id": raw.get("product_id"),
                "qty": qty,
                "unit_price": Decimal(str(unit_price)).quantize(CENT),
                "discount_pct": discount_pct,
                "is_gift": is_gift,
                "amount": amount,
                "recipient_name": raw.get("recipient_name") or "",
            }
            if line_type == SaleLine.LineType.GIFT_CARD and qty > 1:
                # Una riga per carta: la riga ne può tenere UNA sola, quindi con
                # qty=3 due carte restavano scollegate dalla vendita. Incassate
                # poi da Fedeltà generavano una vendita del loro valore pieno,
                # cioè ricavi mai entrati. Lo sconto sulle gift card è già
                # rifiutato sopra, quindi la somma delle righe resta identica.
                unit_amount = line_amount(1, unit_price, discount_pct, is_gift)
                for _ in range(qty):
                    prepared.append({**entry, "qty": 1, "amount": unit_amount})
                total += unit_amount * qty
                continue
            prepared.append(entry)
            total += amount
    return prepared, total


def _validate_references(salon, prepared: list[dict]) -> None:
    """Servizi, prodotti e operatrici delle righe devono appartenere al salone.

    Senza questo controllo una vendita registrata dal salone A poteva scaricare
    il magazzino di B (e mostrarne i nomi prodotto) indicando gli id giusti.
    """
    from apps.catalog.models import Service  # lazy
    from apps.inventory.models import Product  # lazy
    from apps.staff.models import Operator  # lazy

    checks = (
        (Service, {d["service_id"] for d in prepared if d.get("service_id")}, "Servizio non trovato"),
        (Product, {d["product_id"] for d in prepared if d.get("product_id")}, "Prodotto non trovato"),
        (Operator, {d["operator_id"] for d in prepared if d.get("operator_id")}, "Operatrice non trovata"),
    )
    for model, ids, message in checks:
        if not ids:
            continue
        found = set(model.objects.filter(salon=salon, id__in=ids).values_list("id", flat=True))
        if ids - found:
            raise HttpError(404, message)


def _coupon_for_sale(salon, code: str, client, prepared: list[dict], total: Decimal):
    """Coupon della vendita e sconto in euro; `(None, 0.00)` se non c'è codice.

    Il programma fedeltà emetteva buoni che nessuna cassa sapeva usare: la
    cliente presentava il codice e la cassiera poteva solo scontare a mano, o
    dire di no. Qui il buono entra nel conto.

    Lo sconto si calcola sulle righe che NON sono gift card: scontare una carta
    regalo significa emetterne una da 100 incassandone 80, cioè regalare la
    differenza — la stessa ragione per cui `_prepare_lines` rifiuta lo sconto di
    riga sulle gift card.
    """
    code = (code or "").strip().upper()  # i codici sono tutti maiuscoli (human_code)
    if not code:
        return None, Decimal("0.00")
    from apps.marketing.coupons import coupon_discount, validate_coupon  # lazy

    coupon = validate_coupon(salon, code, client=client)
    gift_cards = sum(
        (d["amount"] for d in prepared if d["line_type"] == SaleLine.LineType.GIFT_CARD),
        Decimal("0.00"),
    )
    base = total - gift_cards
    if base <= 0:
        raise HttpError(422, "Coupon non applicabile alla vendita di una gift card")
    return coupon, coupon_discount(coupon, base)


def _spread_coupon(prepared: list[dict], discount: Decimal) -> None:
    """Ripartisce lo sconto del buono sulle righe, in proporzione al loro importo.

    Le gift card restano fuori, come nel calcolo del buono (`_coupon_for_sale`).
    Ogni quota è arrotondata al centesimo (HALF_UP); la riga più grande prende
    il resto, così la somma delle quote è esattamente lo sconto e le righe
    sommano il totale della vendita. Senza questa ripartizione il fatturato per
    operatrice ignorava il buono: una vendita da 100 con buono da 20 contava
    80 nello storico e 100 all'operatrice (05-18).
    """
    for data in prepared:
        data.setdefault("coupon_share", Decimal("0.00"))
    if discount <= 0:
        return
    eligible = [
        d for d in prepared if d["line_type"] != SaleLine.LineType.GIFT_CARD and d["amount"] > 0
    ]
    base = sum((d["amount"] for d in eligible), Decimal("0.00"))
    if base <= 0:
        return
    ordered = sorted(eligible, key=lambda d: d["amount"])
    remaining = discount
    for data in ordered[:-1]:
        share = min((discount * data["amount"] / base).quantize(CENT, rounding=ROUND_HALF_UP), data["amount"])
        data["coupon_share"] = share
        remaining -= share
    for data in reversed(ordered):  # la più grande assorbe l'arrotondamento
        if remaining <= 0:
            break
        room = data["amount"] - data["coupon_share"]
        extra = min(remaining, room)
        data["coupon_share"] += extra
        remaining -= extra
    for data in eligible:
        data["amount"] -= data["coupon_share"]


def finalize_sale(
    salon,
    *,
    kind: str,
    blocks: list[dict],
    payments: list[dict],
    client=None,
    appointment=None,
    location=None,
    deposit_deducted=Decimal("0.00"),
    coupon_code: str = "",
    actor=None,
) -> Sale:
    """Core condiviso checkout/POS: valida, crea Sale/righe/pagamenti e integra le altre app.

    blocks   = [{"operator_id": int|None, "lines": [{line_type, service_id?, product_id?,
                 qty, unit_price, discount_pct?, is_gift?, value?, recipient_name?}]}]
    payments = [{"method": cash|card|other|gift_card, "amount": Decimal, "gift_card_code"?: str}]
    coupon_code = buono sconto presentato al banco, facoltativo (vedi `_coupon_for_sale`)
    """
    deposit_deducted = Decimal(str(deposit_deducted or 0)).quantize(CENT)
    if deposit_deducted < 0:
        raise HttpError(422, "Acconto detratto non valido")

    prepared, total = _prepare_lines(blocks)
    if not prepared:
        raise HttpError(422, "Nessuna riga di vendita")
    _validate_references(salon, prepared)

    # Il buono si applica PRIMA della caparra: il totale da cui si detrae
    # l'anticipo è quello che la cliente deve davvero.
    coupon, discount = _coupon_for_sale(salon, coupon_code, client, prepared, total)
    total -= discount
    _spread_coupon(prepared, discount)

    # Caparra più grande del conto finale (servizi tolti dopo la prenotazione):
    # si detrae solo fino al totale. Prima il dovuto diventava negativo e la
    # cassa restava bloccata per sempre su «I pagamenti non corrispondono»:
    # nessun flusso restituiva la differenza. L'eccedenza la rimborsa chi
    # chiama, confrontando quanto era detraibile con `sale.deposit_deducted`.
    if deposit_deducted > total:
        deposit_deducted = total

    for payment in payments:
        if payment.get("method") not in Payment.Method.values:
            raise HttpError(422, "Metodo di pagamento non valido")
        if Decimal(str(payment.get("amount") or 0)) < 0:
            raise HttpError(422, "Importo di pagamento negativo")

    paid_total = sum(
        (Decimal(str(p.get("amount") or 0)) for p in payments), Decimal("0.00")
    )
    if abs(paid_total - (total - deposit_deducted)) > PAYMENT_TOLERANCE:
        raise HttpError(422, "I pagamenti non corrispondono al totale")

    first_method = payments[0].get("method", "") if payments else ""

    with transaction.atomic():
        sale = Sale.objects.create(
            salon=salon,
            location=location,
            kind=kind,
            appointment=appointment,
            client=client,
            total=total,
            coupon_discount=discount,
            deposit_deducted=deposit_deducted,
            created_by=actor,
        )
        if coupon is not None:
            from apps.marketing.coupons import mark_coupon_redeemed  # lazy

            # Il buono si consuma DENTRO la transazione della vendita: se qui
            # fallisce (un altro banco l'ha battuto un istante prima) non resta
            # né lo scontrino scontato né il coupon bruciato.
            if not mark_coupon_redeemed(coupon, sale):
                raise HttpError(422, "Coupon non più valido")

        has_products = False
        for data in prepared:
            line = SaleLine.objects.create(
                sale=sale,
                operator_id=data["operator_id"],
                line_type=data["line_type"],
                service_id=data["service_id"],
                product_id=data["product_id"],
                qty=data["qty"],
                unit_price=data["unit_price"],
                discount_pct=data["discount_pct"],
                is_gift=data["is_gift"],
                amount=data["amount"],
                coupon_share=data["coupon_share"],
            )
            if data["line_type"] == SaleLine.LineType.PRODUCT:
                has_products = True
            if data["line_type"] == SaleLine.LineType.GIFT_CARD:
                from apps.marketing.gift_cards import create_gift_card  # lazy

                # Una carta per riga: `_prepare_lines` ha già spezzato le
                # quantità maggiori di uno, così ogni carta emessa ha la sua
                # riga di vendita che la collega.
                card = create_gift_card(
                    salon,
                    data["unit_price"],
                    buyer_client=client,
                    recipient_name=data["recipient_name"],
                    paid=not data["is_gift"],
                    paid_method=first_method,
                    sold_by=actor,
                    sale=sale,
                )
                line.gift_card = card
                line.save(update_fields=["gift_card"])

        for payment in payments:
            amount = Decimal(str(payment.get("amount") or 0)).quantize(CENT)
            card = None
            if payment["method"] == Payment.Method.GIFT_CARD:
                code = (payment.get("gift_card_code") or "").strip()
                if not code:
                    raise HttpError(422, "Codice gift card mancante nel pagamento")
                from apps.marketing.gift_cards import redeem_gift_card  # lazy

                card = redeem_gift_card(salon, code, amount)
            Payment.objects.create(
                sale=sale, method=payment["method"], amount=amount, gift_card=card
            )

        if has_products:
            from apps.inventory.services import deduct_stock_for_sale  # lazy

            deduct_stock_for_sale(sale)

        from apps.marketing.services import accrue_loyalty  # lazy

        accrue_loyalty(sale)

        kind_label = "checkout" if kind == Sale.Kind.CHECKOUT else "POS"
        client_label = f" — {client.full_name}" if client else ""
        coupon_label = f" (coupon {coupon.code} −€ {discount})" if coupon is not None else ""
        log_activity(
            salon,
            "sale.created",
            f"Vendita {kind_label} € {total}{coupon_label}{client_label}",
            actor=actor,
            payload={
                "sale_id": sale.id,
                "kind": str(kind),
                "total": str(total),
                "coupon_code": coupon.code if coupon is not None else "",
                "coupon_discount": str(discount),
                "deposit_deducted": str(deposit_deducted),
                "client_id": client.id if client else None,
                "appointment_id": appointment.id if appointment else None,
            },
        )
    return sale


def record_gift_card_cashed(salon, card, *, method: str, actor=None):
    """Registra a cassa l'incasso di una gift card venduta fuori dal punto vendita.

    Le carte comprate dall'app cliente nascono «da pagare» e il salone le
    incassa dalla sezione Fedeltà. Senza una vendita corrispondente quel denaro
    non compariva da nessuna parte: né nei ricavi, né nel riepilogo di giornata,
    né nelle analisi — ma il saldo diventava spendibile e al riscatto veniva
    scalato dall'incasso. Risultato: la carta faceva SPARIRE il suo valore dai
    conti invece di aggiungerlo.

    Ritorna la Sale creata, o None se la carta risulta già collegata a una.
    """
    if SaleLine.objects.filter(gift_card=card).exists():
        return None  # già venduta al banco: sarebbe un doppio conteggio
    amount = Decimal(str(card.initial_value)).quantize(CENT)
    if amount <= 0:
        return None
    if method not in Payment.Method.values:
        method = Payment.Method.OTHER
    with transaction.atomic():
        sale = Sale.objects.create(
            salon=salon,
            kind=Sale.Kind.POS,
            client=card.buyer_client,
            total=amount,
            created_by=actor,
        )
        SaleLine.objects.create(
            sale=sale,
            line_type=SaleLine.LineType.GIFT_CARD,
            qty=1,
            unit_price=amount,
            amount=amount,
            gift_card=card,
        )
        Payment.objects.create(sale=sale, method=method, amount=amount)
    return sale


def _money_sale(salon, appointment, amount: Decimal, method: str, actor, *, deposit: bool):
    """Vendita di una riga sola per denaro incassato fuori dal checkout.

    Serve alla caparra e all'addebito no-show: sono incassi veri che finivano
    solo nel registro attività, mentre riepilogo di giornata, ricavi e KPI
    restavano a zero. L'appuntamento si aggancia su `deposit_appointment` per
    la caparra — `appointment` deve restare libero per il conto finale — e su
    `appointment` per il no-show, che un conto finale non lo avrà mai.
    """
    if method not in Payment.Method.values:
        method = Payment.Method.OTHER
    link = (
        {"deposit_appointment": appointment} if deposit else {"appointment": appointment}
    )
    try:
        with transaction.atomic():
            sale = Sale.objects.create(
                salon=salon,
                kind=Sale.Kind.POS,
                client=appointment.client,
                location=appointment.location,
                total=amount,
                created_by=actor,
                **link,
            )
            SaleLine.objects.create(
                sale=sale,
                line_type=SaleLine.LineType.SERVICE,
                # Niente operatrice sulla caparra: il servizio glielo conta il
                # checkout, attribuirle anche l'anticipo lo conterebbe due volte.
                operator=None if deposit else appointment.operator,
                qty=1,
                unit_price=amount,
                amount=amount,
            )
            Payment.objects.create(sale=sale, method=method, amount=amount)
    except IntegrityError:
        # Due richieste nello stesso istante: il vincolo uno-a-uno ne ferma una.
        return None
    return sale


def record_deposit_cashed(salon, appointment, *, method: str, actor=None):
    """Registra come vendita la caparra di un appuntamento entrata in cassa.

    La caparra si conta il giorno in cui ARRIVA, non quello in cui si chiude il
    conto: al checkout viene poi detratta da quanto resta da pagare
    (`deposit_deducted`), così il denaro compare una volta sola e nel giorno
    giusto. Prima non la registrava nessuno e il riepilogo del giorno del
    checkout sottraeva un anticipo che non era mai entrato in nessun giorno.

    Vale sia per il pagamento online (webhook Stripe, `method="card"`) sia per
    la caparra portata in salone. Ritorna la Sale creata, o None se quella
    caparra ha già la sua vendita.
    """
    amount = Decimal(str(appointment.deposit_amount or 0)).quantize(CENT)
    if amount <= 0:
        return None
    if Sale.objects.filter(deposit_appointment=appointment).exists():
        return None  # già incassata: sarebbe un doppio conteggio
    return _money_sale(salon, appointment, amount, method, actor, deposit=True)


def record_no_show_charge(salon, appointment, *, amount, actor=None):
    """Registra come vendita l'addebito per mancata presentazione.

    Sono soldi davvero incassati sulla carta della cliente: senza vendita
    corrispondente un no-show da 80 € lasciava il riepilogo di giornata e i KPI
    a zero. Ritorna la Sale creata, o None se l'appuntamento ne ha già una.
    """
    amount = Decimal(str(amount or 0)).quantize(CENT)
    if amount <= 0:
        return None
    if Sale.objects.filter(appointment=appointment).exists():
        return None
    return _money_sale(salon, appointment, amount, Payment.Method.CARD, actor, deposit=False)
