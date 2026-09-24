"""Rimborsi della caparra: il tentativo su Stripe, gli esiti registrati, la conferma a mano.

I conti (centesimi riusciti, in volo, falliti) sono in `refund_ledger`; qui si
scrive lo stato del deposito, sotto lock salone → riga come ogni altra
scrittura sull'agenda.
"""

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.services import log_activity
from common.money import from_cents, to_cents

from ..models import Appointment
from .locking import _lock_row
from .refund_ledger import (
    _REFUND_STATUS_RANK,
    REFUND_DONE,
    REFUND_FLOOR_KEY,
    REFUND_GONE,
    _refund_sums,
    _refunds_done_cents,
)


def settle_deposit_refund(appointment: Appointment, *, actor=None) -> Appointment:
    """Prova il rimborso Stripe della caparra «da rimborsare»; se riesce → «rimborsata».

    Se non è possibile (Stripe assente, caparra incassata in salone, errore)
    lo stato resta «da rimborsare» e il registro attività lo segnala: il
    rimborso va fatto a mano e poi confermato con `mark_deposit_refunded`.
    """
    from apps.sales.stripe_service import as_dict, refund_deposit  # lazy

    if appointment.deposit_status != Appointment.DepositStatus.REFUND_DUE:
        return appointment
    client_name = appointment.client.full_name
    refund = refund_deposit(appointment)
    if refund is not None:
        # Il Refund di stripe-python non è un dict: `.get()` esplodeva DOPO che
        # Stripe aveva già restituito i soldi, e la caparra restava «da rimborsare».
        refund = as_dict(refund)
        # Lo stato lo decide Stripe, non il fatto che la chiamata sia passata:
        # un rimborso «pending» non è denaro già tornato alla cliente.
        record_deposit_refund(
            appointment,
            refund_id=refund.get("id") or f"deposit-refund-{appointment.id}",
            cents=int(refund.get("amount") or 0) or to_cents(appointment.deposit_amount),
            status=refund.get("status") or REFUND_DONE,
            actor=actor,
        )
    else:
        log_activity(
            appointment.salon,
            "deposit.refund_due",
            f"Caparra da rimborsare manualmente — {client_name}",
            actor=actor,
            payload={"appointment_id": appointment.id, "amount": str(appointment.deposit_amount)},
        )
    return appointment


def _sync_refund_moves(appointment: Appointment) -> None:
    """Il rimborso esce dalla cassa del giorno in cui avviene (vedi sales.DepositRefund)."""
    from apps.sales.services import sync_deposit_refunds  # lazy

    sync_deposit_refunds(appointment)


@transaction.atomic
def record_deposit_refund(
    appointment: Appointment,
    *,
    refund_id: str = "",
    cents: int = 0,
    status: str = REFUND_DONE,
    floor_cents: int = 0,
    actor=None,
) -> Appointment:
    """Registra un rimborso della caparra e ricalcola lo stato del deposito.

    I rimborsi si conservano uno per id Stripe: lo stesso evento ripetuto non
    conta due volte e un aggiornamento successivo (pending → succeeded, oppure
    → failed) corregge quello registrato prima — ma non lo riporta indietro:
    un evento vecchio arrivato tardi non conta (vedi `_REFUND_STATUS_RANK`).
    «Rimborsata» si scrive solo quando i rimborsi RIUSCITI coprono l'intera
    caparra; un rimborso parziale lascia la caparra pagata e riduce soltanto la
    quota detraibile al checkout.

    `floor_cents` è il totale già restituito dichiarato da `charge.refunded`:
    quell'evento non porta l'id del singolo rimborso, quindi vale come soglia
    minima e non come voce a sé. Si conserva (il massimo visto), altrimenti
    l'evento seguente lo dimenticava e lo stato restava «rimborsata» con zero
    euro restituiti.

    I confronti sono con `deposit_amount`, che per una caparra pagata è quanto
    è arrivato davvero (una visita accorciata non lo abbassa più).
    """
    # Prima il salone, poi la riga: lo stesso ordine di chi modifica l'agenda.
    # Al contrario, su PostgreSQL un rimborso e uno spostamento dello stesso
    # appuntamento potevano aspettarsi a vicenda (18-08).
    # Lock di riga PRIMA della rilettura: `deposit_refunds` si legge, si
    # modifica e si riscrive per intero. Stripe consegna gli eventi in
    # parallelo, e due rimborsi parziali finivano per sovrascriversi a vicenda —
    # il secondo commit cancellava la voce del primo e al checkout si detraeva
    # denaro già tornato alla cliente.
    _lock_row(appointment)
    refunds = dict(appointment.deposit_refunds or {})
    ignored_update = False
    if refund_id:
        known = refunds.get(refund_id) or {}
        rank = _REFUND_STATUS_RANK.get(status or "", 0)
        if known and _REFUND_STATUS_RANK.get(known.get("status") or "", 0) > rank:
            ignored_update = True
        else:
            refunds[refund_id] = {**known, "amount_cents": int(cents or 0), "status": status}
    if floor_cents:
        floor = refunds.get(REFUND_FLOOR_KEY) or {}
        if int(floor_cents) > int(floor.get("amount_cents") or 0):
            refunds[REFUND_FLOOR_KEY] = {"amount_cents": int(floor_cents), "status": "floor"}

    done = _refunds_done_cents(refunds)
    in_flight = _refund_sums(refunds)[1]
    deposit_cents = to_cents(appointment.deposit_amount)

    previous = appointment.deposit_status
    if deposit_cents > 0 and done >= deposit_cents:
        new_status = Appointment.DepositStatus.REFUNDED
    elif in_flight > 0:
        # Anche un rimborso PARZIALE in volo rende la caparra «in corso»: la
        # quota mostrata alla cassa è zero finché Stripe non conferma, e il
        # checkout restituisce da sé la parte che non ha detratto
        # (sales.services.deposit_retained). Lasciarla «pagata» avrebbe fatto
        # detrarre anche i soldi che stanno tornando alla cliente.
        new_status = Appointment.DepositStatus.REFUNDING
    elif previous in (Appointment.DepositStatus.REFUNDING, Appointment.DepositStatus.REFUNDED):
        # Il rimborso in volo è fallito o è stato annullato (o uno riuscito è
        # stato poi respinto): il denaro è ancora in cassa. Se l'appuntamento è
        # annullato resta da restituire, se è ancora in piedi la caparra torna
        # semplicemente pagata.
        new_status = (
            Appointment.DepositStatus.REFUND_DUE
            if appointment.status == Appointment.Status.CANCELLED
            else Appointment.DepositStatus.PAID
        )
    else:
        new_status = previous

    appointment.deposit_refunds = refunds
    appointment.deposit_refunded_amount = from_cents(done)
    appointment.deposit_status = new_status
    appointment.save(
        update_fields=[
            "deposit_refunds",
            "deposit_refunded_amount",
            "deposit_status",
            "updated_at",
        ]
    )
    _sync_refund_moves(appointment)
    failed_meanwhile = (
        not ignored_update
        and refund_id
        and status in REFUND_GONE
        and new_status == previous == Appointment.DepositStatus.REFUNDED
    )
    if new_status != previous or failed_meanwhile:
        labels = {
            Appointment.DepositStatus.REFUNDED: "Caparra rimborsata",
            Appointment.DepositStatus.REFUNDING: "Rimborso caparra in corso",
            Appointment.DepositStatus.REFUND_DUE: "Rimborso caparra non riuscito, da rifare",
            Appointment.DepositStatus.PAID: "Rimborso caparra non riuscito",
        }
        label = labels.get(new_status, "Caparra aggiornata")
        if failed_meanwhile:
            # Stripe dichiara restituito il totale ma segnala un rimborso
            # fallito: lo stato resta, e qualcuno deve guardarci.
            label = "Stripe segnala un rimborso della caparra non riuscito: controlla il pagamento"
        log_activity(
            appointment.salon,
            "deposit.refunded" if new_status == Appointment.DepositStatus.REFUNDED and not failed_meanwhile
            else "deposit.refund_update",
            f"{label} — {appointment.client.full_name}",
            actor=actor,
            payload={
                "appointment_id": appointment.id,
                "refunded": str(appointment.deposit_refunded_amount),
                "amount": str(appointment.deposit_amount),
                "refund_id": refund_id,
                "status": status,
            },
        )
    return appointment


@transaction.atomic
def mark_deposit_refunded(appointment: Appointment, *, actor=None) -> Appointment:
    """Conferma manuale dello staff: la caparra «da rimborsare» è stata restituita.

    Scrive anche l'importo e una voce fra i rimborsi: `deposit_refunded_amount`
    è «la somma dei rimborsi riusciti», e dopo una conferma manuale restava a
    zero — il dettaglio diceva «rimborsata» senza importo e le riconciliazioni
    che sommano quel campo saltavano i rimborsi fatti in salone. Il rimborso
    esce anche dall'incasso del giorno (02-11): prima la caparra da 20 € resa in
    contanti restava in «Incassato oggi».

    Lock e rilettura prima di decidere, come per i rimborsi Stripe: la conferma
    arrivava su una copia letta all'inizio della richiesta e poteva cancellare
    un rimborso registrato un istante prima dal webhook.
    """
    _lock_row(appointment)
    if appointment.deposit_status != Appointment.DepositStatus.REFUND_DUE:
        raise HttpError(400, "La caparra di questo appuntamento non è in attesa di rimborso")
    deposit_cents = to_cents(appointment.deposit_amount)
    refunds = dict(appointment.deposit_refunds or {})
    # Quello che resta da coprire: se una parte era già tornata da Stripe, la
    # conferma manuale vale solo per la differenza.
    missing = max(deposit_cents - _refunds_done_cents(refunds), 0)
    if missing:
        refunds[f"manual-{appointment.id}-{int(timezone.now().timestamp())}"] = {
            "amount_cents": missing,
            "status": REFUND_DONE,
            "manual": True,
        }
    appointment.deposit_status = Appointment.DepositStatus.REFUNDED
    appointment.deposit_refunds = refunds
    appointment.deposit_refunded_amount = from_cents(_refunds_done_cents(refunds))
    appointment.save(
        update_fields=[
            "deposit_status",
            "deposit_refunds",
            "deposit_refunded_amount",
            "updated_at",
        ]
    )
    _sync_refund_moves(appointment)
    log_activity(
        appointment.salon,
        "deposit.refunded",
        f"Caparra rimborsata — {appointment.client.full_name}",
        actor=actor,
        payload={
            "appointment_id": appointment.id,
            "amount": str(appointment.deposit_amount),
            "refunded": str(appointment.deposit_refunded_amount),
            "manual": True,
        },
    )
    return appointment
