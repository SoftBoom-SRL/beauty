"""Coupon: i valori ammessi, la validità al banco, lo sconto in euro, il consumo.

Stavano in services.py (validità, sconto, consumo) e in api.py (i limiti del
valore). `validate_coupon`, `coupon_discount` e `mark_coupon_redeemed` li
chiama anche la cassa (apps.sales.services, import pigro): le firme NON vanno
cambiate.
"""

from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Case, F, Q, Value, When
from django.utils import timezone
from ninja.errors import HttpError

from common.money import CENT, MAX_MONEY

from .codes import mark_expired_if_past
from .models import Coupon


def validate_coupon_value(kind: str, value: Decimal) -> Decimal:
    """Un buono deve scontare qualcosa, e non più del conto.

    Senza questi controlli passavano un «-20 €» (che aumentava il totale), uno
    «sconto del 500%» mostrato tale e quale nel portafoglio della cliente, e
    valori fuori scala che facevano fallire la scrittura.
    """
    value = Decimal(str(value))
    if value <= 0:
        raise HttpError(422, "Il valore del coupon dev'essere maggiore di zero")
    if kind == Coupon.Kind.PERCENT and value > 100:
        raise HttpError(422, "Uno sconto percentuale non può superare il 100%")
    if value > MAX_MONEY:
        raise HttpError(422, "Valore del coupon fuori scala")
    return value


def validate_coupon(salon, code, client=None):
    """Ritorna il coupon se attivo, non scaduto e (se client-bound) del cliente."""
    coupon = Coupon.objects.filter(salon=salon, code=code).first()
    if coupon is None:
        raise HttpError(404, "Coupon non trovato")
    if mark_expired_if_past(coupon):
        raise HttpError(422, "Coupon scaduto")
    if coupon.status != Coupon.Status.ACTIVE:
        raise HttpError(422, "Coupon non più valido")
    # Un coupon intestato vale SOLO per la sua cliente. Prima `client is None`
    # faceva passare il controllo: su una vendita anonima (il caso più comune al
    # banco) chiunque presentasse il codice di qualcun altro otteneva lo sconto.
    if coupon.client_id and (client is None or coupon.client_id != client.id):
        raise HttpError(422, "Coupon riservato a un altro cliente: intestalo alla vendita")
    return coupon


def coupon_discount(coupon, base) -> Decimal:
    """Sconto in euro che il coupon vale su un imponibile di `base`.

    Mai più dell'imponibile: un buono da 50 € su un conto da 30 sconta 30, non
    trasforma la cassa in un bancomat. Tutto in Decimal, come il resto del
    denaro: con i float un 33% su 89,90 arrivava a cifre che non si scrivono su
    uno scontrino.
    """
    base = Decimal(str(base or 0))
    if base <= 0:
        return Decimal("0.00")
    value = Decimal(str(coupon.value))
    if coupon.kind == Coupon.Kind.PERCENT:
        value = base * value / Decimal(100)
    return min(value, base).quantize(CENT, rounding=ROUND_HALF_UP)


def validate_max_uses(max_uses, uses: int = 0):
    """Utilizzi massimi di un buono: None (senza limite) o almeno 1, e mai
    meno di quelli già fatti (il buono tornerebbe «attivo» e oltre il limite)."""
    if max_uses is None:
        return None
    if max_uses < 1:
        raise HttpError(422, "Gli utilizzi massimi devono essere almeno 1 (o senza limite)")
    if max_uses <= uses:
        raise HttpError(422, f"Il coupon è già stato usato {uses} volte: indica un numero più alto")
    return max_uses


def consume_coupon(salon, coupon_id: int, sale=None) -> bool:
    """Un utilizzo del coupon, legato alla vendita; False se non è più usabile.

    Una sola UPDATE filtrata su status='active' e sugli utilizzi rimasti: è il
    database a decidere chi arriva primo. Con il leggi-poi-scrivi, due banchi
    che battono lo stesso codice nello stesso istante lo troverebbero attivo
    entrambi e lo scalerebbero due volte (o oltre il limite). All'ultimo
    utilizzo il buono diventa «utilizzato»; senza limite resta attivo.
    """
    return bool(
        Coupon.objects.filter(pk=coupon_id, salon=salon, status=Coupon.Status.ACTIVE)
        .filter(Q(max_uses__isnull=True) | Q(uses__lt=F("max_uses")))
        .update(
            uses=F("uses") + 1,
            status=Case(
                When(
                    max_uses__isnull=False,
                    max_uses__lte=F("uses") + 1,
                    then=Value(Coupon.Status.REDEEMED.value),
                ),
                default=F("status"),
            ),
            redeemed_at=timezone.now(),
            sale=sale,
        )
    )


def mark_coupon_redeemed(coupon, sale) -> bool:
    """Consuma un utilizzo del coupon legandolo alla vendita; False se qualcuno
    l'ha già finito (vedi `consume_coupon`)."""
    return consume_coupon(coupon.salon_id, coupon.pk, sale)
