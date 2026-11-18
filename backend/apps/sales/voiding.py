"""Annullamento di un passaggio cassa chiuso per sbaglio.

Un conto chiuso male (metodo sbagliato, servizio dimenticato, prezzo
sbagliato) restava per sempre nello storico, nella cassa del giorno e nei
report: non c'era modo di toglierlo né di rifarlo (Beauty Boutique, 11/2026).
Annullarlo cancella la vendita, rimette a magazzino i prodotti, toglie i punti
fedeltà accreditati e riapre le visite che chiudeva, così il conto si rifà da
capo. Nel registro attività resta tutto quello che c'era (righe e pagamenti).

Si annullano solo le vendite fatte di servizi e prodotti pagati in contanti,
carta, bonifico o altro: gift card, pacchetti, Exclusive Card, buoni sconto,
caparre e pagamenti con carta regalo lasciano tracce in altre app (saldi,
sedute, buoni consumati) che una cancellazione non riporterebbe indietro.
"""

from decimal import Decimal

from django.db import transaction
from ninja.errors import HttpError

from apps.agenda.models import Appointment
from apps.core.services import log_activity

from .models import Payment, Sale, SaleLine

_VOIDABLE_LINES = {SaleLine.LineType.SERVICE, SaleLine.LineType.PRODUCT}
_VOIDABLE_PAYMENTS = {
    Payment.Method.CASH, Payment.Method.CARD, Payment.Method.OTHER, Payment.Method.TRANSFER,
}


def void_blocker(sale: Sale) -> str:
    """Perché la vendita non si può annullare da qui; "" se si può."""
    if sale.deposit_appointment_id is not None:
        return "È la caparra di un appuntamento: si gestisce dall'appuntamento"
    if sale.kind == Sale.Kind.POS and sale.appointment_id is not None:
        return "È l'addebito di un no-show: non si annulla dalla cassa"
    if sale.deposit_deducted > 0:
        return "Il conto ha detratto una caparra: non si può annullare da qui"
    if sale.coupon_discount > 0 or sale.coupons.exists():
        return "Il conto ha usato un buono sconto: non si può annullare da qui"
    if any(line.line_type not in _VOIDABLE_LINES for line in sale.lines.all()):
        return "Il conto contiene gift card, pacchetti o Exclusive Card: non si può annullare da qui"
    if any(p.method not in _VOIDABLE_PAYMENTS for p in sale.payments.all()):
        return "Il conto è stato pagato con una gift card: non si può annullare da qui"
    return ""


def _restock(sale: Sale, actor) -> None:
    """Rimette a magazzino quello che la vendita aveva scaricato, movimento per movimento."""
    from apps.inventory.models import StockMovement  # lazy
    from apps.inventory.services import apply_movement  # lazy

    sold = sale.stock_movements.filter(kind=StockMovement.Kind.SALE).select_related("product")
    for movement in sold:
        if movement.qty >= 0:
            continue
        apply_movement(
            movement.product,
            kind=StockMovement.Kind.ADJUSTMENT,
            qty=-movement.qty,
            reason=f"Annullamento vendita #{sale.id}",
            author=actor,
        )


def _reopen(visit: Appointment, sale: Sale, actor) -> None:
    """La visita torna «in corso», da incassare: anche quella tolta dall'agenda
    torna visibile, se no non si potrebbe più rifare il conto."""
    visit.status = Appointment.Status.IN_PROGRESS
    visit.paid_in_sale = None
    visit.removed_from_agenda_at = None
    visit.save(update_fields=["status", "paid_in_sale", "removed_from_agenda_at", "updated_at"])
    log_activity(
        visit.salon,
        "appointment.reopened",
        f"Visita di {visit.client.full_name} riaperta: incasso annullato",
        actor=actor,
        payload={"appointment_id": visit.id, "status": visit.status, "voided_sale_id": sale.id},
    )


def void_sale(salon, sale_id: int, *, actor=None) -> dict:
    """Annulla (cancella) la vendita `sale_id` del salone e ritorna cosa ha riaperto.

    404 se non c'è; 422 con il motivo se non è annullabile (`void_blocker`).
    """
    from apps.agenda.services.locking import lock_salon  # lazy
    from apps.marketing.loyalty import reverse_loyalty  # lazy

    with transaction.atomic():
        # Lo stesso ordine del check-out: prima il salone, poi le righe.
        lock_salon(salon)
        sale = (
            Sale.objects.select_for_update()
            .select_related("client")
            .filter(pk=sale_id, salon=salon)
            .first()
        )
        if sale is None:
            raise HttpError(404, "Vendita non trovata")
        reason = void_blocker(sale)
        if reason:
            raise HttpError(422, reason)

        visits = list(
            Appointment.objects.select_for_update()
            .select_related("client", "salon")
            .filter(salon=salon)
            .filter(pk__in=[sale.appointment_id] if sale.appointment_id else [])
        ) + list(
            Appointment.objects.select_for_update()
            .select_related("client", "salon")
            .filter(salon=salon, paid_in_sale=sale)
        )
        lines = list(sale.lines.select_related("service", "product", "operator"))
        payments = list(sale.payments.all())

        _restock(sale, actor)
        reverse_loyalty(sale)
        for visit in visits:
            _reopen(visit, sale, actor)

        client_label = f" — {sale.client.full_name}" if sale.client else ""
        log_activity(
            salon,
            "sale.voided",
            f"Vendita #{sale.id} annullata € {sale.total}{client_label}",
            actor=actor,
            payload={
                "sale_id": sale.id,
                "kind": sale.kind,
                "total": str(sale.total),
                "created_at": sale.created_at.isoformat(),
                "receipt_issued": sale.receipt_issued,
                "client_id": sale.client_id,
                "appointment_ids": [v.id for v in visits],
                "lines": [
                    {
                        "line_type": line.line_type,
                        "name": (line.service.name_it if line.service else "")
                        or (line.product.name if line.product else ""),
                        "operator": line.operator.full_name if line.operator else "",
                        "qty": line.qty,
                        "unit_price": str(line.unit_price),
                        "discount_pct": line.discount_pct,
                        "is_gift": line.is_gift,
                        "amount": str(line.amount),
                    }
                    for line in lines
                ],
                "payments": [
                    {"method": p.method, "amount": str(p.amount), "at": p.created_at.isoformat()}
                    for p in payments
                ],
                "written_off": str(sale.written_off),
                "amount_due": str(sale.amount_due),
            },
        )
        voided_total = Decimal(sale.total)
        sale.delete()
    return {"sale_id": sale_id, "total": voided_total, "reopened_appointment_ids": [v.id for v in visits]}
