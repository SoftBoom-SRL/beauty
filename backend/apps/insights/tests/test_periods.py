"""Periodi degli insight: mese, trimestre, anno e intervallo libero, con le
date impossibili o fuori scala rifiutate.

Caccia del 22/09:
- 08-16: date inesistenti o fuori scala → 400, non 500.
"""

from datetime import date

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Salon
from common.testing import bearer

from ..services import custom_range, period_range, resolve_range


class PeriodRangeTests(TestCase):
    def test_month(self):
        start, end = period_range("month", date(2026, 7, 15))
        self.assertEqual(start.date(), date(2026, 7, 1))
        self.assertEqual(end.date(), date(2026, 8, 1))

    def test_quarter(self):
        start, end = period_range("quarter", date(2026, 8, 10))
        self.assertEqual(start.date(), date(2026, 7, 1))
        self.assertEqual(end.date(), date(2026, 10, 1))

    def test_quarter_year_boundary(self):
        start, end = period_range("quarter", date(2026, 12, 20))
        self.assertEqual(start.date(), date(2026, 10, 1))
        self.assertEqual(end.date(), date(2027, 1, 1))

    def test_year(self):
        start, end = period_range("year", date(2026, 3, 1))
        self.assertEqual(start.date(), date(2026, 1, 1))
        self.assertEqual(end.date(), date(2027, 1, 1))

    def test_default_date_is_today(self):
        start, end = period_range("month")
        today = timezone.localdate()
        self.assertLessEqual(start.date(), today)
        self.assertGreater(end.date(), today)

    def test_invalid_period_raises_400(self):
        from ninja.errors import HttpError

        with self.assertRaises(HttpError):
            period_range("week")


class CustomRangeTests(TestCase):
    def test_custom_range_end_is_exclusive_next_day(self):
        start, end = custom_range(date(2026, 7, 7), date(2026, 7, 14))
        self.assertEqual(start.date(), date(2026, 7, 7))
        self.assertEqual(end.date(), date(2026, 7, 15))  # end esclusivo = data finale + 1 giorno

    def test_custom_range_from_after_to_raises_400(self):
        from ninja.errors import HttpError

        with self.assertRaises(HttpError):
            custom_range(date(2026, 7, 14), date(2026, 7, 7))

    def test_resolve_range_uses_custom_when_both_dates_given(self):
        start, end = resolve_range("month", None, date(2026, 3, 3), date(2026, 3, 5))
        self.assertEqual(start.date(), date(2026, 3, 3))
        self.assertEqual(end.date(), date(2026, 3, 6))

    def test_resolve_range_falls_back_to_period(self):
        start, end = resolve_range("month", date(2026, 7, 15), None, None)
        self.assertEqual(start.date(), date(2026, 7, 1))
        self.assertEqual(end.date(), date(2026, 8, 1))

    def test_a_range_of_centuries_is_refused(self):
        # Il selettore non ha un anno minimo: "0202-01-01" sono 666.000 giorni
        # scorsi uno per uno, con un thread del server occupato per minuti.
        from ninja.errors import HttpError

        from ..services import MAX_RANGE_DAYS

        with self.assertRaises(HttpError):
            custom_range(date(202, 1, 1), date(2026, 12, 31))
        with self.assertRaises(HttpError):
            custom_range(date(1, 1, 1), date(9999, 12, 31))
        # due anni restano leciti
        start, end = custom_range(date(2025, 1, 1), date(2026, 12, 31))
        self.assertEqual((end.date() - start.date()).days, 730)
        self.assertGreaterEqual(MAX_RANGE_DAYS, 731)


class ImpossibleDatesTests(TestCase):
    """08-16: date inesistenti o fuori scala → 400, non 500."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="S", slug="s")
        user = User.objects.create_user(email="own@x.it", password="pw-lunga-123")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = bearer(user, self.salon)
        self.client.raise_request_exception = False

    def test_the_endpoints_answer_400(self):
        queries = (
            "date=2026-02-30",
            "date_from=2026-02-30&date_to=2026-03-02",
            "date_from=0001-01-01&date_to=0001-01-05",
            "period=year&date=9999-06-01",
            "period=month&date=9999-12-01",
            "date_from=9999-12-30&date_to=9999-12-31",
        )
        for url in (
            "/api/insights/kpis",
            "/api/insights/revenue-series",
            "/api/insights/revenue-by-category",
            "/api/insights/occupancy-by-weekday",
        ):
            for query in queries:
                with self.subTest(url=url, query=query):
                    self.assertEqual(self.client.get(f"{url}?{query}", **self.auth).status_code, 400)

    def test_the_services_refuse_out_of_range_dates(self):
        for call in (
            lambda: period_range("year", date(9999, 6, 1)),
            lambda: period_range("month", date(1, 1, 1)),
            lambda: custom_range(date(1, 1, 1), date(1, 1, 5)),
        ):
            with self.assertRaises(HttpError):
                call()
        # le date plausibili restano valide
        period_range("year", date(2999, 6, 1))
        custom_range(date(1900, 1, 1), date(1900, 1, 5))
