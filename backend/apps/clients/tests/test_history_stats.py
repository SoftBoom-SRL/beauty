"""Caccia 22/09 — visite e spesa della cliente, storico con la caparra.

05-05 + 06-01 + 14-03 (lato clienti): la vendita-caparra e l'addebito no-show
sono vendite, e `client_stats` le contava come visite e come spesa; nello
storico la caparra compariva come «Vendita al banco». 06-05 + 17-04 (C5): lo
storico senza permesso «vendite» deve dire che gli incassi sono nascosti.
"""

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from common.auth import StaffContext

from ..api import client_history, get_client
from ..models import Client
from ..services import client_facts, client_stats


def _request(salon, scopes=("clients", "sales")):
    return SimpleNamespace(
        auth=StaffContext(user=None, salon=salon, membership=None, scopes=set(scopes), is_owner=False)
    )


class _Base(TestCase):
    def setUp(self):
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")

    def appointment(self, days=-1, **kw):
        from apps.agenda.models import Appointment

        defaults = dict(
            salon=self.salon,
            client=self.client_obj,
            operator=self.operator,
            start=timezone.now() + dt.timedelta(days=days),
            status="closed",
        )
        defaults.update(kw)
        return Appointment.objects.create(**defaults)

    def checkout(self, appointment, total, deducted="0"):
        from apps.sales.models import Payment, Sale, SaleLine

        total, deducted = Decimal(total), Decimal(deducted)
        sale = Sale.objects.create(
            salon=self.salon, kind="checkout", client=self.client_obj,
            appointment=appointment, total=total, deposit_deducted=deducted,
        )
        SaleLine.objects.create(sale=sale, line_type="service", qty=1, unit_price=total, amount=total)
        Payment.objects.create(sale=sale, method="cash", amount=total - deducted)
        return sale

    def counter_sale(self, total, line_type="product"):
        from apps.sales.models import Sale, SaleLine

        sale = Sale.objects.create(
            salon=self.salon, kind="pos", client=self.client_obj, total=Decimal(total)
        )
        SaleLine.objects.create(
            sale=sale, line_type=line_type, qty=1, unit_price=Decimal(total), amount=Decimal(total)
        )
        return sale

    def paid_deposit(self, appointment, amount="30"):
        from apps.sales.services import record_deposit_cashed

        appointment.deposit_status = "paid"
        appointment.deposit_amount = Decimal(amount)
        appointment.save(update_fields=["deposit_status", "deposit_amount"])
        sale = record_deposit_cashed(self.salon, appointment, method="card")
        self.assertIsNotNone(sale)
        return sale


class DepositAndNoShowAreNotVisitsTests(_Base):
    def test_deposit_then_checkout_is_one_visit_and_the_bill_once(self):
        appt = self.appointment()
        self.paid_deposit(appt)
        self.checkout(appt, "100", deducted="30")
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 1)
        self.assertEqual(stats["total_spent"], Decimal("100"))

    def test_a_paid_deposit_before_the_visit_is_not_a_visit(self):
        appt = self.appointment(days=5, status="confirmed")
        self.paid_deposit(appt)
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("0"))
        # L'ultima visita non diventa il giorno in cui è arrivata la caparra.
        self.assertIsNone(stats["last_visit"])

    def test_the_deposit_of_a_cancelled_booking_is_not_a_visit(self):
        appt = self.appointment(days=3, status="confirmed")
        self.paid_deposit(appt)
        appt.status = "cancelled"
        appt.save(update_fields=["status"])
        stats = client_stats(self.client_obj)
        self.assertEqual((stats["visits"], stats["total_spent"]), (0, Decimal("0")))

    def test_a_no_show_charge_is_neither_a_visit_nor_spending(self):
        from apps.sales.services import record_no_show_charge

        appt = self.appointment(status="no_show")
        self.assertIsNotNone(record_no_show_charge(self.salon, appt, amount=Decimal("40")))
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("0"))
        self.assertEqual(client_facts(self.client_obj)["noshow_count"], 1)

    def test_the_first_visit_deposit_rule_still_asks_until_she_has_come(self):
        """La regola rapida «Prima visita» (visite < 1): dopo la prima caparra
        pagata smetteva di chiederla, anche se la cliente non era mai venuta."""
        from apps.agenda.services import compute_deposit
        from apps.core.models import DepositRule

        DepositRule.objects.create(
            salon=self.salon, name="Prima visita", amount_type="pct", amount=Decimal("30"),
            conditions={"op": "and", "rules": [{"field": "visits", "cmp": "lt", "value": 1}]},
        )
        first = self.appointment(days=5, status="confirmed")
        self.paid_deposit(first)
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("30.00"))
        # Dopo la visita vera (conto chiuso) la caparra non si chiede più.
        first.status = "closed"
        first.start = timezone.now() - dt.timedelta(hours=2)
        first.save(update_fields=["status", "start"])
        self.checkout(first, "100", deducted="30")
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("0"))

    def test_closed_visits_and_counter_purchases_both_count(self):
        visit = self.appointment(days=-10)
        self.checkout(visit, "80")
        # Una visita chiusa arrivata da Yourang non ha vendita: è una visita lo stesso.
        synced = self.appointment(days=-3)
        self.counter_sale("25")
        self.counter_sale("50", line_type="gift_card")  # buono regalato: incasso, non visita
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 3)
        self.assertEqual(stats["total_spent"], Decimal("155"))
        self.assertIsNotNone(stats["last_visit"])
        self.assertGreaterEqual(stats["last_visit"], synced.start)

    def test_last_visit_is_the_visit_not_the_later_deposit(self):
        visit = self.appointment(days=-20)
        self.checkout(visit, "60")
        upcoming = self.appointment(days=4, status="confirmed")
        self.paid_deposit(upcoming)
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["last_visit"], visit.start)

    def test_the_client_card_shows_the_corrected_figures(self):
        appt = self.appointment()
        self.paid_deposit(appt)
        self.checkout(appt, "100", deducted="30")
        detail = get_client(_request(self.salon), self.client_obj.id)
        self.assertEqual((detail.visits, detail.total_spent), (1, Decimal("100")))


class HistoryDepositTests(_Base):
    def test_the_deposit_sale_belongs_to_its_visit(self):
        appt = self.appointment()
        deposit = self.paid_deposit(appt)
        sale = self.checkout(appt, "100", deducted="30")
        data = client_history(_request(self.salon), self.client_obj.id)
        kinds = [e["kind"] for e in data["entries"]]
        self.assertNotIn("sale", kinds)  # nessuna finta «Vendita al banco»
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        self.assertEqual(visit["sale"]["id"], sale.id)
        self.assertEqual(visit["deposit_sale"]["id"], deposit.id)
        self.assertEqual(data["counts"]["sales"], 1)

    def test_a_deposit_for_an_upcoming_visit_waits_in_that_visit(self):
        appt = self.appointment(days=3, status="confirmed")
        deposit = self.paid_deposit(appt)
        data = client_history(_request(self.salon), self.client_obj.id)
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        self.assertTrue(visit["upcoming"])
        self.assertIsNone(visit["sale"])
        self.assertEqual(visit["deposit_sale"]["id"], deposit.id)
        self.assertEqual([e for e in data["entries"] if e["kind"] == "sale"], [])

    def test_a_real_counter_sale_is_still_listed(self):
        sale = self.counter_sale("25")
        data = client_history(_request(self.salon), self.client_obj.id)
        self.assertEqual([e["sale"]["id"] for e in data["entries"] if e["kind"] == "sale"], [sale.id])


class HistorySalesHiddenTests(_Base):
    """C5: `sales_hidden` distingue «incasso nascosto» da «non incassato»."""

    def test_without_the_sales_scope_the_history_says_so(self):
        appt = self.appointment()
        self.checkout(appt, "50")
        data = client_history(_request(self.salon, scopes=("clients", "agenda")), self.client_obj.id)
        self.assertTrue(data["sales_hidden"])
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        self.assertIsNone(visit["sale"])
        self.assertIsNone(visit["deposit_sale"])

    def test_with_the_sales_scope_nothing_is_hidden(self):
        appt = self.appointment()
        self.checkout(appt, "50")
        data = client_history(_request(self.salon), self.client_obj.id)
        self.assertFalse(data["sales_hidden"])
        self.assertIsNotNone(next(e for e in data["entries"] if e["kind"] == "visit")["sale"])

    def test_the_owner_sees_the_sales(self):
        owner = SimpleNamespace(
            auth=StaffContext(user=None, salon=self.salon, membership=None, scopes=set(), is_owner=True)
        )
        data = client_history(owner, self.client_obj.id)
        self.assertFalse(data["sales_hidden"])
