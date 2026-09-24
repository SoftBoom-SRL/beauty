"""Vendita e `finalize_sale`: righe, pagamenti, importi, riepilogo del giorno, elenco.

I servizi cross-app (inventory, marketing) sono mockati: qui si verifica solo
che finalize_sale li invochi con gli argomenti giusti, come da SPEC §8.
"""

from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from ninja.errors import HttpError

from apps.clients.models import Client
from apps.inventory.models import Product, Supplier
from apps.core.models import ActivityLog, Salon
from common.auth import create_staff_tokens

from ..models import Payment, Sale, SaleLine
from ..services import finalize_sale, line_amount, today_summary
from .base import PATCH_CREATE_GC, PATCH_DEDUCT, PATCH_LOYALTY, PATCH_REDEEM, _blocks


class FinalizeSaleTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon,
            first_name="Sofia",
            last_name="Ricci",
            phone="+393331112222",
        )
        # Una riga prodotto deve indicare il prodotto: senza, il magazzino non
        # verrebbe mai scaricato e `_prepare_lines` la rifiuta.
        supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        self.product = Product.objects.create(
            salon=self.salon, name="Shampoo", supplier=supplier,
            stock_qty=Decimal("20"), sale_price=Decimal("10.00"),
        )

    def _finalize(self, blocks, payments, **kwargs):
        kwargs.setdefault("kind", Sale.Kind.POS)
        kwargs.setdefault("client", self.client_obj)
        with patch(PATCH_DEDUCT) as deduct, patch(PATCH_LOYALTY) as loyalty:
            sale = finalize_sale(self.salon, blocks=blocks, payments=payments, **kwargs)
        return sale, deduct, loyalty

    def test_finalize_sale_ok(self):
        blocks = _blocks(
            [
                {"line_type": "service", "qty": 1, "unit_price": Decimal("50.00")},
                {"line_type": "product", "product_id": self.product.id, "qty": 2, "unit_price": Decimal("10.00")},
            ]
        )
        payments = [{"method": "cash", "amount": Decimal("70.00")}]
        sale, deduct, loyalty = self._finalize(blocks, payments)

        self.assertEqual(sale.total, Decimal("70.00"))
        self.assertEqual(sale.kind, Sale.Kind.POS)
        self.assertEqual(sale.lines.count(), 2)
        self.assertEqual(sale.payments.count(), 1)
        self.assertEqual(sale.payments.get().amount, Decimal("70.00"))
        deduct.assert_called_once_with(sale)  # righe prodotto → scarico magazzino
        loyalty.assert_called_once_with(sale)
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="sale.created").exists()
        )

    def test_finalize_sale_payment_mismatch(self):
        blocks = _blocks([{"line_type": "service", "qty": 1, "unit_price": Decimal("70.00")}])
        with self.assertRaises(HttpError) as caught:
            self._finalize(blocks, [{"method": "cash", "amount": Decimal("60.00")}])
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(str(caught.exception), "I pagamenti non corrispondono al totale")
        self.assertEqual(Sale.objects.count(), 0)  # niente vendita parziale

    def test_payment_tolerance_one_cent(self):
        blocks = _blocks([{"line_type": "service", "qty": 1, "unit_price": Decimal("50.00")}])
        sale, _, _ = self._finalize(blocks, [{"method": "card", "amount": Decimal("49.99")}])
        self.assertEqual(sale.total, Decimal("50.00"))

    def test_discount_and_gift_amounts(self):
        blocks = _blocks(
            [
                {
                    "line_type": "service",
                    "qty": 2,
                    "unit_price": Decimal("30.00"),
                    "discount_pct": 50,
                },
                {
                    "line_type": "product",
                    "product_id": self.product.id,
                    "qty": 1,
                    "unit_price": Decimal("15.00"),
                    "is_gift": True,
                },
            ]
        )
        payments = [{"method": "card", "amount": Decimal("30.00")}]
        sale, deduct, _ = self._finalize(blocks, payments)

        amounts = sorted(sale.lines.values_list("amount", flat=True))
        self.assertEqual(amounts, [Decimal("0.00"), Decimal("30.00")])
        self.assertEqual(sale.total, Decimal("30.00"))
        deduct.assert_called_once_with(sale)  # anche l'omaggio scarica il magazzino

    def test_deposit_deducted(self):
        blocks = _blocks([{"line_type": "service", "qty": 1, "unit_price": Decimal("80.00")}])
        sale, _, _ = self._finalize(
            blocks,
            [{"method": "cash", "amount": Decimal("60.00")}],
            deposit_deducted=Decimal("20.00"),
        )
        self.assertEqual(sale.total, Decimal("80.00"))
        self.assertEqual(sale.deposit_deducted, Decimal("20.00"))

        # pagare il totale pieno è un errore: il deposito va detratto
        with self.assertRaises(HttpError) as caught:
            self._finalize(
                blocks,
                [{"method": "cash", "amount": Decimal("80.00")}],
                deposit_deducted=Decimal("20.00"),
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_gift_card_payment_redeems(self):
        blocks = _blocks([{"line_type": "service", "qty": 1, "unit_price": Decimal("40.00")}])
        payments = [
            {"method": "gift_card", "amount": Decimal("40.00"), "gift_card_code": "ABCD1234"}
        ]
        with patch(PATCH_DEDUCT), patch(PATCH_LOYALTY), patch(
            PATCH_REDEEM, return_value=None
        ) as redeem:
            sale = finalize_sale(
                self.salon,
                kind=Sale.Kind.POS,
                blocks=blocks,
                payments=payments,
                client=self.client_obj,
            )
        redeem.assert_called_once_with(self.salon, "ABCD1234", Decimal("40.00"))
        self.assertEqual(sale.payments.get().method, Payment.Method.GIFT_CARD)

    def test_gift_card_payment_without_code(self):
        blocks = _blocks([{"line_type": "service", "qty": 1, "unit_price": Decimal("40.00")}])
        payments = [{"method": "gift_card", "amount": Decimal("40.00")}]
        with self.assertRaises(HttpError) as caught:
            self._finalize(blocks, payments)
        self.assertEqual(caught.exception.status_code, 422)

    def test_gift_card_line_creates_card(self):
        blocks = _blocks(
            [
                {
                    "line_type": "gift_card",
                    "qty": 1,
                    "value": Decimal("100.00"),
                    "recipient_name": "Giulia",
                }
            ]
        )
        payments = [{"method": "card", "amount": Decimal("100.00")}]
        with patch(PATCH_DEDUCT), patch(PATCH_LOYALTY), patch(
            PATCH_CREATE_GC, return_value=None
        ) as create_gc:
            sale = finalize_sale(
                self.salon,
                kind=Sale.Kind.POS,
                blocks=blocks,
                payments=payments,
                client=self.client_obj,
            )
        self.assertEqual(sale.total, Decimal("100.00"))
        create_gc.assert_called_once()
        args, kwargs = create_gc.call_args
        self.assertEqual(args, (self.salon, Decimal("100.00")))
        self.assertEqual(kwargs["buyer_client"], self.client_obj)
        self.assertEqual(kwargs["recipient_name"], "Giulia")
        self.assertTrue(kwargs["paid"])
        self.assertEqual(kwargs["paid_method"], "card")
        self.assertEqual(kwargs["sale"], sale)
        line = sale.lines.get()
        self.assertEqual(line.line_type, SaleLine.LineType.GIFT_CARD)
        self.assertEqual(line.amount, Decimal("100.00"))

    def test_no_lines_rejected(self):
        with self.assertRaises(HttpError) as caught:
            self._finalize([], [])
        self.assertEqual(caught.exception.status_code, 422)

    def test_line_amount_helper(self):
        self.assertEqual(line_amount(2, Decimal("30.00"), 50), Decimal("30.00"))
        self.assertEqual(line_amount(1, Decimal("19.99")), Decimal("19.99"))
        self.assertEqual(line_amount(3, Decimal("10.00"), 0, True), Decimal("0.00"))
        self.assertEqual(line_amount(3, Decimal("9.99"), 33), Decimal("20.08"))


class TodaySummaryTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_today_summary(self):
        empty = today_summary(self.salon)
        self.assertEqual(empty["total"], Decimal("0.00"))
        self.assertEqual(empty["count"], 0)

        Sale.objects.create(salon=self.salon, kind=Sale.Kind.CHECKOUT, total=Decimal("100.00"))
        Sale.objects.create(salon=self.salon, kind=Sale.Kind.POS, total=Decimal("50.00"))
        other = Salon.objects.create(name="Altro", slug="altro")
        Sale.objects.create(salon=other, kind=Sale.Kind.POS, total=Decimal("99.00"))

        data = today_summary(self.salon)
        self.assertEqual(data["total"], Decimal("150.00"))
        self.assertEqual(data["count"], 2)
        self.assertEqual(data["checkout_total"], Decimal("100.00"))
        self.assertEqual(data["pos_total"], Decimal("50.00"))


class ListSalesApiTests(TestCase):
    """GET /api/sales/: filtro opzionale client_id (staff, per singolo cliente)."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        tokens = create_staff_tokens(user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

        self.sofia = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.giulia = Client.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi", phone="+393333334444"
        )
        self.sale_sofia = Sale.objects.create(
            salon=self.salon, kind=Sale.Kind.POS, client=self.sofia, total=Decimal("50.00")
        )
        self.sale_giulia = Sale.objects.create(
            salon=self.salon, kind=Sale.Kind.POS, client=self.giulia, total=Decimal("30.00")
        )

    def test_without_client_id_returns_all(self):
        resp = self.client.get("/api/sales/", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["count"], 2)
        self.assertEqual(len(body["items"]), 2)

    def test_client_id_filters_to_single_client(self):
        resp = self.client.get(f"/api/sales/?client_id={self.sofia.id}", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["id"], self.sale_sofia.id)
        self.assertEqual(body["kpi"]["revenue"], "50.00")


class TenantIsolationTests(TestCase):
    """Le righe di vendita devono riferirsi a servizi, prodotti e operatrici del
    salone autenticato: prima una vendita del salone A poteva scaricare il
    magazzino di B indicando l'id giusto."""

    def setUp(self):
        from apps.catalog.models import Service, ServiceCategory
        from apps.inventory.models import Product, Supplier
        from apps.staff.models import Operator

        self.salon_a = Salon.objects.create(name="Salone A", slug="salone-a")
        self.salon_b = Salon.objects.create(name="Salone B", slug="salone-b")
        supplier = Supplier.objects.create(salon=self.salon_b, name="Davines")
        self.product_b = Product.objects.create(
            salon=self.salon_b, name="Shampoo", supplier=supplier,
            stock_qty=Decimal("10"), sale_price=Decimal("12.00"),
        )
        self.operator_b = Operator.objects.create(salon=self.salon_b, first_name="Marta", last_name="Verdi")
        category = ServiceCategory.objects.create(salon=self.salon_b, name_it="Unghie")
        self.service_b = Service.objects.create(
            salon=self.salon_b, category=category, name_it="Manicure", duration_min=30, price=Decimal("20.00"),
        )

    def _sell(self, line, operator_id=None):
        with patch(PATCH_LOYALTY):
            return finalize_sale(
                self.salon_a,
                kind=Sale.Kind.POS,
                blocks=[{"operator_id": operator_id, "lines": [line]}],
                payments=[{"method": "cash", "amount": line["unit_price"]}],
            )

    def test_product_of_another_salon_is_rejected_and_stock_untouched(self):
        with self.assertRaises(HttpError) as caught:
            self._sell({"line_type": "product", "product_id": self.product_b.id, "qty": 1, "unit_price": Decimal("12.00")})
        self.assertEqual(caught.exception.status_code, 404)
        self.product_b.refresh_from_db()
        self.assertEqual(self.product_b.stock_qty, Decimal("10"))
        self.assertEqual(Sale.objects.count(), 0)

    def test_service_and_operator_of_another_salon_are_rejected(self):
        with self.assertRaises(HttpError) as caught:
            self._sell({"line_type": "service", "service_id": self.service_b.id, "unit_price": Decimal("20.00")})
        self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(HttpError) as caught:
            self._sell({"line_type": "service", "unit_price": Decimal("20.00")}, operator_id=self.operator_b.id)
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(Sale.objects.count(), 0)


class SaleAmountValidationTests(TestCase):
    """Niente vendite o pagamenti negativi, quantità zero o sconti fuori dal 0–100%."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _finalize(self, lines, payments):
        with patch(PATCH_DEDUCT), patch(PATCH_LOYALTY):
            return finalize_sale(self.salon, kind=Sale.Kind.POS, blocks=_blocks(lines), payments=payments)

    def test_negative_price_rejected(self):
        with self.assertRaises(HttpError) as caught:
            self._finalize(
                [{"line_type": "service", "unit_price": Decimal("-10.00")}],
                [{"method": "cash", "amount": Decimal("-10.00")}],
            )
        self.assertEqual(caught.exception.status_code, 422)
        self.assertEqual(Sale.objects.count(), 0)

    def test_negative_payment_rejected(self):
        with self.assertRaises(HttpError) as caught:
            self._finalize(
                [{"line_type": "service", "unit_price": Decimal("10.00")}],
                [{"method": "cash", "amount": Decimal("20.00")}, {"method": "card", "amount": Decimal("-10.00")}],
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_zero_qty_and_out_of_range_discount_rejected(self):
        bad_lines = (
            {"line_type": "service", "unit_price": Decimal("10.00"), "qty": 0},
            {"line_type": "service", "unit_price": Decimal("10.00"), "discount_pct": 150},
        )
        for line in bad_lines:
            with self.assertRaises(HttpError) as caught:
                self._finalize([line], [{"method": "cash", "amount": Decimal("0.00")}])
            self.assertEqual(caught.exception.status_code, 422)


class PosApiValidationTests(TestCase):
    """Il contratto HTTP rifiuta gli importi negativi prima di arrivare al servizio."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        tokens = create_staff_tokens(user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def test_negative_sale_is_422(self):
        import json

        body = {
            "blocks": [{"operator_id": None, "lines": [{"line_type": "service", "unit_price": "-10.00"}]}],
            "payments": [{"method": "cash", "amount": "-10.00"}],
        }
        res = self.client.post("/api/sales/pos", data=json.dumps(body), content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(Sale.objects.count(), 0)


class BugHuntRegressionTests(TestCase):
    """Difetti trovati nella ricerca bug del 17/09/2026."""

    def setUp(self):
        from apps.agenda.models import Appointment
        from apps.catalog.models import Service, ServiceCategory
        from apps.core.models import DepositRule
        from apps.marketing.models import GiftCard

        self.Appointment = Appointment
        self.GiftCard = GiftCard
        self.DepositRule = DepositRule
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure",
            duration_min=30, price=Decimal("30.00"),
        )

    def test_a_fixed_deposit_never_exceeds_the_price(self):
        """Una regola da 50 € su un servizio da 30 € rendeva il conto impossibile
        da chiudere: la cassa avrebbe dovuto incassare −20 €."""
        from apps.agenda.services import compute_deposit

        self.DepositRule.objects.create(
            salon=self.salon, name="Sempre 50", amount_type="fixed",
            amount=Decimal("50.00"), active=True, conditions={},
        )
        self.assertEqual(
            compute_deposit(self.salon, self.client_obj, Decimal("30.00")), Decimal("30.00")
        )

    def test_a_malformed_deposit_rule_does_not_block_every_booking(self):
        from apps.agenda.services import compute_deposit

        self.DepositRule.objects.create(
            salon=self.salon, name="Rotta", amount_type="fixed", amount=Decimal("10.00"),
            active=True, conditions={"op": "and", "rules": "non una lista di regole"},
        )
        self.assertEqual(
            compute_deposit(self.salon, self.client_obj, Decimal("30.00")), Decimal("0.00")
        )

    def test_cashing_a_gift_card_outside_the_till_records_the_money(self):
        """Le carte comprate dall'app si incassano da Fedeltà: senza una vendita
        corrispondente quel denaro non entrava nei ricavi, e al riscatto veniva
        perfino sottratto."""
        from apps.sales.services import record_gift_card_cashed, today_summary

        card = self.GiftCard.objects.create(
            salon=self.salon, code="GC-TEST-0001",
            initial_value=Decimal("80.00"), balance=Decimal("80.00"),
            buyer_client=self.client_obj,
        )
        sale = record_gift_card_cashed(self.salon, card, method="card")
        self.assertIsNotNone(sale)
        summary = today_summary(self.salon)
        self.assertEqual(summary["gift_card_sold"], Decimal("80.00"))
        self.assertEqual(summary["cash_in"], Decimal("80.00"))
        # seconda chiamata: nessun doppio conteggio
        self.assertIsNone(record_gift_card_cashed(self.salon, card, method="card"))
        self.assertEqual(today_summary(self.salon)["gift_card_sold"], Decimal("80.00"))

    def test_selling_a_gift_card_does_not_also_earn_points_for_its_value(self):
        """Comprare una carta da 100 € e poi spenderla dava 200 punti."""
        from apps.marketing.models import LoyaltyAccount, LoyaltyProgram

        program = LoyaltyProgram.objects.create(
            salon=self.salon, name="Punti", active=True, enrollment="auto",
            earn_metric="per_euro", earn_ratio=Decimal("1"), threshold=0,
            reward_type="discount_amount", reward_value=Decimal("5"),
        )
        with patch(PATCH_DEDUCT):
            sale = finalize_sale(
                self.salon, kind=Sale.Kind.POS, client=self.client_obj,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "service", "service_id": self.service.id,
                     "qty": 1, "unit_price": Decimal("30.00")},
                    {"line_type": "gift_card", "value": Decimal("100.00"), "qty": 1},
                ]}],
                payments=[{"method": "cash", "amount": Decimal("130.00")}],
            )
        self.assertEqual(sale.total, Decimal("130.00"))
        account = LoyaltyAccount.objects.get(program=program, client=self.client_obj)
        self.assertEqual(account.points, 30)  # solo il servizio, non la carta

    def test_a_discount_on_a_gift_card_line_is_refused(self):
        with self.assertRaises(HttpError) as caught:
            finalize_sale(
                self.salon, kind=Sale.Kind.POS, client=self.client_obj,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "gift_card", "value": Decimal("100.00"),
                     "qty": 1, "discount_pct": 20},
                ]}],
                payments=[{"method": "cash", "amount": Decimal("80.00")}],
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_a_product_line_without_a_product_is_refused(self):
        with self.assertRaises(HttpError) as caught:
            finalize_sale(
                self.salon, kind=Sale.Kind.POS, client=self.client_obj,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "product", "qty": 1, "unit_price": Decimal("10.00")},
                ]}],
                payments=[{"method": "cash", "amount": Decimal("10.00")}],
            )
        self.assertEqual(caught.exception.status_code, 422)


class GiftCardQuantityTests(TestCase):
    """qty>1 su una riga gift card: una riga per carta."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )

    def test_three_cards_are_three_lines_each_linked_to_its_card(self):
        """Prima ne restava collegata solo l'ultima: le altre due, incassate poi
        da Fedeltà, creavano vendite per denaro già entrato qui."""
        from apps.marketing.models import GiftCard

        cards = [
            GiftCard.objects.create(
                salon=self.salon, code=f"GC-000{n}",
                initial_value=Decimal("50.00"), balance=Decimal("50.00"),
            )
            for n in range(3)
        ]
        with patch(PATCH_LOYALTY), patch(PATCH_CREATE_GC, side_effect=cards) as create_gc:
            sale = finalize_sale(
                self.salon, kind=Sale.Kind.POS, client=self.client_obj,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "gift_card", "value": Decimal("50.00"), "qty": 3}]}],
                payments=[{"method": "cash", "amount": Decimal("150.00")}],
            )
        self.assertEqual(sale.total, Decimal("150.00"))
        self.assertEqual(create_gc.call_count, 3)
        lines = list(sale.lines.all())
        self.assertEqual(len(lines), 3)
        self.assertEqual([line.qty for line in lines], [1, 1, 1])
        self.assertEqual(
            sorted(line.gift_card_id for line in lines), sorted(c.id for c in cards)
        )
