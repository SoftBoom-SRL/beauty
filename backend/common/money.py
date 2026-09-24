"""Importi in euro: il centesimo, il tetto delle colonne, le conversioni in centesimi.

Gli importi stanno a database in `DecimalField(max_digits=10, decimal_places=2)`
e vanno a Stripe in centesimi interi. Le conversioni erano riscritte a mano con
la stessa formula in stripe_service, nell'agenda e nelle vendite, e il tetto in
tre costanti con tre nomi: qui c'è un posto solo.

Arrotondamento: queste funzioni usano quello del contesto decimale, cioè
ROUND_HALF_EVEN (nel progetto nessuno lo cambia), esattamente come le copie che
sostituiscono. Chi deve arrotondare ROUND_HALF_UP continua a scriverlo accanto
a `quantize`, com'è oggi: `x.quantize(CENT, rounding=ROUND_HALF_UP)`.
"""

from decimal import Decimal

# Un centesimo, il quanto di ogni importo: `x.quantize(CENT)` è
# `x.quantize(Decimal("0.01"))`, con lo stesso arrotondamento.
CENT = Decimal("0.01")

# Il massimo che entra in `DecimalField(max_digits=10, decimal_places=2)`: oltre,
# il salvataggio esplode in un 500 invece di un errore che dice cosa correggere.
# Era scritto tre volte: `MAX_MONEY` nel marketing, `MAX_MONTHLY_BUDGET` e
# `MAX_RULE_AMOUNT` nelle impostazioni.
MAX_MONEY = Decimal("99999999.99")


def to_cents(amount) -> int:
    """Euro → centesimi interi: `Decimal("12.34")` → 1234.

    Stessa formula di `agenda.services._to_cents`: il valore passa da `str`
    (Decimal, int, float o stringa), None, "" e 0 valgono 0, e una frazione di
    centesimo si arrotonda come il contesto decimale (0.125 → 12, 0.135 → 14).

    Ha preso il posto anche della copia di `stripe_service`, che era uguale ma
    senza `or 0` (con None o "" sollevava `decimal.InvalidOperation`): i suoi
    chiamanti passano un importo già controllato maggiore di zero, o
    `deposit_amount or 0` (il webhook delle caparre), quindi per loro non è
    cambiato nulla.
    """
    return int((Decimal(str(amount or 0)) * 100).quantize(Decimal("1")))


def from_cents(cents) -> Decimal:
    """Centesimi → euro con due decimali: 1250 → `Decimal("12.50")`, 0 → `Decimal("0.00")`.

    Stessa formula delle copie in vendite e agenda. Con centesimi interi la
    divisione è esatta, quindi `quantize` fissa solo i due decimali. None non è
    ammesso (TypeError, come nelle copie): chi può averlo lo scrive, `from_cents(x or 0)`.
    """
    return (Decimal(cents) / 100).quantize(CENT)
