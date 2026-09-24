"""Letture della cassa: il riepilogo di oggi per l'agenda e lo storico delle vendite con i KPI.

Solo query, nessuna scrittura. Il riepilogo stava in services.py, accanto a
chi scrive le vendite; i filtri dello storico e le regole dei suoi KPI (le
vendite-caparra fuori, il fatturato di un'operatrice fatto delle sue righe)
stavano dentro l'endpoint.
"""

from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.utils import timezone
from django.utils.dateparse import parse_date
from ninja.errors import HttpError

from common.money import CENT

from . import serializers
from .models import DepositRefund, Payment, Sale, SaleLine


def today_summary(salon) -> dict:
    """Incassi di oggi (box agenda): {total, count, checkout_total, pos_total,
    gift_card_sold, gift_card_redeemed, deposit_used, deposit_cashed,
    deposit_refunded, cash_in}.

    `total` è il venduto di oggi: le vendite-caparra restano fuori, perché sono
    un anticipo sul conto che al checkout verrà fatturato per intero — contarle
    qui faceva risultare 130 € di venduto per un servizio da 100 con 30 di
    caparra. Entrano invece in `deposit_cashed`, che è denaro davvero arrivato
    oggi. `gift_card_redeemed` è la parte saldata con gift card e `deposit_used`
    quella coperta da caparre versate in precedenza: denaro già incassato in un
    altro giorno. `deposit_refunded` sono le caparre restituite oggi (rimborso
    all'annullamento, eccedenza al conto, restituzione a mano): denaro uscito.
    `cash_in` è quello entrato davvero oggi, al netto di quello uscito:
    total + deposit_cashed − gift_card_redeemed − deposit_used − deposit_refunded.
    Così né un regalo né un anticipo vengono contati due volte, e una caparra
    restituita non resta in cassa.
    """
    zero = Decimal("0.00")
    today = timezone.localdate()
    of_today = Sale.objects.filter(salon=salon, created_at__date=today)
    deposits = of_today.filter(deposit_appointment__isnull=False)
    qs = of_today.filter(deposit_appointment__isnull=True)
    agg = qs.aggregate(total=Sum("total"), count=Count("id"))
    by_kind = dict(qs.values_list("kind").annotate(t=Sum("total")))
    gift_sold = (
        SaleLine.objects.filter(sale__in=qs, line_type=SaleLine.LineType.GIFT_CARD).aggregate(t=Sum("amount"))["t"]
        or zero
    )
    gift_redeemed = (
        Payment.objects.filter(sale__in=qs, method=Payment.Method.GIFT_CARD).aggregate(t=Sum("amount"))["t"]
        or zero
    )
    total = agg["total"] or zero
    deposit_used = qs.aggregate(t=Sum("deposit_deducted"))["t"] or zero
    deposit_cashed = deposits.aggregate(t=Sum("total"))["t"] or zero
    deposit_refunded = (
        DepositRefund.objects.filter(salon=salon, created_at__date=today).aggregate(t=Sum("amount"))["t"]
        or zero
    )
    return {
        "total": total,
        "count": agg["count"] or 0,
        "checkout_total": by_kind.get(Sale.Kind.CHECKOUT.value) or zero,
        "pos_total": by_kind.get(Sale.Kind.POS.value) or zero,
        "gift_card_sold": gift_sold,
        "gift_card_redeemed": gift_redeemed,
        "deposit_used": deposit_used,
        "deposit_cashed": deposit_cashed,
        "deposit_refunded": deposit_refunded,
        "cash_in": total + deposit_cashed - gift_redeemed - deposit_used - deposit_refunded,
    }


def _filter_day(raw: str):
    """Giorno di un filtro dello storico; None se manca o non è nel formato YYYY-MM-DD.

    Una data ben scritta ma inesistente («2026-02-30») fa sollevare ValueError
    a `parse_date`: arrivava all'utente come 500. Ora è un 400, come nei KPI.
    """
    if not raw:
        return None
    try:
        return parse_date(raw)
    except ValueError:
        raise HttpError(400, "Data non valida: usa il formato YYYY-MM-DD")


def sales_history(salon, *, kind, date_from, date_to, q, client_id, operator_id, limit, offset) -> dict:
    """Storico vendite del salone, una pagina, con i KPI {revenue, count, items_count} sul filtro.

    `limit` e `offset` arrivano già nei limiti che mette lo schema dell'endpoint.
    """
    qs = Sale.objects.filter(salon=salon)
    # Le vendite-caparra sono un anticipo, non un conto: il checkout fattura già
    # il servizio per intero e ne detrae la caparra. Contate qui, «Incasso
    # totale» diceva 130 per un servizio da 100 con 30 di caparra, i conteggi
    # raddoppiavano e la caparra compariva come vendita «Da banco» (05-03,
    # 14-03). Si vedono solo chiedendole: `kind=deposit`.
    if kind == "deposit":
        qs = qs.filter(deposit_appointment__isnull=False)
    else:
        qs = qs.filter(deposit_appointment__isnull=True)
        if kind:
            qs = qs.filter(kind=kind)
    if d := _filter_day(date_from):
        qs = qs.filter(created_at__date__gte=d)
    if d := _filter_day(date_to):
        qs = qs.filter(created_at__date__lte=d)
    if q:
        qs = qs.filter(
            Q(client__first_name__icontains=q) | Q(client__last_name__icontains=q)
        )
    if client_id:
        qs = qs.filter(client_id=client_id)
    if operator_id:
        qs = qs.filter(lines__operator_id=operator_id)

    base = Sale.objects.filter(pk__in=qs.values("pk"))  # evita duplicati da join
    agg = base.aggregate(revenue=Sum("total"), count=Count("id"))
    lines = SaleLine.objects.filter(sale__in=base)
    revenue = agg["revenue"] or Decimal("0.00")
    if operator_id:
        # Filtrando per operatrice il fatturato è quello delle SUE righe: prima
        # si sommavano le vendite intere, così di una vendita da 100 con 20 di
        # Giulia e 80 di Anna a Giulia ne venivano attribuiti 100.
        lines = lines.filter(operator_id=operator_id)
        revenue = lines.aggregate(t=Sum("amount"))["t"] or Decimal("0.00")
    items_count = lines.aggregate(n=Sum("qty"))["n"] or 0
    items = base.select_related("client").order_by("-created_at")[offset : offset + limit]
    return {
        "count": agg["count"] or 0,
        "kpi": {
            "revenue": revenue.quantize(CENT),
            "count": agg["count"] or 0,
            "items_count": items_count,
        },
        "items": [serializers.sale_out(s) for s in items],
    }
