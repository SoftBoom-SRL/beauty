"""Caparre in cassa: quanto è ancora del salone, i rimborsi che escono dall'incasso, l'eccedenza al conto.

Stavano in services.py accanto alla vendita. La contabilità dei singoli
rimborsi (le voci di `Appointment.deposit_refunds`, `record_deposit_refund`)
resta dell'agenda: qui c'è quello che ne segue per la cassa. L'agenda chiama
queste funzioni come `apps.sales.services.<nome>` (anche con `getattr`), e
services.py le ri-esporta finché l'integrazione non riallinea quei chiamanti.
"""

from decimal import Decimal

from apps.core.services import log_activity
from common.money import CENT

from . import stripe_service
from .models import DepositRefund, Payment, Sale


def settle_deposit_excess(appointment, excess, *, actor=None) -> None:
    """La caparra copriva più del conto finale: la differenza torna alla cliente.

    Prima quel conto era impossibile da chiudere — il dovuto risultava negativo
    e la cassa rispondeva 422 per sempre. Ora si detrae fino al totale e
    l'eccedenza si rimborsa: su Stripe se la caparra è arrivata da lì,
    altrimenti resta scritta nel registro come da restituire a mano.
    """
    excess = Decimal(str(excess or 0)).quantize(CENT)
    if excess <= 0:
        return
    cents = int((excess * 100).quantize(Decimal("1")))
    refund = stripe_service.refund_payment_intent(
        appointment.salon,
        appointment.deposit_payment_intent_id,
        idempotency_key=f"deposit-excess-{appointment.salon_id}-{appointment.id}",
        amount_cents=cents,
        account=stripe_service.deposit_account(appointment),
    )
    if refund is not None:
        from apps.agenda.services import record_deposit_refund  # lazy

        refund = stripe_service.as_dict(refund)
        # Lo stato lo decide Stripe: un rimborso «pending» non è ancora denaro
        # tornato indietro. Registrandolo qui la quota detraibile si aggiorna.
        record_deposit_refund(
            appointment,
            refund_id=refund.get("id") or f"deposit-excess-{appointment.id}",
            cents=int(refund.get("amount") or cents),
            status=refund.get("status") or "succeeded",
            actor=actor,
        )
    log_activity(
        appointment.salon,
        "deposit.excess_refunded" if refund is not None else "deposit.excess_refund_due",
        f"Caparra superiore al conto: € {excess} da restituire"
        + ("" if refund is not None else " a mano")
        + f" — {appointment.client.full_name}",
        actor=actor,
        payload={"appointment_id": appointment.id, "amount": str(excess)},
    )


def deposit_retained(appointment) -> Decimal:
    """Caparra ancora del salone: incassata meno i rimborsi riusciti E quelli in corso.

    È la quota che il conto finale deve assorbire (detraendola o restituendola).
    Con un rimborso parziale ancora «pending» la caparra risulta «rimborso in
    corso» e la quota detraibile mostrata alla cassa è zero: il resto non veniva
    né detratto né restituito, e la cliente lo perdeva (02-21, 05-14). Il
    checkout ne restituisce la parte che non ha detratto.
    """
    from apps.agenda.services import _refund_sums, _refunds_committed_cents, _to_cents  # lazy

    if appointment.deposit_status not in ("paid", "refunding"):
        return Decimal("0.00")
    refunds = appointment.deposit_refunds or {}
    _done, in_flight, _gone, _floor = _refund_sums(refunds)
    # `deposit_refunded_amount` è la copia di quanto già restituito che la
    # dashboard mostra: di solito coincide con i rimborsi riusciti, ma se è più
    # alto (scritto a mano dall'admin, senza la riga del rimborso) vale lui.
    # Contare solo le righe avrebbe detratto al conto, o restituito di nuovo,
    # soldi che la cliente ha già riavuto.
    committed = max(
        _refunds_committed_cents(refunds),
        _to_cents(appointment.deposit_refunded_amount) + in_flight,
    )
    left = _to_cents(appointment.deposit_amount) - committed
    return (Decimal(max(left, 0)) / 100).quantize(CENT)


def sync_deposit_refunds(appointment) -> None:
    """Allinea i movimenti di rimborso (`DepositRefund`) ai rimborsi riusciti della caparra.

    Solo per le caparre entrate in cassa con la loro vendita: una caparra pagata
    a visita già annullata non è mai stata contata, e il suo rimborso non ha
    niente da stornare. Un rimborso che smette di risultare riuscito (Stripe lo
    fallisce dopo) perde la sua riga; il «pavimento» di `charge.refunded` vale
    per la parte non spiegata dai rimborsi con id. I rimborsi Stripe tornano
    sulla carta; quelli confermati a mano con il metodo con cui la caparra era
    stata incassata.
    """
    from apps.agenda.services import REFUND_DONE, REFUND_FLOOR_KEY, _refunds_done_cents  # lazy

    deposit_sale = Sale.objects.filter(deposit_appointment=appointment).first()
    if deposit_sale is None:
        return
    first_payment = deposit_sale.payments.order_by("id").first()
    manual_method = first_payment.method if first_payment is not None else Payment.Method.OTHER
    refunds = appointment.deposit_refunds or {}
    wanted: dict[str, tuple[int, str]] = {}
    explained = 0
    for key, row in refunds.items():
        if key == REFUND_FLOOR_KEY or (row.get("status") or "") != REFUND_DONE:
            continue
        cents = int(row.get("amount_cents") or 0)
        if cents <= 0:
            continue
        explained += cents
        wanted[f"{appointment.id}:{key}"] = (cents, manual_method if row.get("manual") else Payment.Method.CARD)
    # La parte del pavimento non spiegata dalle righe riuscite, al netto dei
    # rimborsi ancora in volo o falliti (vedi agenda.services._refunds_done_cents):
    # un rimborso in corso non esce dalla cassa prima di essere avvenuto.
    unexplained = _refunds_done_cents(refunds) - explained
    if unexplained > 0:
        wanted[f"{appointment.id}:{REFUND_FLOOR_KEY}"] = (unexplained, Payment.Method.CARD)

    existing = {
        row.key: row
        for row in DepositRefund.objects.filter(salon_id=appointment.salon_id, key__startswith=f"{appointment.id}:")
    }
    for key, (cents, method) in wanted.items():
        amount = (Decimal(cents) / 100).quantize(CENT)
        row = existing.pop(key, None)
        if row is None:
            DepositRefund.objects.create(
                salon_id=appointment.salon_id,
                appointment=appointment,
                deposit_sale=deposit_sale,
                key=key,
                amount=amount,
                method=method,
            )
        elif row.amount != amount:
            row.amount = amount
            row.save(update_fields=["amount"])
    for row in existing.values():
        row.delete()
