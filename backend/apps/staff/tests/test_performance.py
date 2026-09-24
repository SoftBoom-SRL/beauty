"""Rendimento delle operatrici: la serie mensile, incassi e costo orario solo
a chi ha il permesso, le clienti di oggi e quelle servite.

Caccia del 22/09:
- 09-01 / 10-09 (C6): incassi, spesa delle clienti e costo orario solo a chi ha
  il permesso; agli altri null (mai 0) con `cash_hidden`;
- 09-04: chi fa un servizio secondario conta la visita.
"""

import datetime as dt
import json
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from apps.sales.models import Sale, SaleLine

from ..models import Operator
from ..stats import served_clients, today_clients_by_operator
from .base import _StaffSetup


class PerformanceSeriesTests(TestCase):
    """La serie di rendimento non deve poter essere allungata a piacere."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi"
        )

    def test_months_are_capped(self):
        from ..stats import MAX_PERFORMANCE_MONTHS, performance_series

        series = performance_series(self.operator, months=5_000_000)
        self.assertEqual(len(series), MAX_PERFORMANCE_MONTHS)

    def test_months_below_one_fall_back_to_one(self):
        from ..stats import performance_series

        self.assertEqual(len(performance_series(self.operator, months=0)), 1)

    def test_series_is_built_with_a_bounded_number_of_queries(self):
        from ..stats import performance_series

        with self.assertNumQueries(1):
            series = performance_series(self.operator, months=24)
        self.assertEqual(len(series), 24)
        self.assertEqual(series[-1]["month"], timezone.localdate().strftime("%Y-%m"))


class CashDataVisibilityTests(_StaffSetup):
    """C6: il ruolo «Operatrice» è dato proprio perché non veda gli incassi."""

    def setUp(self):
        super().setUp()
        self._visit(timezone.now() - dt.timedelta(days=1), [(self.cut, self.bea)])
        sale = Sale.objects.create(salon=self.salon, kind="pos", client=self.xenia, total=Decimal("250"))
        SaleLine.objects.create(
            sale=sale, operator=self.bea, line_type="service", qty=1,
            unit_price=Decimal("250"), amount=Decimal("250"),
        )

    def _bea_row(self, auth):
        res = self.client.get("/api/staff/", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        return next(o for o in res.json() if o["id"] == self.bea.id)

    def test_operatrice_role_sees_no_cash_nor_salary(self):
        auth = self._member("junior@parlour.it", ["agenda", "clients"])
        row = self._bea_row(auth)
        self.assertIsNone(row["month_revenue"])
        self.assertIsNone(row["hourly_cost"])
        self.assertIs(row["cash_hidden"], True)
        self.assertEqual(row["today_clients"], 0)  # non è un dato di cassa: resta

        perf = self.client.get(f"/api/staff/{self.bea.id}/performance?months=36", **auth).json()
        self.assertEqual(len(perf), 36)
        self.assertTrue(all(m["revenue"] is None and m["cash_hidden"] for m in perf))

        served = self.client.get(f"/api/staff/{self.bea.id}/clients", **auth).json()
        self.assertEqual(len(served), 1)
        self.assertEqual(served[0]["first_name"], "Xenia")
        for key in ("total_spent", "visits", "last_visit"):
            self.assertIsNone(served[0][key], key)
        self.assertIs(served[0]["cash_hidden"], True)

        detail = self.client.get(f"/api/staff/{self.bea.id}", **auth).json()
        self.assertIsNone(detail["hourly_cost"])
        self.assertIs(detail["cash_hidden"], True)

    def test_sales_scope_sees_the_cash_but_not_the_salary(self):
        auth = self._member("cassa@parlour.it", ["agenda", "clients", "sales"])
        row = self._bea_row(auth)
        self.assertEqual(Decimal(row["month_revenue"]), Decimal("250"))
        self.assertIsNone(row["hourly_cost"])
        self.assertIs(row["cash_hidden"], True)
        served = self.client.get(f"/api/staff/{self.bea.id}/clients", **auth).json()
        self.assertEqual(Decimal(served[0]["total_spent"]), Decimal("250"))
        self.assertEqual(served[0]["visits"], 1)
        self.assertIs(served[0]["cash_hidden"], False)
        perf = self.client.get(f"/api/staff/{self.bea.id}/performance", **auth).json()
        self.assertEqual(Decimal(perf[-1]["revenue"]), Decimal("250"))

    def test_team_scope_sees_the_salary_but_not_the_cash(self):
        auth = self._member("hr@parlour.it", ["team"])
        row = self._bea_row(auth)
        self.assertEqual(Decimal(row["hourly_cost"]), Decimal("18.50"))
        self.assertIsNone(row["month_revenue"])
        self.assertIs(row["cash_hidden"], True)

    def test_the_owner_sees_everything(self):
        auth = self._member("titolare@parlour.it", owner=True)
        row = self._bea_row(auth)
        self.assertEqual(Decimal(row["month_revenue"]), Decimal("250"))
        self.assertEqual(Decimal(row["hourly_cost"]), Decimal("18.50"))
        self.assertIs(row["cash_hidden"], False)

    def test_the_agenda_colour_patch_does_not_leak_the_salary(self):
        auth = self._member("junior@parlour.it", ["agenda", "clients"])
        res = self.client.patch(
            f"/api/staff/{self.bea.id}/color", data=json.dumps({"color": "#112233"}),
            content_type="application/json", **auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIsNone(res.json()["hourly_cost"])


class SecondaryOperatorTests(_StaffSetup):
    """09-04: Bea fa i tagli dopo i colori di Anna."""

    def test_the_second_operator_counts_today(self):
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon, [(self.color, self.anna), (self.cut, self.bea)])
        counts = today_clients_by_operator([self.anna, self.bea], today)
        self.assertEqual(counts, {self.anna.id: 1, self.bea.id: 1})

    def test_two_services_of_the_same_visit_count_once(self):
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon, [(self.color, self.anna), (self.cut, self.bea), (self.color, self.bea)])
        self.assertEqual(today_clients_by_operator([self.bea], today), {self.bea.id: 1})

    def test_served_clients_include_the_secondary_visits(self):
        past = timezone.now() - dt.timedelta(days=3)
        self._visit(past, [(self.color, self.anna), (self.cut, self.bea), (self.cut, self.bea)])
        rows = served_clients(self.bea)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["client_id"], self.xenia.id)
        self.assertEqual(rows[0]["visits"], 1)
        # E per la principale nulla cambia.
        self.assertEqual(served_clients(self.anna)[0]["visits"], 1)

    def test_the_list_shows_the_secondary_operator_clients(self):
        auth = self._member("titolare@parlour.it", owner=True)
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon, [(self.color, self.anna), (self.cut, self.bea)])
        rows = {o["id"]: o for o in self.client.get("/api/staff/", **auth).json()}
        self.assertEqual(rows[self.bea.id]["today_clients"], 1)
