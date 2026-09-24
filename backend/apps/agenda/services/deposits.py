"""Caparra: quanto chiederla, quanto ne coprono i regali, e il link di pagamento.

Le regole (`DepositRule`) si valutano sui fatti della cliente
(`clients.services.client_facts`); il link Stripe lo creano e lo chiudono le
funzioni di `sales.stripe_service`, sempre a transazione chiusa.
"""

import copy
import logging
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.core.models import DepositRule
from apps.core.services import log_activity
from common.conditions import evaluate
from common.money import CENT

from ..models import Appointment, AppointmentService
from .messages import _withdraw_deposit_messages

logger = logging.getLogger("youty.agenda")


def _rule_matches(rule, facts) -> bool:
    """Valuta le condizioni di una regola caparra senza poter far saltare la prenotazione.

    Le condizioni si scrivono dall'interfaccia: una regola malformata sollevava
    un'eccezione dentro `compute_deposit` e quindi bloccava OGNI prenotazione del
    salone finché qualcuno non la correggeva. Una regola che non si riesce a
    valutare semplicemente non si applica, e lascia una traccia nei log.
    """
    try:
        return bool(evaluate(rule.conditions, facts))
    except Exception:  # noqa: BLE001 - qualunque errore nella regola, non nel booking
        logger.warning(
            "Regola caparra #%s ignorata: condizioni non valutabili (%r)",
            rule.id, rule.conditions, exc_info=True,
        )
        return False


def spendable_gift_cards(salon, client_ids):
    """Gift card «a trattamento» che quelle clienti possono spendere adesso in salone.

    Attiva, pagata, non scaduta, con saldo, e della cliente: ne è la
    destinataria, oppure l'ha comprata lei senza indicare nessun destinatario
    (regalo a sé stessa). «Nessun destinatario» significa né scheda collegata né
    nome scritto a mano: una carta intestata a "Maria" resta di Maria anche se
    la sua scheda non esiste ancora, e non è un regalo di chi l'ha pagata.
    Lo stato EXPIRED lo scrive solo chi prova a riscattare: una carta scaduta da
    mesi resta «attiva» a database, quindi la scadenza si verifica qui.
    È la regola unica dell'agenda: la usano `presenters.gift_index` (i regali
    mostrati sulla visita) e la caparra (`gift_covered_amount`).
    """
    from apps.marketing.models import GiftCard  # lazy

    ids = {cid for cid in client_ids if cid}
    if not ids:
        return GiftCard.objects.none()
    now = timezone.now()
    return (
        GiftCard.objects.filter(
            salon=salon,
            status=GiftCard.Status.ACTIVE,
            payment_status=GiftCard.PaymentStatus.PAID,
            gift_service__isnull=False,
            balance__gt=0,
        )
        .filter(Q(expires_at__isnull=True) | Q(expires_at__gte=now))
        .filter(
            Q(recipient_client_id__in=ids)
            | Q(recipient_client__isnull=True, recipient_name="", buyer_client_id__in=ids)
        )
    )


def gift_covered_amount(salon, client, lines) -> Decimal:
    """Quanto del conto pagano già le gift card «a trattamento» della cliente.

    `lines` = [(service, price), ...]. Ogni carta copre un solo servizio del suo
    tipo, fino al suo saldo: è quello che la cassa scalerà al checkout. Il
    resto la cliente lo paga in salone, ed è su quello che si calcola la
    caparra: chiederla su un taglio regalato voleva dire far pagare in anticipo
    un trattamento già pagato (e, con la scadenza, liberarle il posto se non lo
    faceva) mentre l'app le diceva «in salone non pagherai questa parte».
    """
    cards = list(spendable_gift_cards(salon, [getattr(client, "id", None)]))
    covered = Decimal("0.00")
    for service, price in lines:
        card = next((c for c in cards if c.gift_service_id == service.id), None)
        if card is None:
            continue
        cards.remove(card)
        covered += min(Decimal(str(price or 0)), Decimal(str(card.balance or 0)))
    return covered


def compute_deposit(salon, client, total_price) -> Decimal:
    """Importo del deposito richiesto per il cliente sul totale indicato.

    - client.deposit_always -> prima regola attiva qualunque (per priority);
    - altrimenti prima DepositRule attiva le cui conditions matchano i facts
      del cliente (clients.services.client_facts);
    - pct -> percentuale del totale, fixed -> importo. 0 se nessuna regola.

    L'importo non supera mai il totale: una regola a importo fisso di 50 € su un
    servizio da 30 € rendeva il conto impossibile da chiudere (la cassa avrebbe
    dovuto incassare −20 €).
    """
    total_price = Decimal(str(total_price or 0))
    rules = list(DepositRule.objects.filter(salon=salon, active=True))  # ordering: priority
    if not rules:
        return Decimal("0.00")

    if getattr(client, "deposit_always", False):
        rule = rules[0]
    else:
        from apps.clients.services import client_facts  # lazy

        facts = client_facts(client)
        rule = next((r for r in rules if _rule_matches(r, facts)), None)

    if rule is None:
        return Decimal("0.00")
    if rule.amount_type == DepositRule.AmountType.PERCENT:
        amount = (total_price * rule.amount / Decimal("100")).quantize(CENT)
    else:
        amount = Decimal(rule.amount).quantize(CENT)
    return min(max(amount, Decimal("0.00")), total_price.quantize(CENT))


def shrink_deposit_to_total(appointment: Appointment, *, actor=None) -> Decimal:
    """Allinea la caparra a una visita che si è accorciata (servizio staccato o tolto).

    Caparra ancora da pagare: scende al nuovo totale, e il link già mandato —
    che chiede l'importo di prima — viene chiuso e rifatto a transazione
    conclusa. Prima restava quello vecchio: la cliente pagava 70 per una
    caparra scesa a 30 e i 40 in più restavano su Stripe senza traccia (02-06,
    05-07).

    Caparra già versata: è denaro incassato e l'importo NON si tocca. Prima
    scendeva al nuovo totale, così la quota detraibile non vedeva più
    l'eccedenza (la cliente la perdeva) e, se lo staff la rimborsava come
    chiedeva il registro, i rimborsi si confrontavano con la caparra ridotta e
    la sottraevano una seconda volta: caparra «rimborsata», credito zero, la
    cliente ripagava la visita (02-01, 05-06). Ora il checkout detrae fino al
    totale e restituisce da sé l'eccedenza (`settle_deposit_excess`).

    Ritorna l'eccedenza (0 se non c'era).
    """
    total = sum(
        (item.price for item in AppointmentService.objects.filter(appointment=appointment)),
        start=Decimal("0"),
    ).quantize(CENT)
    amount = Decimal(str(appointment.deposit_amount or 0)).quantize(CENT)

    if appointment.deposit_status == Appointment.DepositStatus.PAID:
        excess = appointment.deposit_credit - total
        if excess > 0:
            log_activity(
                appointment.salon,
                "deposit.excess",
                f"Caparra superiore alla visita: al conto si detraggono {total} €, "
                f"{excess} € tornano alla cliente — {appointment.client.full_name}",
                actor=actor,
                payload={
                    "appointment_id": appointment.id,
                    "amount": str(excess),
                    "deposit_amount": str(amount),
                    "total": str(total),
                    "reason": "visita ridotta",
                },
            )
        return max(excess, Decimal("0.00"))

    excess = amount - total
    if excess <= 0 or appointment.deposit_status != Appointment.DepositStatus.REQUIRED:
        return max(excess, Decimal("0.00"))

    appointment.deposit_amount = total
    if total <= 0:
        # Visita scesa a 0 € (il listino ammette servizi a 0 €): non resta
        # niente da pagare. La caparra restava «richiesta» a 0 € con la sua
        # scadenza: l'incasso al banco rispondeva «Nessuna caparra da
        # incassare», ma allo scadere il posto si liberava lo stesso, con
        # «posto liberato, caparra non versata» alla cliente. E il link di
        # prima restava pagabile: rifarlo a 0 € non chiudeva la sessione
        # vecchia. Ora la caparra non c'è più: niente scadenza né rilascio, il
        # link non ancora partito non parte e quello inviato si chiude su Stripe.
        from .deposit_holds import clear_deposit_hold  # lazy: deposit_holds importa questo modulo

        appointment.deposit_status = Appointment.DepositStatus.NONE
        appointment.save(update_fields=["deposit_amount", "deposit_status", "updated_at"])
        clear_deposit_hold(appointment)
        _withdraw_deposit_messages(appointment)
        close_deposit_link_after_commit(appointment)
        return excess
    appointment.save(update_fields=["deposit_amount", "updated_at"])
    if appointment.deposit_payment_link or appointment.deposit_checkout_session_id:
        # Il link nuovo deve leggere la caparra già ridotta.
        renew_deposit_link_after_commit(
            appointment.pk,
            actor=actor,
            log_message="Link caparra non rifatto dopo la riduzione (appuntamento %s)",
        )
    return excess


def send_deposit_link(appointment: Appointment) -> None:
    """Se la caparra è richiesta e i pagamenti online sono attivi, prepara il link
    di pagamento (e lo accoda alla cliente). Mai bloccante per la prenotazione."""
    if appointment.deposit_status != Appointment.DepositStatus.REQUIRED:
        return
    try:
        from apps.sales.stripe_service import ensure_deposit_link  # lazy

        ensure_deposit_link(appointment)
    except Exception:  # pragma: no cover - dipende da Stripe
        logger.exception("Link caparra non creato per l'appuntamento %s", appointment.id)


def renew_deposit_link_after_commit(
    appointment_id: int, *, actor=None, log_message: str, warn: bool = False
) -> None:
    """Rifà e rimanda il link della caparra con l'importo attuale, a transazione conclusa.

    Dopo il commit e fuori dal lock: si parla con Stripe, e si rilegge
    l'appuntamento per partire dall'importo appena scritto. Un errore non
    annulla il gesto, già salvato (il link si rimanda dalla scheda): finisce
    nel registro con `log_message` (%s = l'appuntamento), come errore o, con
    `warn`, come avviso.
    """

    def renew():
        from apps.sales.stripe_service import ensure_deposit_link  # lazy

        fresh = (
            Appointment.objects.select_related("salon", "salon__settings", "client")
            .filter(pk=appointment_id)
            .first()
        )
        if fresh is None:
            return
        try:
            ensure_deposit_link(fresh, resend=True, actor=actor, reason="amount_changed")
        except Exception:  # noqa: BLE001 — il gesto è salvo, il link si rimanda a mano
            if warn:
                logger.warning(log_message, appointment_id, exc_info=True)
            else:
                logger.exception(log_message, appointment_id)

    transaction.on_commit(renew)


def close_deposit_link_after_commit(appointment: Appointment) -> None:
    """Chiude su Stripe la sessione del link caparra, a transazione chiusa.

    Il link restava pagabile dopo l'annullamento, il rilascio per caparra non
    pagata o il «torna indietro» di una prenotazione: la cliente pagava lo
    stesso, e il salone rimborsava perdendo le commissioni (o i soldi finivano
    su un appuntamento che non esisteva più). La chiamata a Stripe parte dopo
    il commit, fuori da ogni lock; un suo errore non annulla niente.
    """
    if not appointment.deposit_checkout_session_id:
        return
    snapshot = copy.copy(appointment)  # l'undo cancella la riga subito dopo

    def close():
        from apps.sales.stripe_service import expire_deposit_checkout  # lazy

        try:
            expire_deposit_checkout(snapshot)
        except Exception:  # noqa: BLE001 — il gesto è fatto, il link è un di più
            logger.warning(
                "Link caparra non chiuso (appuntamento %s)", snapshot.pk, exc_info=True
            )

    transaction.on_commit(close)
