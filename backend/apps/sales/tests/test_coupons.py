"""Buoni sconto in cassa: validità, conto scontato, buono ripartito sulle righe.

Caccia del 22/09: 05-18 (il buono si ripartisce sulle righe, così il fatturato
per operatrice torna).
"""

import importlib
import json
from decimal import Decimal
from unittest.mock import patch

from django.apps import apps as django_apps
from django.test import TestCase
from ninja.errors import HttpError

from apps.clients.models import Client
from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..models import Sale, SaleLine
from ..services import finalize_sale
from .base import PATCH_LOYALTY, HistoryTestBase


class CouponAtTheTillTests(TestCase):
    """Il buono sconto vale in cassa.

    `validate_coupon` esisteva e non la chiamava nessuno: il programma fedeltà
    emetteva buoni che la cassiera poteva solo scontare a mano — o rifiutare
    davanti alla cliente.
    """

    def setUp(self):
        from apps.marketing.models import Coupon

        self.Coupon = Coupon
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )

    def _coupon(self, kind="percent", value="20.00", client=None, code="SCONTO20", **extra):
        return self.Coupon.objects.create(
            salon=self.salon, code=code, kind=kind, value=Decimal(value), client=client, **extra
        )

    def _sale(self, *, coupon_code="", paid="100.00", client=None, lines=None):
        # client=None → la cliente della scheda; client=False → vendita anonima.
        with patch(PATCH_LOYALTY):
            return finalize_sale(
                self.salon,
                kind=Sale.Kind.POS,
                client=self.client_obj if client is None else (client or None),
                blocks=[{"operator_id": None, "lines": lines or [
                    {"line_type": "service", "qty": 1, "unit_price": Decimal("100.00")}]}],
                payments=[{"method": "cash", "amount": Decimal(paid)}] if Decimal(paid) else [],
                coupon_code=coupon_code,
            )

    def test_without_a_code_nothing_changes(self):
        sale = self._sale()
        self.assertEqual(sale.total, Decimal("100.00"))
        self.assertEqual(sale.coupon_discount, Decimal("0.00"))

    def test_a_percent_coupon_discounts_the_bill_and_is_burnt(self):
        coupon = self._coupon()
        sale = self._sale(coupon_code="sconto20", paid="80.00")  # anche in minuscolo
        self.assertEqual(sale.total, Decimal("80.00"))
        self.assertEqual(sale.coupon_discount, Decimal("20.00"))
        coupon.refresh_from_db()
        self.assertEqual(coupon.status, self.Coupon.Status.REDEEMED)
        self.assertEqual(coupon.sale_id, sale.id)
        self.assertIsNotNone(coupon.redeemed_at)

    def test_the_payments_must_match_the_discounted_bill(self):
        self._coupon()
        with self.assertRaises(HttpError) as caught:
            self._sale(coupon_code="SCONTO20", paid="100.00")
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(Sale.objects.exists())

    def test_a_coupon_worth_more_than_the_bill_does_not_open_the_cash_drawer(self):
        """Buono da 150 € su un conto da 100: sconta 100, non restituisce 50."""
        self._coupon(kind="amount", value="150.00", code="REGALO50")
        sale = self._sale(coupon_code="REGALO50", paid="0")
        self.assertEqual(sale.total, Decimal("0.00"))
        self.assertEqual(sale.coupon_discount, Decimal("100.00"))

    def test_a_coupon_already_used_is_refused_and_the_sale_does_not_exist(self):
        self._coupon(status=self.Coupon.Status.REDEEMED)
        with self.assertRaises(HttpError) as caught:
            self._sale(coupon_code="SCONTO20", paid="80.00")
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(Sale.objects.exists())

    def test_a_coupon_of_somebody_else_is_refused_on_an_anonymous_sale(self):
        """Il buono intestato vale solo per la sua cliente: al banco, senza
        scheda collegata, chiunque ne conoscesse il codice lo userebbe."""
        self._coupon(client=self.client_obj)
        with self.assertRaises(HttpError) as caught:
            self._sale(coupon_code="SCONTO20", paid="80.00", client=False)
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(Sale.objects.exists())
        self.assertEqual(self.Coupon.objects.get().status, self.Coupon.Status.ACTIVE)

    def test_an_expired_coupon_is_refused(self):
        from django.utils import timezone

        self._coupon(expires_at=timezone.now() - timezone.timedelta(days=1))
        with self.assertRaises(HttpError) as caught:
            self._sale(coupon_code="SCONTO20", paid="80.00")
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(Sale.objects.exists())

    def test_a_gift_card_cannot_be_bought_at_a_discount(self):
        """Scontare una carta da 100 incassandone 80 regala la differenza: è la
        stessa ragione per cui lo sconto di riga sulle gift card è rifiutato."""
        self._coupon()
        with self.assertRaises(HttpError) as caught:
            self._sale(
                coupon_code="SCONTO20", paid="80.00",
                lines=[{"line_type": "gift_card", "value": Decimal("100.00"), "qty": 1}],
            )
        self.assertEqual(caught.exception.status_code, 422)
        self.assertFalse(Sale.objects.exists())

    def test_the_discount_comes_off_before_the_deposit(self):
        """100 di conto, 20 di buono, 30 di caparra: al banco restano 50."""
        self._coupon()
        with patch(PATCH_LOYALTY):
            sale = finalize_sale(
                self.salon, kind=Sale.Kind.CHECKOUT, client=self.client_obj,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "service", "qty": 1, "unit_price": Decimal("100.00")}]}],
                payments=[{"method": "cash", "amount": Decimal("50.00")}],
                deposit_deducted=Decimal("30.00"),
                coupon_code="SCONTO20",
            )
        self.assertEqual(sale.total, Decimal("80.00"))
        self.assertEqual(sale.deposit_deducted, Decimal("30.00"))

    def test_the_till_endpoint_accepts_the_code(self):
        """Dall'HTTP, come la usa la cassiera."""
        import json

        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        coupon = self._coupon(kind="amount", value="15.00", code="MENO15")
        body = {
            "blocks": [{"operator_id": None, "lines": [
                {"line_type": "service", "qty": 1, "unit_price": "100.00"}]}],
            "payments": [{"method": "cash", "amount": "85.00"}],
            "coupon_code": "MENO15",
            "client_id": self.client_obj.id,
        }
        with patch(PATCH_LOYALTY):
            res = self.client.post(
                "/api/sales/pos", json.dumps(body), content_type="application/json", **auth
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["total"], "85.00")
        self.assertEqual(res.json()["coupon_discount"], "15.00")
        coupon.refresh_from_db()
        self.assertEqual(coupon.status, self.Coupon.Status.REDEEMED)


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
