"""Caccia del 22/09 — storico vendite, buono sulle righe, checkout visibile all'agenda.

05-03 + 14-03 (caparre fuori dallo storico), 05-17 + 14-11 (C14, nome del
servizio), 05-18 (buono ripartito sulle righe), 08-03 (evento d'agenda al
checkout), C17 (caparra che copre tutto il conto: `payments: []`).
"""

import datetime as dt
import importlib
import json
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps as django_apps
from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon
from apps.staff.models import Operator
from common.auth import create_staff_tokens

from ..models import Sale, SaleLine
from ..services import record_deposit_cashed


class HistoryTestBase(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales", "agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="Neri")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.colore = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore", duration_min=60, price=Decimal("100.00"),
        )
        self.piega = Service.objects.create(
            salon=self.salon, category=category, name_it="Piega", duration_min=30, price=Decimal("30.00"),
        )

    def _appointment(self, price="100.00", **fields):
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.giulia,
            start=timezone.now() + dt.timedelta(hours=1), **fields,
        )
        AppointmentService.objects.create(
            appointment=appointment, service=self.colore, operator=self.giulia,
            duration_min=60, price=Decimal(price),
        )
        return appointment

    def _checkout(self, appointment, blocks, payments, coupon_code=""):
        return self.client.post(
            f"/api/sales/checkout/{appointment.id}",
            data=json.dumps({"blocks": blocks, "payments": payments, "coupon_code": coupon_code}),
            content_type="application/json", **self.auth,
        )

    def _line(self, service, price, **extra):
        return {"line_type": "service", "service_id": service.id, "qty": 1, "unit_price": price, **extra}


class HistoryWithoutDepositsTests(HistoryTestBase):
    """05-03, 14-03: la caparra è un anticipo, non una seconda vendita."""

    def _paid_deposit_then_checkout(self):
        appointment = self._appointment(deposit_status="paid", deposit_amount=Decimal("30.00"))
        record_deposit_cashed(self.salon, appointment, method="card")
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "70.00"}],
        )
        self.assertEqual(res.status_code, 200, res.content)
        return appointment

    def test_the_history_counts_the_visit_once(self):
        self._paid_deposit_then_checkout()
        listed = self.client.get("/api/sales/", **self.auth).json()
        self.assertEqual(Decimal(listed["kpi"]["revenue"]), Decimal("100.00"))
        self.assertEqual(listed["kpi"]["count"], 1)
        self.assertEqual(listed["kpi"]["items_count"], 1)
        self.assertEqual([s["kind"] for s in listed["items"]], ["checkout"])
        # nemmeno come «vendita da banco» della cliente
        mine = self.client.get(f"/api/sales/?client_id={self.client_obj.id}&kind=pos", **self.auth).json()
        self.assertEqual(mine["count"], 0)

    def test_deposits_can_still_be_listed_on_their_own(self):
        appointment = self._paid_deposit_then_checkout()
        deposits = self.client.get("/api/sales/?kind=deposit", **self.auth).json()
        self.assertEqual(deposits["count"], 1)
        self.assertEqual(deposits["items"][0]["deposit_appointment_id"], appointment.id)
        self.assertEqual(Decimal(deposits["kpi"]["revenue"]), Decimal("30.00"))


class ServiceNameOnTheLinesTests(HistoryTestBase):
    """05-17, 14-11 (C14): la riga porta il nome del servizio."""

    def test_the_detail_names_the_service(self):
        appointment = self._appointment()
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "100.00"}],
        )
        sale_id = res.json()["sale"]["id"]
        detail = self.client.get(f"/api/sales/{sale_id}", **self.auth).json()
        self.assertEqual(detail["lines"][0]["service_name"], "Colore")
        self.assertEqual(res.json()["sale"]["lines"][0]["service_name"], "Colore")

    def test_a_line_without_service_has_an_empty_name(self):
        appointment = self._appointment(deposit_status="paid", deposit_amount=Decimal("30.00"))
        deposit = record_deposit_cashed(self.salon, appointment, method="card")
        detail = self.client.get(f"/api/sales/{deposit.id}", **self.auth).json()
        self.assertEqual(detail["lines"][0]["service_name"], "")


class CouponOnTheLinesTests(HistoryTestBase):
    """05-18: il buono si ripartisce sulle righe, così il fatturato per operatrice torna."""

    def setUp(self):
        super().setUp()
        from apps.marketing.models import Coupon

        Coupon.objects.create(salon=self.salon, code="BUONO20", kind="amount", value=Decimal("20.00"))
        Coupon.objects.create(salon=self.salon, code="BUONO10", kind="amount", value=Decimal("10.00"))

    def test_the_operator_revenue_matches_the_takings(self):
        from apps.staff.services import month_revenue, month_revenue_by_operator, performance_series

        appointment = self._appointment()
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "80.00"}], coupon_code="BUONO20",
        )
        self.assertEqual(res.status_code, 200, res.content)
        line = res.json()["sale"]["lines"][0]
        self.assertEqual(Decimal(line["amount"]), Decimal("80.00"))
        self.assertEqual(Decimal(line["coupon_share"]), Decimal("20.00"))
        self.assertEqual(Decimal(res.json()["breakdown"][0]["amount"]), Decimal("80.00"))
        everyone = self.client.get("/api/sales/", **self.auth).json()["kpi"]
        hers = self.client.get(f"/api/sales/?operator_id={self.giulia.id}", **self.auth).json()["kpi"]
        self.assertEqual(Decimal(everyone["revenue"]), Decimal("80.00"))
        self.assertEqual(Decimal(hers["revenue"]), Decimal("80.00"))
        self.assertEqual(month_revenue(self.giulia), Decimal("80.00"))
        self.assertEqual(month_revenue_by_operator([self.giulia])[self.giulia.id], Decimal("80.00"))
        self.assertEqual(performance_series(self.giulia, months=1)[-1]["revenue"], Decimal("80.00"))

    def test_two_operators_share_the_coupon_in_proportion(self):
        appointment = self._appointment()
        res = self._checkout(
            appointment,
            [
                {"operator_id": self.giulia.id, "lines": [self._line(self.colore, "70.00")]},
                {"operator_id": self.anna.id, "lines": [self._line(self.piega, "30.00")]},
            ],
            [{"method": "cash", "amount": "90.00"}], coupon_code="BUONO10",
        )
        self.assertEqual(res.status_code, 200, res.content)
        by_operator = {b["operator_id"]: Decimal(b["amount"]) for b in res.json()["breakdown"]}
        self.assertEqual(by_operator, {self.giulia.id: Decimal("63.00"), self.anna.id: Decimal("27.00")})
        anna = self.client.get(f"/api/sales/?operator_id={self.anna.id}", **self.auth).json()["kpi"]
        self.assertEqual(Decimal(anna["revenue"]), Decimal("27.00"))

    def test_the_shares_add_up_to_the_coupon_to_the_cent(self):
        appointment = self._appointment()
        lines = [self._line(self.colore, "33.33"), self._line(self.piega, "33.33"), self._line(self.colore, "33.34")]
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": lines}],
            [{"method": "cash", "amount": "90.00"}], coupon_code="BUONO10",
        )
        self.assertEqual(res.status_code, 200, res.content)
        sale = Sale.objects.get(pk=res.json()["sale"]["id"])
        rows = list(sale.lines.all())
        self.assertEqual(sum(r.coupon_share for r in rows), Decimal("10.00"))
        self.assertEqual(sum(r.amount for r in rows), sale.total)

    def test_gift_cards_are_left_out_of_the_share(self):
        from apps.inventory.models import Product, Supplier

        supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        product = Product.objects.create(
            salon=self.salon, name="Shampoo", supplier=supplier, stock_qty=Decimal("5"),
            sale_price=Decimal("50.00"),
        )
        body = {
            "client_id": self.client_obj.id,
            "blocks": [{"operator_id": None, "lines": [
                {"line_type": "gift_card", "value": "50.00"},
                {"line_type": "product", "product_id": product.id, "qty": 1, "unit_price": "50.00"},
            ]}],
            "payments": [{"method": "cash", "amount": "90.00"}],
            "coupon_code": "BUONO10",
        }
        res = self.client.post("/api/sales/pos", data=json.dumps(body), content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        by_type = {line["line_type"]: line for line in res.json()["lines"]}
        self.assertEqual(Decimal(by_type["gift_card"]["amount"]), Decimal("50.00"))
        self.assertEqual(Decimal(by_type["product"]["amount"]), Decimal("40.00"))

    def test_sales_recorded_before_are_spread_by_the_migration(self):
        migration = importlib.import_module("apps.sales.migrations.0005_caccia22_buono_sulle_righe")
        sale = Sale.objects.create(
            salon=self.salon, kind="pos", total=Decimal("80.00"), coupon_discount=Decimal("20.00"),
        )
        first = SaleLine.objects.create(
            sale=sale, operator=self.giulia, line_type="service", qty=1,
            unit_price=Decimal("75.00"), amount=Decimal("75.00"),
        )
        second = SaleLine.objects.create(
            sale=sale, operator=self.anna, line_type="service", qty=1,
            unit_price=Decimal("25.00"), amount=Decimal("25.00"),
        )
        migration.spread_recorded_coupons(django_apps, None)
        migration.spread_recorded_coupons(django_apps, None)  # una seconda volta non cambia niente
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((first.amount, first.coupon_share), (Decimal("60.00"), Decimal("15.00")))
        self.assertEqual((second.amount, second.coupon_share), (Decimal("20.00"), Decimal("5.00")))


class CheckoutSeenByTheAgendaTests(HistoryTestBase):
    """08-03: il checkout lascia un evento che anche l'agenda riceve."""

    def test_the_checkout_writes_an_agenda_event_without_amounts(self):
        from apps.core.views import allowed_prefixes

        appointment = self._appointment()
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "100.00"}],
        )
        self.assertEqual(res.status_code, 200, res.content)
        log = ActivityLog.objects.get(salon=self.salon, type="appointment.closed")
        self.assertEqual(log.payload["appointment_id"], appointment.id)
        self.assertNotIn("€", log.summary)
        # l'operatrice col solo permesso agenda lo riceve dal feed live
        self.assertTrue(any(log.type.startswith(prefix) for prefix in allowed_prefixes(False, ["agenda"])))


class DepositCoversTheWholeBillTests(HistoryTestBase):
    """C17: caparra ≥ conto (anche scontato): si accetta `payments: []` e si restituisce il resto."""

    def test_no_payments_and_the_excess_goes_back(self):
        appointment = self._appointment(
            price="50.00", deposit_status="paid", deposit_amount=Decimal("30.00"),
            deposit_payment_intent_id="pi_dep",
        )
        record_deposit_cashed(self.salon, appointment, method="card")
        refunded = {"id": "re_excess", "amount": 500, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self._checkout(
                appointment,
                [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "50.00", discount_pct=50)]}],
                [],
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["sale"]["total"]), Decimal("25.00"))
        self.assertEqual(Decimal(res.json()["sale"]["deposit_deducted"]), Decimal("25.00"))
        self.assertEqual(res.json()["sale"]["payments"], [])
        self.assertEqual(refund.call_args.kwargs["amount_cents"], 500)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, "closed")
