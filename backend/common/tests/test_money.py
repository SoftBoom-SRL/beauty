"""`common.money` contro le copie che sostituisce (trascritte com'erano al commit 4ecefc8)."""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.test import SimpleTestCase

from common.money import CENT, MAX_MONEY, from_cents, to_cents


def _agenda_to_cents(amount) -> int:
    # agenda/services.py `_to_cents`.
    return int((Decimal(str(amount or 0)) * 100).quantize(Decimal("1")))


def _stripe_to_cents(amount) -> int:
    # sales/stripe_service.py `_to_cents`: senza `or 0`.
    return int((Decimal(str(amount)) * 100).quantize(Decimal("1")))


def _excess_cents(excess) -> int:
    # sales/services.py `settle_deposit_excess`, su un Decimal già a due decimali.
    return int((excess * 100).quantize(Decimal("1")))


def _copied_from_cents(cents) -> Decimal:
    # sales/api.py, sales/services.py, agenda/services.py.
    return (Decimal(cents) / 100).quantize(Decimal("0.01"))


# Da -3.000 a 3.000 al millesimo: tutte le frazioni di centesimo, segni compresi.
_AMOUNTS = [Decimal(n) / 1000 for n in range(-3000, 3001)]


class ConstantsTests(SimpleTestCase):
    def test_cent_is_two_decimal_places(self):
        self.assertEqual(CENT, Decimal("0.01"))
        self.assertEqual(str(CENT), "0.01")
        self.assertEqual(Decimal("2.345").quantize(CENT), Decimal("2.345").quantize(Decimal("0.01")))
        self.assertEqual(
            Decimal("2.345").quantize(CENT, rounding=ROUND_HALF_UP), Decimal("2.35")
        )

    def test_max_money_is_the_largest_value_of_the_money_columns(self):
        # DecimalField(max_digits=10, decimal_places=2).
        self.assertEqual(MAX_MONEY, Decimal("99999999.99"))
        sign, digits, exponent = MAX_MONEY.as_tuple()
        self.assertEqual((sign, len(digits), exponent), (0, 10, -2))
        self.assertEqual(set(digits), {9})


class ToCentsTests(SimpleTestCase):
    def test_plain_amounts(self):
        self.assertEqual(to_cents(Decimal("12.34")), 1234)
        self.assertEqual(to_cents(Decimal("30.00")), 3000)
        self.assertEqual(to_cents(10), 1000)
        self.assertEqual(to_cents("7.5"), 750)
        self.assertEqual(to_cents(12.3), 1230)
        self.assertEqual(to_cents(0.1 + 0.2), 30)
        self.assertIs(type(to_cents(Decimal("1.00"))), int)

    def test_empty_values_are_zero(self):
        for empty in (None, "", 0, 0.0, Decimal("0"), Decimal("0.00"), False):
            self.assertEqual(to_cents(empty), 0, repr(empty))

    def test_fractions_of_a_cent_round_half_even(self):
        self.assertEqual(to_cents(Decimal("0.125")), 12)
        self.assertEqual(to_cents(Decimal("0.135")), 14)
        self.assertEqual(to_cents(Decimal("0.005")), 0)
        self.assertEqual(to_cents(Decimal("0.015")), 2)
        self.assertEqual(to_cents(Decimal("12.345")), 1234)
        self.assertEqual(to_cents(Decimal("-1.235")), -124)

    def test_same_result_as_the_agenda_copy(self):
        for amount in [*_AMOUNTS, None, "", 0, "12.3456", 99.999, MAX_MONEY]:
            self.assertEqual(to_cents(amount), _agenda_to_cents(amount), repr(amount))

    def test_same_result_as_the_stripe_copy_except_on_empty_values(self):
        for amount in _AMOUNTS:
            if amount:
                self.assertEqual(to_cents(amount), _stripe_to_cents(amount), amount)
        # L'unica differenza: senza `or 0` la copia di Stripe non accetta vuoti.
        for empty in (None, "", False):
            with self.assertRaises(InvalidOperation):
                _stripe_to_cents(empty)

    def test_same_result_as_the_excess_refund(self):
        for amount in _AMOUNTS:
            excess = amount.quantize(Decimal("0.01"))
            if excess > 0:
                self.assertEqual(to_cents(excess), _excess_cents(excess), excess)


class FromCentsTests(SimpleTestCase):
    def test_plain_values(self):
        self.assertEqual(str(from_cents(1250)), "12.50")
        self.assertEqual(str(from_cents(0)), "0.00")
        self.assertEqual(str(from_cents(1)), "0.01")
        self.assertEqual(str(from_cents(-5)), "-0.05")
        self.assertEqual(str(from_cents(9999999999)), "99999999.99")
        self.assertEqual(from_cents(9999999999), MAX_MONEY)

    def test_always_two_decimal_places(self):
        for cents in (0, 7, 100, 12345, -300):
            self.assertEqual(from_cents(cents).as_tuple().exponent, -2, cents)

    def test_same_result_as_the_copies(self):
        for cents in [*range(-2000, 2001), 9999999999, "1250"]:
            got, want = from_cents(cents), _copied_from_cents(cents)
            self.assertEqual((got, str(got)), (want, str(want)), cents)

    def test_round_trip(self):
        for cents in range(-2000, 2001):
            self.assertEqual(to_cents(from_cents(cents)), cents)

    def test_none_is_refused_like_in_the_copies(self):
        with self.assertRaises(TypeError):
            from_cents(None)
        with self.assertRaises(TypeError):
            _copied_from_cents(None)
