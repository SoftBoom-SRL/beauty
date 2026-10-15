"""Letture della cassa: il riepilogo di oggi per l'agenda e lo storico delle vendite con i KPI.

Solo query, nessuna scrittura. Il riepilogo stava in services.py, accanto a
chi scrive le vendite; i filtri dello storico e le regole dei suoi KPI (le
vendite-caparra fuori, il fatturato di un'operatrice fatto delle sue righe)
stavano dentro l'endpoint. `cash_movements` (il denaro che entra quando arriva,
non quando si vende) lo usano anche gli insight.
"""

import datetime as dt
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.utils import timezone
from django.utils.dateparse import parse_date
from ninja.errors import HttpError

from common.money import CENT

from . import serializers
from .models import DepositRefund, Payment, Sale, SaleLine


def day_bounds(day: dt.date) -> tuple[dt.datetime, dt.datetime]:
    """Il giorno `day` del salone come istanti [inizio, fine)."""
    start = timezone.make_aware(dt.datetime.combine(day, dt.time.min))
    end = timezone.make_aware(dt.datetime.combine(day + dt.timedelta(days=1), dt.time.min))
    return start, end


def cash_movements(salon, start, end) -> dict:
    """I movimenti di cassa di [start, end) che non stanno nel venduto del periodo.

    Il venduto (`Sale.total`) resta del giorno della vendita; il denaro entra
    quando ARRIVA (`Payment.created_at`). Le due cose coincidevano finché ogni
    conto si pagava per intero al banco; con i conti da saldare no:

    - `due_left`: la parte delle vendite del periodo non pagata nel periodo.
      È quanto resta ancora da saldare (`amount_due`) più i saldi arrivati
      DOPO la fine del periodo: per il mese scorso, il saldo pagato questo mese
      è denaro di questo mese, non di quello.
    - `settled`: i pagamenti arrivati nel periodo per vendite di prima (i saldi).
    - `gift_card_redeemed`: i pagamenti con gift card arrivati nel periodo,
      saldi compresi: denaro già incassato quando la carta fu venduta. Un saldo
      pagato con una gift card entra in `settled` ed esce da qui, e la cassa
      non cambia.

    Le vendite-caparra restano fuori: si pagano per intero quando arrivano, e
    stanno in `deposit_cashed`.
    """
    zero = Decimal("0.00")
    billed = Sale.objects.filter(
        salon=salon, created_at__gte=start, created_at__lt=end, deposit_appointment__isnull=True
    )
    payments = Payment.objects.filter(sale__salon=salon, sale__deposit_appointment__isnull=True)
    still_due = billed.aggregate(t=Sum("amount_due"))["t"] or zero
    paid_later = (
        payments.filter(sale__in=billed, created_at__gte=end).aggregate(t=Sum("amount"))["t"] or zero
    )
    in_period = payments.filter(created_at__gte=start, created_at__lt=end)
    settled = in_period.filter(sale__created_at__lt=start).aggregate(t=Sum("amount"))["t"] or zero
    gift_card_redeemed = (
        in_period.filter(method=Payment.Method.GIFT_CARD).aggregate(t=Sum("amount"))["t"] or zero
    )
    package_sold = (
        SaleLine.objects.filter(sale__in=billed, line_type=SaleLine.LineType.PACKAGE).aggregate(t=Sum("amount"))["t"]
        or zero
    )
    return {
        "due_left": still_due + paid_later,
        "settled": settled,
        "gift_card_redeemed": gift_card_redeemed,
        "package_sold": package_sold,
    }


def today_summary(salon) -> dict:
    """Incassi di oggi (box agenda): {total, count, checkout_total, pos_total,
    gift_card_sold, package_sold, gift_card_redeemed, deposit_used, deposit_cashed,
    deposit_refunded, due_left, settled, cash_in}.

    `total` è il venduto di oggi: le vendite-caparra restano fuori, perché sono
    un anticipo sul conto che al checkout verrà fatturato per intero — contarle
    qui faceva risultare 130 € di venduto per un servizio da 100 con 30 di
    caparra. Entrano invece in `deposit_cashed`, che è denaro davvero arrivato
    oggi. `gift_card_redeemed` è la parte pagata oggi con gift card e
    `deposit_used` quella coperta da caparre versate in precedenza: denaro già
    incassato in un altro giorno. `deposit_refunded` sono le caparre restituite
    oggi (rimborso all'annullamento, eccedenza al conto, restituzione a mano):
    denaro uscito. `due_left` è la parte del venduto di oggi lasciata da
    saldare e `settled` i saldi arrivati oggi per conti di altri giorni
    (vedi `cash_movements`). `cash_in` è quello entrato davvero oggi, al netto
    di quello uscito:
    total + deposit_cashed − gift_card_redeemed − deposit_used − deposit_refunded
    − due_left + settled.
    Così né un regalo né un anticipo vengono contati due volte, una caparra
    restituita non resta in cassa, e un conto lasciato da saldare entra il
    giorno in cui la cliente lo paga.
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
    total = agg["total"] or zero
    deposit_used = qs.aggregate(t=Sum("deposit_deducted"))["t"] or zero
    deposit_cashed = deposits.aggregate(t=Sum("total"))["t"] or zero
    deposit_refunded = (
        DepositRefund.objects.filter(salon=salon, created_at__date=today).aggregate(t=Sum("amount"))["t"]
        or zero
    )
    moves = cash_movements(salon, *day_bounds(today))
    return {
        "total": total,
        "count": agg["count"] or 0,
        "checkout_total": by_kind.get(Sale.Kind.CHECKOUT.value) or zero,
        "pos_total": by_kind.get(Sale.Kind.POS.value) or zero,
        "gift_card_sold": gift_sold,
        "package_sold": moves["package_sold"],
        "gift_card_redeemed": moves["gift_card_redeemed"],
        "deposit_used": deposit_used,
        "deposit_cashed": deposit_cashed,
        "deposit_refunded": deposit_refunded,
        "due_left": moves["due_left"],
        "settled": moves["settled"],
        "cash_in": (
            total + deposit_cashed - moves["gift_card_redeemed"] - deposit_used - deposit_refunded
            - moves["due_left"] + moves["settled"]
        ),
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


def sales_history(
    salon, *, kind, date_from, date_to, q, client_id, operator_id, limit, offset, due=False
) -> dict:
    """Storico vendite del salone, una pagina, con i KPI {revenue, count, items_count, due_total} sul filtro.

    `due` tiene solo i conti con qualcosa ancora da saldare; `due_total` è quanto
    resta da saldare sulle vendite del filtro. `limit` e `offset` arrivano già
    nei limiti che mette lo schema dell'endpoint.
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
    if due:
        qs = qs.filter(amount_due__gt=0)

    base = Sale.objects.filter(pk__in=qs.values("pk"))  # evita duplicati da join
    agg = base.aggregate(revenue=Sum("total"), count=Count("id"), due_total=Sum("amount_due"))
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
            "due_total": (agg["due_total"] or Decimal("0.00")).quantize(CENT),
        },
        "items": [serializers.sale_out(s) for s in items],
    }
