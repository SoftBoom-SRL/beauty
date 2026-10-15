"""Scritture delle vendite: `finalize_sale` condiviso da checkout e POS, il saldo di un
conto lasciato aperto (`settle_sale`), e le vendite di una riga per il denaro
incassato fuori dal conto (gift card, caparra, no-show).

In sales è l'unico modulo che scrive Sale, SaleLine e Payment: il riepilogo di
giornata e lo storico stanno in reports.py, la cassa delle caparre in deposits.py.

Le integrazioni cross-app (magazzino, coupon, gift card, pacchetti, fedeltà) sono
importate lazy dentro le funzioni, come da convenzione SPEC §1 (e i test le
patchano nei moduli qui sotto): le firme di riferimento sono

    inventory.services.deduct_stock_for_sale(sale)
    marketing.coupons.validate_coupon(salon, code, client=None)
    marketing.coupons.coupon_discount(coupon, base)
    marketing.coupons.mark_coupon_redeemed(coupon, sale)
    marketing.gift_cards.redeem_gift_card(salon, code, amount, sessions=1)
    marketing.gift_cards.create_gift_card(salon, value, *, gift_service=None,
        buyer_client=None, recipient_client=None, recipient_name="", paid=False,
        paid_method="", sold_by=None, sale=None, kind="gift", sessions=1)
    marketing.credits.create_package_credits(salon, *, package, client, amount,
        sale=None, line=None, paid_method="", actor=None)
    marketing.loyalty.accrue_loyalty(sale)
"""

from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.money import CENT

from .models import Payment, Sale, SaleLine

# Tipi di gift card che la cassa vende su una riga «gift_card»: il regalo e il
# trattamento pagato in anticipo dalla cliente stessa. Le carte «package» nascono
# solo dalle righe pacchetto (`create_package_credits`), mai scelte a mano.
SOLD_GIFT_CARD_KINDS = ("gift", "prepaid")
# Righe spezzate in una riga per pezzo: ciascuna crea la SUA carta (o le sue
# sedute) e la tiene collegata, come spiega `_prepare_lines`.
ONE_PER_LINE = (SaleLine.LineType.GIFT_CARD, SaleLine.LineType.PACKAGE)

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


def _packages_for(salon, blocks: list[dict]) -> dict:
    """{id: Package} dei pacchetti venduti nelle righe «package», del salone e in vendita.

    Letti prima di preparare le righe: senza prezzo una riga pacchetto vale il
    prezzo di listino. 404 per un pacchetto di un altro salone (come servizi e
    prodotti in `_validate_references`), 422 per uno tolto dalla vendita: il
    listino lo nasconde, e venderlo lo stesso emetterebbe sedute di un'offerta
    che il salone ha chiuso.
    """
    from apps.catalog.models import Package  # lazy

    ids = set()
    for block in blocks:
        for raw in block.get("lines") or []:
            if raw.get("line_type") != SaleLine.LineType.PACKAGE:
                continue
            # Una riga pacchetto senza pacchetto incassava senza creare nessuna
            # seduta: soldi presi per niente.
            if not raw.get("package_id"):
                raise HttpError(422, "Riga pacchetto senza pacchetto selezionato")
            ids.add(raw["package_id"])
    if not ids:
        return {}
    packages = Package.objects.filter(salon=salon, id__in=ids).in_bulk()
    if ids - set(packages):
        raise HttpError(404, "Pacchetto non trovato")
    for package in packages.values():
        if not package.active:
            raise HttpError(422, f"Il pacchetto «{package.name}» non è più in vendita")
    return packages


def _gift_card_fields(raw: dict) -> dict:
    """Tipo e sedute di una riga gift card: {gift_kind, gift_service_id, sessions}.

    Le sedute contano un trattamento: una carta a importo ne ha una sola. Lo
    ricontrolla `create_gift_card`, ma lì l'errore arriverebbe dopo la vendita
    già scritta (e annullata dal rollback): qui la cassa lo sa subito.
    """
    gift_kind = raw.get("kind") or "gift"
    if gift_kind not in SOLD_GIFT_CARD_KINDS:
        raise HttpError(422, "Tipo di gift card non valido: regalo o già pagato")
    try:
        sessions = int(raw.get("sessions") or 1)
    except (TypeError, ValueError):
        raise HttpError(422, "Numero di sedute non valido") from None
    if sessions < 1:
        raise HttpError(422, "Numero di sedute non valido")
    if sessions > 1 and not raw.get("gift_service_id"):
        raise HttpError(422, "Le sedute si indicano solo per un trattamento: scegli il servizio")
    return {"gift_kind": gift_kind, "gift_service_id": raw.get("gift_service_id"), "sessions": sessions}


def _prepare_lines(blocks: list[dict], packages: dict | None = None) -> tuple[list[dict], Decimal]:
    """Normalizza i blocchi {operator_id, lines} in righe piatte e calcola il totale.

    `packages` sono i pacchetti delle righe «package» (`_packages_for`): una riga
    senza prezzo prende il loro prezzo di listino.
    """
    packages = packages or {}
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
            if line_type == SaleLine.LineType.PACKAGE and unit_price is None and raw.get("package_id") in packages:
                unit_price = packages[raw["package_id"]].price
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
                "package_id": raw.get("package_id") if line_type == SaleLine.LineType.PACKAGE else None,
                "qty": qty,
                "unit_price": Decimal(str(unit_price)).quantize(CENT),
                "discount_pct": discount_pct,
                "is_gift": is_gift,
                "amount": amount,
                "recipient_name": raw.get("recipient_name") or "",
            }
            if line_type == SaleLine.LineType.GIFT_CARD:
                entry.update(_gift_card_fields(raw))
            if line_type in ONE_PER_LINE and qty > 1:
                # Una riga per carta: la riga ne può tenere UNA sola, quindi con
                # qty=3 due carte restavano scollegate dalla vendita. Incassate
                # poi da Fedeltà generavano una vendita del loro valore pieno,
                # cioè ricavi mai entrati. Lo stesso per i pacchetti: due
                # pacchetti sono due giri di sedute, ognuno con la sua riga
                # (`GiftCard.package_line`). Lo sconto, ammesso sui pacchetti,
                # si calcola sul pezzo: la somma delle righe è il totale.
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

    services = {d["service_id"] for d in prepared if d.get("service_id")}
    # Il trattamento di una gift card «a trattamento»: anche lui del salone.
    services |= {d["gift_service_id"] for d in prepared if d.get("gift_service_id")}
    checks = (
        (Service, services, "Servizio non trovato"),
        (Product, {d["product_id"] for d in prepared if d.get("product_id")}, "Prodotto non trovato"),
        (Operator, {d["operator_id"] for d in prepared if d.get("operator_id")}, "Operatrice non trovata"),
    )
    for model, ids, message in checks:
        if not ids:
            continue
        found = set(model.objects.filter(salon=salon, id__in=ids).values_list("id", flat=True))
        if ids - found:
            raise HttpError(404, message)


def _require_client_for_credits(prepared: list[dict], client) -> None:
    """Pacchetti e trattamenti già pagati diventano sedute DELLA cliente: senza, 422.

    Venduti al banco senza cliente, le sedute non sarebbero di nessuno: l'agenda
    non le mostrerebbe su nessuna visita e la cassa non saprebbe a chi scalarle.
    """
    if client is not None:
        return
    if any(d["line_type"] == SaleLine.LineType.PACKAGE for d in prepared):
        raise HttpError(422, "Un pacchetto si vende a una cliente: sceglila prima di incassare")
    if any(d.get("gift_kind") == "prepaid" for d in prepared):
        raise HttpError(
            422, "Un trattamento già pagato si vende a una cliente: sceglila prima di incassare"
        )


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


def _check_payments(payments: list[dict]) -> Decimal:
    """Metodi e importi dei pagamenti; ritorna quanto pagano in tutto."""
    for payment in payments:
        if payment.get("method") not in Payment.Method.values:
            raise HttpError(422, "Metodo di pagamento non valido")
        if Decimal(str(payment.get("amount") or 0)) < 0:
            raise HttpError(422, "Importo di pagamento negativo")
    return sum((Decimal(str(p.get("amount") or 0)) for p in payments), Decimal("0.00"))


def _left_due(paid_total: Decimal, due_total: Decimal, *, client, allow_due: bool) -> Decimal:
    """Quanto del conto resta da saldare dopo i pagamenti di adesso (0.00 = saldato).

    Senza `allow_due` i pagamenti devono coincidere col dovuto (totale meno
    caparra), come sempre. Con `allow_due` possono essere MENO: la cliente paga
    40 di un conto da 100 e i 60 restano scritti sulla vendita (`amount_due`),
    da saldare un altro giorno. Più del dovuto resta un errore (il resto non è
    di nessuno), e un debito si lascia solo a una cliente con nome: su una
    vendita anonima nessuno saprebbe a chi chiederlo.
    """
    gap = due_total - paid_total
    if abs(gap) <= PAYMENT_TOLERANCE:
        return Decimal("0.00")
    if not allow_due:
        raise HttpError(422, "I pagamenti non corrispondono al totale")
    if gap < 0:
        raise HttpError(422, "I pagamenti superano il totale da pagare")
    if client is None:
        raise HttpError(422, "Per lasciare un conto da saldare scegli la cliente")
    return gap.quantize(CENT)


def _record_payments(salon, sale: Sale, payments: list[dict], *, at) -> None:
    """Scrive i pagamenti della vendita, scalando le gift card usate; `at` è quando arriva il denaro.

    Al conto i pagamenti prendono la data della vendita: un incasso a cavallo
    della mezzanotte finiva con la vendita in un giorno e il denaro nell'altro.
    Un saldo pagato dopo (`settle_sale`) prende la sua.
    """
    for payment in payments:
        amount = Decimal(str(payment.get("amount") or 0)).quantize(CENT)
        card = None
        if payment["method"] == Payment.Method.GIFT_CARD:
            code = (payment.get("gift_card_code") or "").strip()
            if not code:
                raise HttpError(422, "Codice gift card mancante nel pagamento")
            from apps.marketing.gift_cards import redeem_gift_card  # lazy

            # Le carte a sedute (pacchetto, trattamenti già pagati) scalano una
            # seduta per riga del servizio coperta: due manicure nello stesso
            # conto sono due sedute. Le carte a una seduta si riscattano come
            # sempre, senza il parametro.
            sessions = int(payment.get("sessions") or 1)
            extra = {"sessions": sessions} if sessions > 1 else {}
            card = redeem_gift_card(salon, code, amount, **extra)
        Payment.objects.create(
            sale=sale, method=payment["method"], amount=amount, gift_card=card, created_at=at
        )


def _gift_services(salon, prepared: list[dict]) -> dict:
    """{id: Service} dei trattamenti delle gift card «a trattamento» vendute (una query)."""
    ids = {d["gift_service_id"] for d in prepared if d.get("gift_service_id")}
    if not ids:
        return {}
    from apps.catalog.models import Service  # lazy

    return Service.objects.filter(salon=salon, id__in=ids).in_bulk()


def _sell_gift_card(salon, sale, line, data: dict, *, client, gift_services: dict, paid_method: str, actor):
    """La carta della riga «gift_card»: regalo o trattamento già pagato, a importo o a sedute.

    Con `prepaid` la cliente paga oggi un trattamento (o più sedute) che farà
    più avanti: la carta è sua, comprata e ricevuta da lei, e in agenda e in
    cassa si legge «Già pagato» invece di «Regalo».
    """
    from apps.marketing.gift_cards import create_gift_card  # lazy

    prepaid = data["gift_kind"] == "prepaid"
    # Una carta per riga: `_prepare_lines` ha già spezzato le quantità
    # maggiori di uno, così ogni carta emessa ha la sua riga di vendita che la
    # collega.
    card = create_gift_card(
        salon,
        data["unit_price"],
        gift_service=gift_services.get(data["gift_service_id"]),
        buyer_client=client,
        recipient_client=client if prepaid else None,
        recipient_name=data["recipient_name"],
        paid=not data["is_gift"],
        paid_method=paid_method,
        sold_by=actor,
        sale=sale,
        kind=data["gift_kind"],
        sessions=data["sessions"],
    )
    line.gift_card = card
    line.save(update_fields=["gift_card"])


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
    allow_due: bool = False,
) -> Sale:
    """Core condiviso checkout/POS: valida, crea Sale/righe/pagamenti e integra le altre app.

    blocks   = [{"operator_id": int|None, "lines": [{line_type, service_id?, product_id?,
                 package_id?, qty, unit_price, discount_pct?, is_gift?, value?,
                 recipient_name?, gift_service_id?, sessions?, kind?}]}]
    payments = [{"method": cash|card|other|gift_card, "amount": Decimal,
                 "gift_card_code"?: str, "sessions"?: int}]
    coupon_code = buono sconto presentato al banco, facoltativo (vedi `_coupon_for_sale`)
    allow_due = la cliente può pagare meno del dovuto: il resto va in `Sale.amount_due`
                (vedi `_left_due`)

    Una riga «package» vende un pacchetto di listino: le sue sedute nascono qui,
    nella transazione della vendita (`marketing.credits.create_package_credits`),
    una carta per servizio pagata quanto la riga.
    """
    deposit_deducted = Decimal(str(deposit_deducted or 0)).quantize(CENT)
    if deposit_deducted < 0:
        raise HttpError(422, "Acconto detratto non valido")

    packages = _packages_for(salon, blocks)
    prepared, total = _prepare_lines(blocks, packages)
    if not prepared:
        raise HttpError(422, "Nessuna riga di vendita")
    _validate_references(salon, prepared)
    _require_client_for_credits(prepared, client)

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

    paid_total = _check_payments(payments)
    amount_due = _left_due(paid_total, total - deposit_deducted, client=client, allow_due=allow_due)

    first_method = payments[0].get("method", "") if payments else ""
    gift_services = _gift_services(salon, prepared)

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
            amount_due=amount_due,
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
                package_id=data["package_id"],
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
                _sell_gift_card(
                    salon, sale, line, data,
                    client=client, gift_services=gift_services, paid_method=first_method, actor=actor,
                )
            if data["line_type"] == SaleLine.LineType.PACKAGE:
                from apps.marketing.credits import create_package_credits  # lazy

                # Le sedute valgono quanto la riga DOPO sconto e buono: è quello
                # che la cliente ha pagato, e che ogni seduta scalerà dalla
                # cassa del giorno in cui la farà (come una gift card).
                create_package_credits(
                    salon,
                    package=packages[data["package_id"]],
                    client=client,
                    amount=line.amount,
                    sale=sale,
                    line=line,
                    paid_method=first_method,
                    actor=actor,
                )

        _record_payments(salon, sale, payments, at=sale.created_at)

        if has_products:
            from apps.inventory.services import deduct_stock_for_sale  # lazy

            deduct_stock_for_sale(sale)

        from apps.marketing.loyalty import accrue_loyalty  # lazy

        accrue_loyalty(sale)

        kind_label = "checkout" if kind == Sale.Kind.CHECKOUT else "POS"
        client_label = f" — {client.full_name}" if client else ""
        coupon_label = f" (coupon {coupon.code} −€ {discount})" if coupon is not None else ""
        due_label = f", da saldare € {amount_due}" if amount_due > 0 else ""
        log_activity(
            salon,
            "sale.created",
            f"Vendita {kind_label} € {total}{coupon_label}{due_label}{client_label}",
            actor=actor,
            payload={
                "sale_id": sale.id,
                "kind": str(kind),
                "total": str(total),
                "coupon_code": coupon.code if coupon is not None else "",
                "coupon_discount": str(discount),
                "deposit_deducted": str(deposit_deducted),
                "amount_due": str(amount_due),
                "client_id": client.id if client else None,
                "appointment_id": appointment.id if appointment else None,
            },
        )
    return sale


def settle_sale(salon, sale_id: int, payments: list[dict], *, actor=None) -> Sale:
    """Incassa quanto resta da saldare di una vendita (`Sale.amount_due`), tutto o in parte.

    La cliente che aveva lasciato 60 € da pagare torna dopo una settimana e li
    salda: nasce un pagamento con la data di OGGI (è oggi che il denaro entra in
    cassa, e il riepilogo lo conta qui), e il dovuto della vendita scende. Il
    venduto resta quello del giorno della vendita. Pagare più di quanto resta
    è un errore: la differenza non sarebbe di nessun conto.

    Stessi lock delle altre scritture di cassa: il salone, poi la riga della
    vendita, riletta sotto lock. Due postazioni che saldano lo stesso conto
    leggevano altrimenti entrambe «60 da saldare» e incassavano 120.
    """
    from apps.agenda.services.locking import lock_salon  # lazy

    paid_total = _check_payments(payments)
    if paid_total <= 0:
        raise HttpError(422, "Indica quanto paga la cliente")
    with transaction.atomic():
        lock_salon(salon)
        sale = Sale.objects.select_for_update().filter(pk=sale_id, salon=salon).first()
        if sale is None:
            raise HttpError(404, "Vendita non trovata")
        if sale.amount_due <= 0:
            raise HttpError(400, "Questo conto è già saldato")
        if paid_total - sale.amount_due > PAYMENT_TOLERANCE:
            raise HttpError(
                422, f"Il pagamento supera quanto resta da saldare (€ {sale.amount_due})"
            )
        _record_payments(salon, sale, payments, at=timezone.now())
        left = sale.amount_due - paid_total
        # Il centesimo di tolleranza vale come al conto: 59,99 su 60 chiude il debito.
        sale.amount_due = Decimal("0.00") if left <= PAYMENT_TOLERANCE else left.quantize(CENT)
        sale.save(update_fields=["amount_due"])
        paid = paid_total.quantize(CENT)
        client_label = f" — {sale.client.full_name}" if sale.client_id else ""
        left_label = f", restano € {sale.amount_due}" if sale.amount_due > 0 else ", saldato"
        log_activity(
            salon,
            "sale.settled",
            f"Saldo € {paid} del conto #{sale.id}{left_label}{client_label}",
            actor=actor,
            payload={
                "sale_id": sale.id,
                "amount": str(paid),
                "amount_due": str(sale.amount_due),
                "client_id": sale.client_id,
                "methods": sorted({str(p["method"]) for p in payments}),
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
        Payment.objects.create(sale=sale, method=method, amount=amount, created_at=sale.created_at)
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
            Payment.objects.create(sale=sale, method=method, amount=amount, created_at=sale.created_at)
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
