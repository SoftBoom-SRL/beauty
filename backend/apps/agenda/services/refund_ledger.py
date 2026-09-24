"""Conti dei rimborsi della caparra: stati Stripe e somme in centesimi.

Funzioni pure sul dizionario `Appointment.deposit_refunds` (una voce per id di
rimborso Stripe); euro e centesimi si convertono con `common.money`. Le usa
anche sales per sapere quanta caparra resta in cassa (`deposit_retained`) e
quanto esce dall'incasso del giorno (`sync_deposit_refunds`).
"""


# Stati Stripe di un rimborso: solo «succeeded» è denaro tornato alla cliente.
REFUND_DONE = "succeeded"
REFUND_IN_FLIGHT = ("pending", "requires_action")
# Rimborsi che non restituiranno niente: il denaro resta (o torna) al salone.
REFUND_GONE = ("failed", "canceled")
# Voce di `deposit_refunds` con il totale restituito dichiarato da
# `charge.refunded`, che non porta l'id del singolo rimborso: vale come
# soglia minima. Prima non si salvava, e l'evento successivo la dimenticava.
REFUND_FLOOR_KEY = "charge.refunded"
# Un aggiornamento non può riportare indietro un rimborso: Stripe non garantisce
# l'ordine degli eventi, e un `refund.created` «pending» arrivato in ritardo
# faceva tornare «in corso» un rimborso già riuscito (05-14). Da riuscito si
# può ancora passare a fallito: Stripe lo fa, di rado.
_REFUND_STATUS_RANK = {"pending": 0, "requires_action": 0, "succeeded": 1, "failed": 2, "canceled": 2}


def _refund_sums(refunds: dict) -> tuple[int, int, int, int]:
    """Centesimi dei rimborsi registrati: (riusciti, in volo, falliti, pavimento)."""
    done = in_flight = gone = 0
    for key, row in (refunds or {}).items():
        if key == REFUND_FLOOR_KEY:
            continue
        cents = int(row.get("amount_cents") or 0)
        status = row.get("status") or ""
        if status == REFUND_DONE:
            done += cents
        elif status in REFUND_IN_FLIGHT:
            in_flight += cents
        elif status in REFUND_GONE:
            gone += cents
    floor = int(((refunds or {}).get(REFUND_FLOOR_KEY) or {}).get("amount_cents") or 0)
    return done, in_flight, gone, floor


def _refunds_done_cents(refunds: dict) -> int:
    """Centesimi davvero tornati alla cliente.

    Dei rimborsi con id contano i riusciti. Il totale dichiarato da
    `charge.refunded` (`REFUND_FLOOR_KEY`) copre anche quelli fatti dalla
    dashboard Stripe, che arrivano solo da lì; ma non si sa se Stripe ci conti
    anche i rimborsi ancora in volo, e resta il massimo visto anche dopo un
    rimborso fallito. Al pavimento si tolgono quindi quelli in volo e quelli
    falliti che hanno un id: contati come riusciti nel pavimento e poi di
    nuovo come in volo, un rimborso di dieci euro ancora in corso faceva
    detrarre alla cassa dieci euro invece di venti; e un rimborso fallito dopo
    il pavimento lasciava la caparra «rimborsata» con i soldi al salone.
    Con una riga per ogni rimborso (Stripe manda sempre refund.created e
    refund.updated) il conto torna in tutti e due i casi.
    """
    done, in_flight, gone, floor = _refund_sums(refunds)
    return max(done, floor - in_flight - gone)


def _refunds_committed_cents(refunds: dict) -> int:
    """Centesimi restituiti o in via di restituzione (vedi `_refunds_done_cents`)."""
    done, in_flight, gone, floor = _refund_sums(refunds)
    return max(done + in_flight, floor - gone)
