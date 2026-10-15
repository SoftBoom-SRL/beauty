"""Passo «sales»: vendite, righe, pagamenti, caparre, conti da saldare.

**Il denaro.** In AreaBeauty un pagamento fatto in una vendita può servire a
un'altra: la caparra versata con un bonifico, il trattamento pagato in
anticipo, il saldo di un conto rimasto aperto. La regola, verificata su tutte
le 10.632 vendite (il totale torna con il «Saldato» di ognuna), è:

- i pagamenti fatti nella vendita portano a lei i loro `Dettagli`;
- i pagamenti fatti altrove e citati nella vendita portano a lei i loro
  `Sospesi` (gli importi presi da quel pagamento).

In beauty ogni euro diventa un `Payment` con la data in cui è arrivato. Quello
arrivato prima della vendita (caparra, anticipo) diventa la caparra della
visita, come la registra la cassa: una vendita-caparra del giorno del
pagamento e `deposit_deducted` sul conto. Quello arrivato dopo è un saldo. Le
vendite che in AreaBeauty portavano solo la caparra (totale zero, nessun
servizio) non si importano: il loro denaro è sul conto della visita.

**Il conto.** `total` è la somma delle righe, compresi i servizi pagati con
una gift box (in AreaBeauty restavano fuori dal totale come uno sconto; in
beauty sono un pagamento con gift card, come fa la cassa). `amount_due` è
quanto resta da pagare. Il conto si aggancia alla visita (`appointment`); le
altre visite dello stesso conto (servizi in parallelo con una collega) sono
«incassate nel conto unico» (`paid_in_sale`). Un servizio pagato per una
visita futura non aggancia il conto: la visita lo mostrerà come «Già pagato».

Rilanciato su un export più recente: le vendite nuove si aggiungono, e se un
conto già importato è stato saldato nel frattempo si aggiunge il saldo.
"""

import datetime as dt
from collections import defaultdict
from decimal import Decimal

from apps.agenda.models import Appointment
from apps.sales.models import Payment, Sale, SaleLine

from ..source import PSEUDO_SERVICE_IDS, ROME, local_dt, money, ms_dt

ZERO = Decimal("0.00")
METHODS = {1: Payment.Method.CASH, 2: Payment.Method.CARD, 3: Payment.Method.CARD, 4: Payment.Method.TRANSFER}
A = Appointment.Status
LINKABLE = (A.CLOSED, A.NO_SHOW)


def run(ctx):
    coupon_payments = _coupon_payments(ctx)
    appointment_refs = ctx.refs("appuntamento")
    status_of = dict(
        Appointment.objects.filter(salon=ctx.salon, pk__in=set(appointment_refs.values())).values_list("pk", "status")
    )
    taken = set(Sale.objects.filter(salon=ctx.salon, appointment__isnull=False).values_list("appointment_id", flat=True))
    covered = set(
        Appointment.objects.filter(salon=ctx.salon, paid_in_sale__isnull=False).values_list("pk", flat=True)
    )
    deposit_taken = set(
        Sale.objects.filter(salon=ctx.salon, deposit_appointment__isnull=False).values_list("deposit_appointment_id", flat=True)
    )
    plans = []
    for tx, s in sorted(ctx.source.sales.items()):
        allocations = _allocations(tx, s)
        pk = ctx.ref("vendita", tx)
        if pk:
            _refresh(ctx, pk, s, allocations)
            continue
        plan = _plan(ctx, tx, s, allocations, coupon_payments.get(tx, []), appointment_refs, status_of, taken, covered, deposit_taken)
        if plan is not None:
            plans.append(plan)
    _save(ctx, plans)


# --- lettura --------------------------------------------------------------------
def _allocations(tx, s):
    """[(metodo, importo, quando, dalla stessa vendita?)]: il denaro che appartiene alla vendita `tx`."""
    out = []
    for p in s.get("Pagamenti") or []:
        method = METHODS.get(p.get("Tipo"), Payment.Method.OTHER)
        when = ms_dt(p.get("DataPagamento"))
        if int(p.get("IdVendita") or 0) == tx:
            for d in p.get("Dettagli") or []:
                out.append((method, money(d.get("Importo")), when, True))
        else:
            for x in p.get("Sospesi") or []:
                out.append((method, money(x.get("Importo")), when, False))
    return [a for a in out if a[1] != 0]


def _coupon_payments(ctx):
    """{vendita: [(id gift box, importo, quando)]} dai riscatti delle gift box."""
    out = defaultdict(list)
    for coupon_id, uses in ctx.source.coupon_uses.items():
        for u in uses:
            out[int(u["IdTransazione"])].append(
                (coupon_id, money(u.get("TotaleIncassatoCoupon")), local_dt(u.get("Data")) or ms_dt(u.get("Data")))
            )
    return out


def _sale_datetime(s):
    return local_dt(f"{(s.get('DataTransazione') or '')[:10]} {s.get('OraTransazione') or '12:00'}")


def _executor(item):
    """Chi ha eseguito (Azione 1), non chi ha battuto la vendita (Azione 2)."""
    for a in item.get("Assistenti") or []:
        if a.get("Azione") == 1:
            return a.get("Id")
    return None


def _discount(item) -> int:
    try:
        return max(0, min(100, int(round(float(item.get("Sconto") or 0)))))
    except (TypeError, ValueError):
        return 0


# --- piano di una vendita --------------------------------------------------------
def _plan(ctx, tx, s, allocations, coupon_uses, appointment_refs, status_of, taken, covered, deposit_taken):
    services = ctx.refs("servizio")
    products = ctx.refs("prodotto")
    operators = ctx.refs("operatore")
    coupons = ctx.refs("coupon")
    lines, candidates = [], []

    for item in s.get("Servizi") or []:
        amount = money(item.get("TotaleScontato"))
        if int(item.get("IdServizio") or 0) in PSEUDO_SERVICE_IDS and amount == 0:
            continue
        service_pk = services.get(str(item.get("IdServizio")))
        if not service_pk:
            ctx.warn(f"vendita {tx}: servizio {item.get('IdServizio')} sconosciuto, riga senza servizio")
        lines.append(SaleLine(
            line_type=SaleLine.LineType.SERVICE,
            service_id=service_pk,
            operator_id=operators.get(_executor(item)),
            qty=item.get("Qta") or 1,
            unit_price=money(item.get("Prezzo") if item.get("Prezzo") is not None else item.get("PrezzoScontato")),
            discount_pct=_discount(item),
            is_gift=_discount(item) >= 100,
            amount=amount,
        ))
        appt_pk = appointment_refs.get(item.get("IdAppuntamento") or "")
        if appt_pk and status_of.get(appt_pk) in LINKABLE and appt_pk not in candidates:
            candidates.append(appt_pk)

    for item in s.get("Prodotti") or []:
        product_pk = products.get(str(item.get("IdProdotto")))
        if not product_pk:
            ctx.count("righe prodotto senza prodotto collegato")
        lines.append(SaleLine(
            line_type=SaleLine.LineType.PRODUCT,
            product_id=product_pk,
            operator_id=operators.get(_executor(item)),
            qty=item.get("Qta") or 1,
            unit_price=money(item.get("Costo")),
            discount_pct=_discount(item),
            is_gift=_discount(item) >= 100,
            amount=money(item.get("TotaleScontato")),
        ))

    for item in s.get("Coupons") or []:
        lines.append(SaleLine(
            line_type=SaleLine.LineType.GIFT_CARD,
            gift_card_id=coupons.get(str(int(item.get("IdCoupon") or 0))),
            operator_id=operators.get(_executor(item)),
            qty=item.get("Qta") or 1,
            unit_price=money(item.get("Prezzo")),
            discount_pct=_discount(item),
            is_gift=_discount(item) >= 100,
            amount=money(item.get("TotaleScontato")),
        ))

    sold_total = money((s.get("Importi") or {}).get("TotaleVendita"))
    if not lines and sold_total == 0 and not any(own for *_x, own in allocations):
        ctx.count("vendite solo caparra (il denaro va sul conto della visita)")
        return None

    when = _sale_datetime(s)
    total = sum((line.amount for line in lines), ZERO)

    # Gift box usate come pagamento: in AreaBeauty restavano fuori dal totale.
    gift_payments = []
    for coupon_id, amount, used_at in coupon_uses:
        gift_payments.append(Payment(
            method=Payment.Method.GIFT_CARD, amount=amount, gift_card_id=coupons.get(str(coupon_id)), created_at=used_at or when
        ))
    gift_total = sum((p.amount for p in gift_payments), ZERO)
    if not gift_payments and total > sold_total:
        coupon_line = next((x for x in s.get("Servizi") or [] if x.get("IdCoupon")), None)
        if coupon_line is not None:
            gift_payments.append(Payment(
                method=Payment.Method.GIFT_CARD, amount=total - sold_total,
                gift_card_id=coupons.get(str(int(coupon_line["IdCoupon"]))), created_at=when,
            ))
            gift_total = total - sold_total
    if total - gift_total != sold_total:
        ctx.count("vendite con totale diverso da AreaBeauty")
        ctx.warn(f"vendita {tx}: righe {total} − gift box {gift_total} ≠ totale {sold_total}")

    appointment_pk = next((pk for pk in candidates if pk not in taken), None)
    if appointment_pk:
        taken.add(appointment_pk)
    others = [pk for pk in candidates if pk != appointment_pk and pk not in taken and pk not in covered]
    covered.update(others)

    # Denaro arrivato prima della vendita da un'altra vendita = caparra della visita.
    deposit, payments = [], []
    can_deposit = appointment_pk and status_of.get(appointment_pk) == A.CLOSED and appointment_pk not in deposit_taken
    for method, amount, paid_at, own in allocations:
        paid_at = paid_at or when
        early = not own and paid_at.astimezone(ROME).date() <= when.date()
        if early and can_deposit:
            deposit.append(Payment(method=method, amount=amount, created_at=paid_at))
        else:
            payments.append(Payment(method=method, amount=amount, created_at=paid_at))
    if deposit:
        deposit_taken.add(appointment_pk)
    deposit_total = sum((p.amount for p in deposit), ZERO)
    paid = sum((p.amount for p in payments), ZERO)
    due = max(ZERO, total - gift_total - deposit_total - paid)

    sale = Sale(
        salon=ctx.salon,
        location=ctx.location,
        kind=Sale.Kind.CHECKOUT if appointment_pk else Sale.Kind.POS,
        appointment_id=appointment_pk,
        client_id=ctx.ref("cliente", s.get("IdCliente")),
        total=total,
        deposit_deducted=deposit_total,
        amount_due=due,
    )
    sale._when = when
    ctx.count("vendite")
    if appointment_pk:
        ctx.count("vendite agganciate alla visita")
    if due:
        ctx.count("conti da saldare")
        ctx.count("da saldare, centesimi", int(due * 100))
    if others:
        ctx.count("visite incassate nel conto unico", len(others))
    return {
        "tx": tx, "sale": sale, "lines": lines, "payments": payments + gift_payments,
        "deposit": deposit, "covers": others,
    }


# --- scrittura -------------------------------------------------------------------
def _save(ctx, plans):
    sales = [p["sale"] for p in plans]
    Sale.objects.bulk_create(sales, batch_size=500)
    lines, payments = [], []
    for p in plans:
        for line in p["lines"]:
            line.sale = p["sale"]
            lines.append(line)
        for pay in p["payments"]:
            pay.sale = p["sale"]
            payments.append(pay)
    SaleLine.objects.bulk_create(lines, batch_size=1000)

    # Caparre: una vendita-caparra per visita, del giorno del primo pagamento.
    deposit_sales, deposit_lines, deposited = [], [], []
    for p in plans:
        if not p["deposit"]:
            continue
        sale = p["sale"]
        amount = sum((d.amount for d in p["deposit"]), ZERO)
        first = min(d.created_at for d in p["deposit"])
        dep = Sale(
            salon=ctx.salon, location=ctx.location, kind=Sale.Kind.POS, deposit_appointment_id=sale.appointment_id,
            client_id=sale.client_id, total=amount,
        )
        dep._when = first
        deposit_sales.append(dep)
        deposit_lines.append(SaleLine(line_type=SaleLine.LineType.SERVICE, qty=1, unit_price=amount, amount=amount))
        for d in p["deposit"]:
            payments.append(d)
            d._deposit = dep
        deposited.append((sale.appointment_id, amount))
    Sale.objects.bulk_create(deposit_sales, batch_size=500)
    for dep, line in zip(deposit_sales, deposit_lines):
        line.sale = dep
    SaleLine.objects.bulk_create(deposit_lines, batch_size=1000)
    for pay in payments:
        if getattr(pay, "_deposit", None) is not None:
            pay.sale = pay._deposit
    Payment.objects.bulk_create(payments, batch_size=1000)
    if deposit_sales:
        ctx.count("caparre versate prima della visita", len(deposit_sales))

    for s in sales + deposit_sales:
        s.created_at = s._when
    Sale.objects.bulk_update(sales + deposit_sales, ["created_at"], batch_size=500)

    appointments = []
    for appointment_id, amount in deposited:
        appointments.append(Appointment(pk=appointment_id, deposit_status=Appointment.DepositStatus.PAID, deposit_amount=amount))
    Appointment.objects.bulk_update(appointments, ["deposit_status", "deposit_amount"], batch_size=500)
    covers = [Appointment(pk=pk, paid_in_sale_id=p["sale"].pk) for p in plans for pk in p["covers"]]
    Appointment.objects.bulk_update(covers, ["paid_in_sale"], batch_size=500)

    ctx.link_many("vendita", [(p["tx"], p["sale"]) for p in plans])


def _refresh(ctx, pk, s, allocations):
    """Conto già importato: se nel frattempo è stato saldato in AreaBeauty, aggiunge il saldo."""
    sale = Sale.objects.filter(pk=pk).first()
    if sale is None:
        return
    sold_total = money((s.get("Importi") or {}).get("TotaleVendita"))
    paid = sum((a[1] for a in allocations), ZERO)
    due = max(ZERO, sold_total - paid)
    if due >= sale.amount_due or not allocations:
        ctx.count("vendite già importate")
        return
    settled = sale.amount_due - due
    method, _amount, when, _own = max(allocations, key=lambda a: a[2] or dt.datetime.min.replace(tzinfo=dt.UTC))
    Payment.objects.create(sale=sale, method=method, amount=settled, created_at=when or sale.created_at)
    sale.amount_due = due
    sale.save(update_fields=["amount_due"])
    ctx.count("conti saldati nel frattempo")
