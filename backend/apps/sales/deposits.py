"""Caparre in cassa: il pagamento arrivato da Stripe, quanto è ancora del salone, i rimborsi.

Il pagamento online si applica sotto lock (`apply_deposit_payment`) e quello
arrivato in più si restituisce (`refund_overpaid_deposit`,
`refund_duplicate_deposit`); il conto finale detrae la quota ancora del
salone (`deposit_retained`) e restituisce l'eccedenza (`settle_deposit_excess`);
ogni rimborso riuscito esce dall'incasso del suo giorno (`sync_deposit_refunds`).
Stava fra api.py (webhook) e services.py (vendita). La contabilità dei singoli
rimborsi (le voci di `Appointment.deposit_refunds`, `record_deposit_refund`)
resta dell'agenda: qui c'è quello che ne segue per la cassa. L'agenda chiama
`deposit_retained`, `sync_deposit_refunds` e `settle_deposit_excess` come
`apps.sales.services.<nome>` (anche con `getattr`), e services.py le
ri-esporta finché l'integrazione non riallinea quei chiamanti.
"""

from decimal import Decimal

from django.db import transaction

from apps.agenda.models import Appointment
from apps.core.services import log_activity
from common.money import CENT, from_cents, to_cents

from . import stripe_service
from .models import DepositRefund, Payment, Sale

# Caparra già arrivata (e magari già restituita, o trattenuta): un pagamento
# nuovo non la paga una seconda volta, e un rimborso Stripe la riguarda.
DEPOSIT_RECEIVED_STATUSES = ("paid", "refund_due", "refunding", "refunded", "forfeited")


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
    cents = to_cents(excess)
    refund = stripe_service.refund_payment_intent(
        appointment.salon,
        appointment.deposit_payment_intent_id,
        idempotency_key=f"deposit-excess-{appointment.salon_id}-{appointment.id}",
        amount_cents=cents,
        account=stripe_service.deposit_account(appointment),
    )
    if refund is not None:
        from apps.agenda.services import record_deposit_refund  # lazy

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
    from apps.agenda.services import _refund_sums, _refunds_committed_cents  # lazy

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
        to_cents(appointment.deposit_refunded_amount) + in_flight,
    )
    left = to_cents(appointment.deposit_amount) - committed
    return from_cents(max(left, 0))


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
        amount = from_cents(cents)
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


# ---- Pagamento online della caparra (webhook Stripe) ---------------------------


def amount_received(obj: dict):
    """Centesimi arrivati secondo l'oggetto Stripe: `amount_received`, altrimenti `amount`.

    None quando l'oggetto non lo dice. Per la sessione Checkout il webhook
    passa qui un intent costruito con `amount_total` in tutti e due i campi.
    """
    return obj.get("amount_received", obj.get("amount"))


def apply_deposit_payment(appointment, intent_id: str, obj: dict, account: str = "") -> tuple[str, int]:
    """Applica il pagamento della caparra sotto lock; dice cosa è successo.

    Ritorna (esito, centesimi pagati in più della caparra attesa).

    L'appuntamento viene RILETTO dentro la transazione: due consegne dello
    stesso evento (Stripe le ripete) leggevano entrambe «richiesta» fuori da
    ogni lock e scrivevano entrambe «pagata», e il secondo incasso restava in
    cassa senza che nulla lo segnalasse. Qui si fanno solo scritture locali:
    rimborsi ed eventi li fa il chiamante, a lock rilasciato.
    """
    from apps.agenda.services import lock_salon  # lazy

    # Pigro anche questo: services.py ri-esporta questo modulo (compat), e un
    # import in testa chiuderebbe il ciclo.
    from .services import record_deposit_cashed  # lazy

    with transaction.atomic():
        # Prima il salone, come ogni scrittura in agenda (18-08, vedi checkout).
        lock_salon(appointment.salon)
        # La riga viene bloccata qui: una seconda consegna dello stesso evento
        # aspetta, e quando entra rilegge lo stato già aggiornato.
        if Appointment.objects.select_for_update().filter(pk=appointment.pk).first() is None:
            return "gone", 0
        appointment.refresh_from_db()
        client_name = appointment.client.full_name
        fields = [
            "deposit_status",
            "deposit_payment_intent_id",
            "deposit_due_at",
            "deposit_stripe_account",
            "updated_at",
        ]

        if appointment.deposit_status in DEPOSIT_RECEIVED_STATUSES:
            if intent_id and intent_id != appointment.deposit_payment_intent_id:
                return "duplicate", 0
            return "known", 0  # già elaborato: nulla da fare
        # Conto già chiuso o appuntamento non più in piedi: il denaro è arrivato
        # ma non copre più niente. Sul conto chiuso la caparra non è stata
        # detratta (era ancora «richiesta»), quindi il salone incasserebbe due
        # volte lo stesso servizio. Si segna «da rimborsare» e si restituisce.
        already_cashed = Sale.objects.filter(appointment=appointment).exists()
        if appointment.status in ("cancelled", "no_show", "closed") or already_cashed:
            appointment.deposit_status = "refund_due"
            appointment.deposit_payment_intent_id = intent_id
            appointment.deposit_due_at = None
            # Il rimborso va fatto sull'account dove i soldi sono arrivati.
            appointment.deposit_stripe_account = account or ""
            appointment.save(update_fields=fields)
            log_activity(
                appointment.salon,
                "deposit.paid_after_release",
                (
                    "Caparra pagata a conto già chiuso, da restituire"
                    if appointment.status == "closed" or already_cashed
                    else "Caparra pagata dopo l'annullamento, da restituire"
                )
                + f" — {client_name}",
                payload={
                    "appointment_id": appointment.id,
                    "payment_intent_id": intent_id,
                    "amount": str(appointment.deposit_amount),
                },
            )
            return "refund_due", 0
        if appointment.deposit_status != "required":
            log_activity(
                appointment.salon,
                "deposit.payment_ignored",
                f"Pagamento caparra ricevuto ma non atteso ({appointment.deposit_status}) — {client_name}",
                payload={"appointment_id": appointment.id, "payment_intent_id": intent_id},
            )
            return "ignored", 0
        expected = to_cents(appointment.deposit_amount)
        received = amount_received(obj)
        if received is not None and int(received) < expected:
            log_activity(
                appointment.salon,
                "deposit.payment_mismatch",
                f"Pagamento caparra insufficiente — {client_name}",
                payload={
                    "appointment_id": appointment.id,
                    "payment_intent_id": intent_id,
                    "expected_cents": expected,
                    "received_cents": int(received),
                },
            )
            return "mismatch", 0
        excess = int(received) - expected if received is not None else 0
        if excess > 0:
            # La caparra è scesa dopo l'invio del link (visita ridotta) e la
            # cliente ha pagato l'importo di prima: prima si registrava la
            # caparra nuova e la differenza restava su Stripe senza traccia
            # (05-07, 02-06). La caparra vale quanto è arrivato davvero — così
            # vendita-caparra, rimborsi e quota detraibile tornano con Stripe —
            # e l'eccedenza si restituisce subito dopo, a lock rilasciato.
            appointment.deposit_amount = from_cents(int(received))
            fields.append("deposit_amount")
        appointment.deposit_status = "paid"
        appointment.deposit_payment_intent_id = intent_id
        appointment.deposit_due_at = None  # caparra arrivata: niente più rilascio automatico
        appointment.deposit_stripe_account = account or ""
        appointment.save(update_fields=fields)
        log_activity(
            appointment.salon,
            "deposit.paid",
            f"Acconto pagato — {client_name}",
            payload={
                "appointment_id": appointment.id,
                "payment_intent_id": intent_id,
                "overpaid_cents": max(excess, 0),
            },
        )
        # La caparra è incasso del giorno in cui arriva: al checkout verrà
        # detratta da quanto resta da pagare, quindi non si conta due volte.
        record_deposit_cashed(appointment.salon, appointment, method=Payment.Method.CARD)
        return "paid", max(excess, 0)


def refund_overpaid_deposit(appointment, intent_id: str, cents: int, account: str) -> None:
    """Restituisce la parte di caparra pagata in più (link di un importo vecchio)."""
    from apps.agenda.services import record_deposit_refund  # lazy

    refund = stripe_service.refund_payment_intent(
        appointment.salon,
        intent_id,
        idempotency_key=f"deposit-overpaid-{appointment.salon_id}-{appointment.id}-{intent_id}",
        amount_cents=cents,
        account=account or "",
    )
    excess = from_cents(int(cents))
    if refund is not None:
        # Registrato come ogni rimborso: la quota detraibile al checkout torna
        # la caparra chiesta, e il denaro restituito esce dall'incasso.
        record_deposit_refund(
            appointment,
            refund_id=refund.get("id") or f"overpaid-{intent_id}",
            cents=int(refund.get("amount") or cents),
            status=refund.get("status") or "succeeded",
        )
    log_activity(
        appointment.salon,
        "deposit.overpaid",
        f"Caparra pagata in più (€ {excess}, link con l'importo di prima)"
        + (": restituita alla cliente" if refund is not None else ": da restituire a mano")
        + f" — {appointment.client.full_name}",
        payload={
            "appointment_id": appointment.id,
            "payment_intent_id": intent_id,
            "amount": str(excess),
            "refund_id": (refund or {}).get("id", ""),
        },
    )


def refund_duplicate_deposit(appointment, intent_id: str, obj: dict, account: str = "") -> None:
    """Seconda caparra incassata sullo stesso appuntamento: si restituisce.

    Succede quando restano aperti due link di pagamento e la cliente li paga
    entrambi. Prima l'evento veniva semplicemente ignorato: il salone teneva il
    doppio senza che nulla lo segnalasse. Il rimborso va sull'account da cui è
    arrivato QUESTO pagamento.
    """
    cents = amount_received(obj) or 0
    refund = stripe_service.refund_payment_intent(
        appointment.salon,
        intent_id,
        idempotency_key=f"duplicate-deposit-{appointment.salon_id}-{appointment.id}-{intent_id}",
        account=account or "",
    )
    log_activity(
        appointment.salon,
        "deposit.duplicate_payment",
        f"Seconda caparra incassata sullo stesso appuntamento — {appointment.client.full_name}"
        + ("" if refund is not None else " (rimborso da fare a mano)"),
        payload={
            "appointment_id": appointment.id,
            "payment_intent_id": intent_id,
            "already_paid_intent_id": appointment.deposit_payment_intent_id,
            "amount_cents": int(cents),
            "refund_id": (refund or {}).get("id", ""),
        },
    )
