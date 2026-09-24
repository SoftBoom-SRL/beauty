"""Test essenziali per apps.sales.

I servizi cross-app (inventory, marketing) sono mockati: qui si verifica solo
che finalize_sale li invochi con gli argomenti giusti, come da SPEC §8.
"""

from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings
from ninja.errors import HttpError

from apps.clients.models import Client
from apps.inventory.models import Product, Supplier
from apps.core.models import ActivityLog, OutboxEvent, Salon
from common.auth import create_staff_tokens

from .models import Payment, Sale, SaleLine
from .services import finalize_sale, line_amount, today_summary

PATCH_DEDUCT = "apps.inventory.services.deduct_stock_for_sale"
PATCH_LOYALTY = "apps.marketing.services.accrue_loyalty"
PATCH_REDEEM = "apps.marketing.services.redeem_gift_card"
PATCH_CREATE_GC = "apps.marketing.services.create_gift_card"


def _blocks(lines, operator_id=None):
    return [{"operator_id": operator_id, "lines": lines}]


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


class StripeWebhookTests(TestCase):
    """Webhook Stripe: firma obbligatoria, `metadata.kind` rispettato, idempotente, importo verificato."""

    URL = "/api/sales/stripe/webhook"

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.appointment = Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=operator,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="required",
            deposit_amount=Decimal("15.00"),
            # Caparra con scadenza in corso: il pagamento deve spegnerla.
            deposit_due_at=timezone.now() + timezone.timedelta(minutes=30),
        )

    def _event(self, kind, amount=1500, intent="pi_1"):
        return {
            "type": "payment_intent.succeeded",
            "data": {
                "object": {
                    "id": intent,
                    "amount": amount,
                    "amount_received": amount,
                    "metadata": {"appointment_id": str(self.appointment.id), "kind": kind},
                }
            },
        }

    def _post(self, event):
        import json

        with patch("stripe.Webhook.construct_event", return_value=event):
            return self.client.post(
                self.URL, data=json.dumps(event), content_type="application/json",
                HTTP_STRIPE_SIGNATURE="t=1,v1=abc",
            )

    @override_settings(STRIPE_WEBHOOK_SECRET="")
    def test_unsigned_webhook_refused_without_secret(self):
        import json

        res = self.client.post(self.URL, data=json.dumps(self._event("deposit")), content_type="application/json")
        self.assertEqual(res.status_code, 503)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "required")

    @override_settings(STRIPE_WEBHOOK_SECRET="whsec_test")
    def test_bad_signature_rejected(self):
        import json

        with patch("stripe.Webhook.construct_event", side_effect=ValueError("bad payload")):
            res = self.client.post(
                self.URL, data=json.dumps(self._event("deposit")), content_type="application/json",
                HTTP_STRIPE_SIGNATURE="t=1,v1=wrong",
            )
        self.assertEqual(res.status_code, 400)

    @override_settings(STRIPE_WEBHOOK_SECRET="whsec_test")
    def test_deposit_intent_marks_paid_once(self):
        self.assertEqual(self._post(self._event("deposit")).status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_1")
        # Caparra arrivata: niente più conto alla rovescia in dashboard, e
        # nessun rilascio automatico del posto.
        self.assertIsNone(self.appointment.deposit_due_at)
        # Stripe può reinviare lo stesso evento: nessun doppio log
        self.assertEqual(self._post(self._event("deposit")).status_code, 200)
        self.assertEqual(ActivityLog.objects.filter(salon=self.salon, type="deposit.paid").count(), 1)

    @override_settings(STRIPE_WEBHOOK_SECRET="whsec_test")
    def test_no_show_intent_does_not_pay_the_deposit(self):
        self.appointment.deposit_status = "forfeited"
        self.appointment.save(update_fields=["deposit_status"])
        self.assertEqual(self._post(self._event("no_show", amount=5000, intent="pi_ns")).status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "forfeited")
        self.assertEqual(self.appointment.no_show_payment_intent_id, "pi_ns")
        self.assertFalse(ActivityLog.objects.filter(salon=self.salon, type="deposit.paid").exists())

    @override_settings(STRIPE_WEBHOOK_SECRET="whsec_test")
    def test_insufficient_amount_is_not_accepted(self):
        self.assertEqual(self._post(self._event("deposit", amount=500)).status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "required")
        self.assertTrue(ActivityLog.objects.filter(salon=self.salon, type="deposit.payment_mismatch").exists())


@override_settings(STRIPE_SECRET_KEY="sk_test_x")
class ChargeNoShowTests(TestCase):
    """Un solo addebito no-show per appuntamento, con idempotency key verso Stripe."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            consents={"card_charge": True}, stripe_customer_id="cus_1", stripe_payment_method_id="pm_1",
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=60, price=Decimal("50.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() - timezone.timedelta(hours=3), status="no_show",
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=service, operator=operator, duration_min=60, price=Decimal("50.00"),
        )

    def test_second_charge_is_refused_and_stripe_is_called_once(self):
        from . import stripe_service

        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns_1"}) as create:
            intent, amount = stripe_service.charge_full_amount(self.appointment)
            with self.assertRaises(HttpError) as caught:
                stripe_service.charge_full_amount(self.appointment)
        self.assertEqual(intent["id"], "pi_ns_1")
        self.assertEqual(amount, Decimal("50.00"))
        self.assertEqual(caught.exception.status_code, 409)
        create.assert_called_once()
        # La carta entra nella chiave: un addebito rifiutato non deve bruciare
        # per 24 h il ritentativo con un'altra carta.
        self.assertEqual(
            create.call_args.kwargs["idempotency_key"],
            f"no-show-{self.salon.id}-{self.appointment.id}-pm_1",
        )
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.no_show_payment_intent_id, "pi_ns_1")

    def test_only_no_show_appointments_can_be_charged(self):
        from . import stripe_service

        self.appointment.status = "confirmed"
        self.appointment.save(update_fields=["status"])
        with patch("stripe.PaymentIntent.create") as create:
            with self.assertRaises(HttpError) as caught:
                stripe_service.charge_full_amount(self.appointment)
        self.assertEqual(caught.exception.status_code, 400)
        create.assert_not_called()


class DepositLinkAndConnectTests(TestCase):
    """Link caparra (Checkout Stripe) e Stripe Connect del titolare."""

    def setUp(self):
        from django.utils import timezone

        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment
        from apps.core.models import SalonSettings
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        SalonSettings.objects.create(salon=self.salon, deposit_hold_minutes=60)
        self.salon = Salon.objects.get(pk=self.salon.pk)
        owner = User.objects.create_user(email="owner@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}
        staff = User.objects.create_user(email="staff@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front", scopes=["sales"])
        Membership.objects.create(user=staff, salon=self.salon, role=role)
        self.staff_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(staff, self.salon)['access']}"}
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222", email="sofia@example.com")
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="B")
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="required", deposit_amount=Decimal("15.00"),
            deposit_due_at=timezone.now() + timezone.timedelta(minutes=60),
        )

    @override_settings(STRIPE_SECRET_KEY="")
    def test_link_without_stripe_is_503_and_booking_flow_is_unaffected(self):
        from . import stripe_service

        res = self.client.post(f"/api/sales/appointments/{self.appointment.id}/deposit-link", data="{}", content_type="application/json", **self.staff_auth)
        self.assertEqual(res.status_code, 503)
        self.assertEqual(stripe_service.ensure_deposit_link(self.appointment), "")

    @override_settings(STRIPE_SECRET_KEY="sk_test_x", CLIENT_APP_ORIGIN="https://app.example.com")
    def test_link_is_created_stored_and_queued_for_the_client(self):
        sessions = [
            {"url": "https://checkout.stripe.com/c/pay/cs_1"},
            {"url": "https://checkout.stripe.com/c/pay/cs_2"},
        ]
        with patch("stripe.checkout.Session.create", side_effect=sessions) as create:
            res = self.client.post(f"/api/sales/appointments/{self.appointment.id}/deposit-link", data="{}", content_type="application/json", **self.staff_auth)
            self.assertEqual(res.status_code, 200, res.content)
            self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_1")
            # Secondo invio = sollecito: la sessione porta la stessa scadenza
            # della caparra, quindi rispedire la vecchia manderebbe la cliente su
            # una pagina già chiusa da Stripe. Se ne crea una nuova.
            res = self.client.post(f"/api/sales/appointments/{self.appointment.id}/deposit-link", data="{}", content_type="application/json", **self.staff_auth)
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_2")
        self.assertEqual(create.call_count, 2)
        kwargs = create.call_args.kwargs
        self.assertEqual(kwargs["mode"], "payment")
        self.assertEqual(kwargs["line_items"][0]["price_data"]["unit_amount"], 1500)
        self.assertEqual(kwargs["payment_intent_data"]["metadata"]["kind"], "deposit")
        self.assertTrue(kwargs["success_url"].startswith("https://app.example.com/the-parlour?deposit=paid"))
        self.assertIn("expires_at", kwargs)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_payment_link, "https://checkout.stripe.com/c/pay/cs_2")
        self.assertEqual(OutboxEvent.objects.filter(event_type="deposit.payment_link").count(), 2)
        # partono DOPO i messaggi dell'appuntamento ancora trattenuti (stessa chiave)
        self.assertEqual(
            set(OutboxEvent.objects.filter(event_type="deposit.payment_link").values_list("coalesce_key", flat=True)),
            {f"appointment:{self.appointment.id}"},
        )
        # anche la cliente può chiederlo dall'app
        from common.auth import create_client_tokens

        client_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        res = self.client.post(f"/api/sales/client/appointments/{self.appointment.id}/deposit-link", data="{}", content_type="application/json", **client_auth)
        self.assertEqual(res.status_code, 200, res.content)

    @override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_test")
    def test_checkout_completed_marks_deposit_paid_and_stops_the_hold(self):
        event = {
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_1", "payment_status": "paid", "payment_intent": "pi_from_checkout", "amount_total": 1500,
                "metadata": {"appointment_id": str(self.appointment.id), "kind": "deposit"},
            }},
        }
        import json as _json

        with patch("stripe.Webhook.construct_event", return_value=event):
            res = self.client.post("/api/sales/stripe/webhook", data=_json.dumps(event), content_type="application/json", HTTP_STRIPE_SIGNATURE="t=1,v1=x")
        self.assertEqual(res.status_code, 200, res.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_from_checkout")
        self.assertIsNone(self.appointment.deposit_due_at)
        self.assertEqual(
            OutboxEvent.objects.get(event_type="deposit.paid").coalesce_key,
            f"appointment:{self.appointment.id}",
        )

    @override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_CONNECT_CLIENT_ID="ca_test", FRONTEND_ORIGIN="https://beauty.example.com")
    def test_connect_start_callback_and_disconnect(self):
        from urllib.parse import parse_qs, urlparse

        res = self.client.get("/api/sales/stripe/connect/status", **self.auth)
        self.assertEqual(res.json(), {**res.json(), "available": True, "connected": False, "payments_enabled": True})
        res = self.client.post("/api/sales/stripe/connect/start", data="{}", content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        url = urlparse(res.json()["url"])
        self.assertEqual(url.netloc, "connect.stripe.com")
        query = parse_qs(url.query)
        self.assertEqual(query["client_id"], ["ca_test"])
        self.assertEqual(query["redirect_uri"], ["https://beauty.example.com/stripe-connect/done"])
        state = query["state"][0]
        # solo il titolare
        res = self.client.post("/api/sales/stripe/connect/start", data="{}", content_type="application/json", **self.staff_auth)
        self.assertEqual(res.status_code, 403)
        # callback con lo state firmato
        import json as _json

        with patch("stripe.OAuth.token", return_value={"stripe_user_id": "acct_123"}):
            res = self.client.post("/api/sales/stripe/connect/callback", data=_json.dumps({"code": "ac_x", "state": state}), content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["connected"])
        self.assertEqual(res.json()["account_id"], "acct_123")
        # le chiamate Stripe successive vanno sull'account collegato
        from . import stripe_service

        self.appointment.salon = Salon.objects.get(pk=self.salon.pk)
        with patch("stripe.checkout.Session.create", return_value={"url": "https://checkout.stripe.com/c/pay/cs_2"}) as create:
            stripe_service.ensure_deposit_link(self.appointment)
        self.assertEqual(create.call_args.kwargs["stripe_account"], "acct_123")
        # state manomesso
        res = self.client.post("/api/sales/stripe/connect/callback", data=_json.dumps({"code": "ac_x", "state": state + "x"}), content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 400)
        with patch("stripe.OAuth.deauthorize", return_value={}):
            res = self.client.delete("/api/sales/stripe/connect", **self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()["connected"])

    def test_today_summary_separates_gift_card_money(self):
        from .models import Payment, Sale, SaleLine
        from .services import today_summary

        sale = Sale.objects.create(salon=self.salon, kind=Sale.Kind.POS, total=Decimal("80.00"))
        SaleLine.objects.create(sale=sale, line_type="service", qty=1, unit_price=Decimal("50.00"), amount=Decimal("50.00"))
        SaleLine.objects.create(sale=sale, line_type="gift_card", qty=1, unit_price=Decimal("30.00"), amount=Decimal("30.00"))
        Payment.objects.create(sale=sale, method="gift_card", amount=Decimal("50.00"))
        Payment.objects.create(sale=sale, method="cash", amount=Decimal("30.00"))
        summary = today_summary(self.salon)
        self.assertEqual(summary["total"], Decimal("80.00"))
        self.assertEqual(summary["gift_card_sold"], Decimal("30.00"))
        self.assertEqual(summary["gift_card_redeemed"], Decimal("50.00"))
        self.assertEqual(summary["cash_in"], Decimal("30.00"))


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


class DepositRefundStateTests(TestCase):
    """Lo stato della caparra deve seguire quello che Stripe dice davvero.

    Un rimborso parziale marcava l'intera caparra come rimborsata (la quota
    ancora trattenuta spariva dal conto al checkout) e un rimborso ancora
    «pending» veniva dichiarato avvenuto.
    """

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.Appointment = Appointment
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore",
            duration_min=60, price=Decimal("100.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="paid", deposit_amount=Decimal("30.00"),
            deposit_payment_intent_id="pi_dep",
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=service, operator=operator,
            duration_min=60, price=Decimal("100.00"),
        )

    def _refunded(self, payload, event_type="charge.refunded"):
        from .api import _charge_refunded

        _charge_refunded(payload, event_type)
        self.appointment.refresh_from_db()

    def test_a_partial_refund_leaves_the_rest_deductible(self):
        self._refunded(
            {"payment_intent": "pi_dep", "amount": 3000, "amount_refunded": 1000, "refunded": False}
        )
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("10.00"))
        # Al checkout si detraggono i 20 € ancora in cassa, non i 30 iniziali.
        self.assertEqual(self.appointment.deposit_credit, Decimal("20.00"))

    def test_a_full_refund_marks_the_deposit_refunded(self):
        self._refunded(
            {"payment_intent": "pi_dep", "amount": 3000, "amount_refunded": 3000, "refunded": True}
        )
        self.assertEqual(self.appointment.deposit_status, "refunded")
        self.assertEqual(self.appointment.deposit_credit, Decimal("0.00"))

    def test_a_pending_refund_is_not_a_refund_yet(self):
        self._refunded(
            {"id": "re_1", "payment_intent": "pi_dep", "amount": 3000, "status": "pending"},
            "refund.created",
        )
        self.assertEqual(self.appointment.deposit_status, "refunding")
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("0.00"))

        # Stripe conferma più tardi con lo stesso id: ora sì.
        self._refunded(
            {"id": "re_1", "payment_intent": "pi_dep", "amount": 3000, "status": "succeeded"},
            "refund.updated",
        )
        self.assertEqual(self.appointment.deposit_status, "refunded")
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("30.00"))

    def test_a_failed_refund_puts_the_money_back_in_the_till(self):
        self._refunded(
            {"id": "re_2", "payment_intent": "pi_dep", "amount": 3000, "status": "pending"},
            "refund.created",
        )
        self._refunded(
            {"id": "re_2", "payment_intent": "pi_dep", "amount": 3000, "status": "failed"},
            "refund.failed",
        )
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_credit, Decimal("30.00"))

    def test_the_same_refund_twice_counts_once(self):
        payload = {"id": "re_3", "payment_intent": "pi_dep", "amount": 1000, "status": "succeeded"}
        self._refunded(payload, "refund.created")
        self._refunded(payload, "refund.updated")
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("10.00"))
        self.assertEqual(self.appointment.deposit_status, "paid")


class DuplicateDepositPaymentTests(TestCase):
    """Due link di pagamento aperti sulla stessa caparra."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="required", deposit_amount=Decimal("30.00"),
        )

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_resend_closes_the_previous_checkout_session(self):
        from unittest.mock import Mock

        from . import stripe_service

        stripe = Mock()
        stripe.checkout.Session.create.side_effect = [
            {"id": "cs_1", "url": "https://checkout.test/1"},
            {"id": "cs_2", "url": "https://checkout.test/2"},
        ]
        with patch.object(stripe_service, "_client", return_value=stripe):
            stripe_service.ensure_deposit_link(self.appointment)
            self.appointment.refresh_from_db()
            self.assertEqual(self.appointment.deposit_checkout_session_id, "cs_1")
            stripe_service.ensure_deposit_link(self.appointment, resend=True)
        stripe.checkout.Session.expire.assert_called_once_with("cs_1")
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_checkout_session_id, "cs_2")

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_second_payment_is_refunded_and_written_down(self):
        from unittest.mock import Mock

        from apps.core.models import ActivityLog

        from .api import _payment_intent_succeeded

        metadata = {
            "appointment_id": str(self.appointment.id),
            "salon_id": str(self.salon.id),
            "kind": "deposit",
        }
        _payment_intent_succeeded({"id": "pi_first", "amount_received": 3000}, metadata)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_first")

        stripe = Mock()
        stripe.Refund.create.return_value = {"id": "re_dup", "status": "succeeded"}
        with patch("apps.sales.stripe_service._client", return_value=stripe):
            _payment_intent_succeeded({"id": "pi_second", "amount_received": 3000}, metadata)
        stripe.Refund.create.assert_called_once()
        self.assertEqual(stripe.Refund.create.call_args.kwargs["payment_intent"], "pi_second")
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_first")
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.duplicate_payment").exists()
        )


class NoShowAmountTests(TestCase):
    """L'importo comunicato deve essere quello chiesto alla carta."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            consents={"card_charge": True}, stripe_customer_id="cus_1",
            stripe_payment_method_id="pm_1",
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore",
            duration_min=60, price=Decimal("100.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() - timezone.timedelta(hours=3), status="no_show",
            deposit_status="forfeited", deposit_amount=Decimal("30.00"),
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=service, operator=operator,
            duration_min=60, price=Decimal("100.00"),
        )

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_the_charge_and_the_reported_amount_are_the_same(self):
        from apps.accounts.models import Membership, User
        from apps.core.models import ActivityLog

        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        token = create_staff_tokens(user, self.salon)["access"]
        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns"}) as create:
            response = self.client.post(
                f"/api/sales/appointments/{self.appointment.id}/charge-no-show",
                "{}",
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {token}",
            )
        self.assertEqual(response.status_code, 200, response.content)
        # 100 € di servizio meno i 30 già trattenuti: 70, ovunque.
        self.assertEqual(create.call_args.kwargs["amount"], 7000)
        self.assertEqual(Decimal(response.json()["amount"]), Decimal("70.00"))
        logged = ActivityLog.objects.get(salon=self.salon, type="sale.no_show_charged")
        self.assertEqual(Decimal(logged.payload["amount"]), Decimal("70.00"))

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_partly_refunded_deposit_no_longer_covers_the_whole_charge(self):
        """Con 10 € già restituiti su 30, in cassa ne restano 20: l'addebito
        deve scendere di 20, non di 30, altrimenti il salone ci perde 10."""
        from . import stripe_service

        self.appointment.deposit_refunded_amount = Decimal("10.00")
        self.appointment.save(update_fields=["deposit_refunded_amount"])
        self.assertEqual(
            stripe_service.no_show_charge_amount(self.appointment), Decimal("80.00")
        )

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_the_no_show_charge_becomes_money_in_the_till(self):
        """Prima restava solo una riga nel registro: riepilogo e KPI a zero."""
        from apps.accounts.models import Membership, User

        user = User.objects.create_user(email="ada@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        token = create_staff_tokens(user, self.salon)["access"]
        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns"}):
            response = self.client.post(
                f"/api/sales/appointments/{self.appointment.id}/charge-no-show",
                "{}",
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {token}",
            )
        self.assertEqual(response.status_code, 200, response.content)
        sale = Sale.objects.get(appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("70.00"))
        self.assertEqual(sale.payments.get().method, "card")
        self.assertEqual(today_summary(self.salon)["cash_in"], Decimal("70.00"))


class CheckoutApiTests(TestCase):
    """I controlli del checkout, dall'HTTP: erano senza un solo test.

    Caparra detratta al netto dei rimborsi, secondo incasso rifiutato,
    appuntamento annullato rifiutato, caparra più alta del conto.
    """

    def setUp(self):
        from django.utils import timezone

        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.Appointment = Appointment
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi"
        )
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore",
            duration_min=60, price=Decimal("100.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + timezone.timedelta(days=1),
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal("100.00"),
        )

    def _deposit(self, amount, *, refunded="0.00", status="paid", intent=""):
        self.appointment.deposit_amount = Decimal(amount)
        self.appointment.deposit_refunded_amount = Decimal(refunded)
        self.appointment.deposit_status = status
        self.appointment.deposit_payment_intent_id = intent
        self.appointment.save()

    def _checkout(self, price="100.00", paid="100.00", method="cash"):
        import json

        payments = [] if Decimal(paid) == 0 else [{"method": method, "amount": paid}]
        body = {
            "blocks": [
                {
                    "operator_id": self.operator.id,
                    "lines": [
                        {
                            "line_type": "service",
                            "service_id": self.service.id,
                            "qty": 1,
                            "unit_price": price,
                        }
                    ],
                }
            ],
            "payments": payments,
        }
        return self.client.post(
            f"/api/sales/checkout/{self.appointment.id}",
            json.dumps(body),
            content_type="application/json",
            **self.auth,
        )

    def test_the_deposit_is_deducted_net_of_what_was_refunded(self):
        """30 di caparra con 10 già restituiti: se ne detraggono 20, non 30."""
        self._deposit("30.00", refunded="10.00")
        response = self._checkout(paid="80.00")
        self.assertEqual(response.status_code, 200, response.content)
        sale = Sale.objects.get(appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("100.00"))
        self.assertEqual(sale.deposit_deducted, Decimal("20.00"))
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "closed")
        # la richiesta di recensione parte dopo i messaggi della visita ancora in coda
        self.assertEqual(
            OutboxEvent.objects.get(event_type="visit.completed").coalesce_key,
            f"appointment:{self.appointment.id}",
        )
        # la quota già restituita non può essere detratta di nuovo
        self.assertEqual(self._checkout(paid="80.00").status_code, 400)

    def test_paying_the_whole_bill_without_the_deposit_is_refused(self):
        self._deposit("30.00")
        response = self._checkout(paid="100.00")
        self.assertEqual(response.status_code, 422, response.content)
        self.assertFalse(Sale.objects.filter(appointment=self.appointment).exists())

    def test_a_second_checkout_is_refused(self):
        self.assertEqual(self._checkout().status_code, 200)
        response = self._checkout()
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(Sale.objects.filter(appointment=self.appointment).count(), 1)

    def test_a_cancelled_or_no_show_appointment_cannot_be_cashed(self):
        for status in ("cancelled", "no_show"):
            self.appointment.status = status
            self.appointment.save(update_fields=["status"])
            response = self._checkout()
            self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(Sale.objects.count(), 0)

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_deposit_bigger_than_the_bill_is_capped_and_given_back(self):
        """Servizio ridotto dopo la prenotazione: prima il conto era impossibile
        da chiudere (dovuto negativo → 422 per sempre)."""
        self._deposit("50.00", intent="pi_dep")
        with patch(
            "stripe.Refund.create", return_value={"id": "re_x", "amount": 3000, "status": "succeeded"}
        ) as refund:
            response = self._checkout(price="20.00", paid="0")
        self.assertEqual(response.status_code, 200, response.content)
        sale = Sale.objects.get(appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("20.00"))
        self.assertEqual(sale.deposit_deducted, Decimal("20.00"))
        # i 30 di troppo tornano alla cliente, non restano in cassa
        self.assertEqual(refund.call_args.kwargs["amount"], 3000)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("30.00"))
        self.assertEqual(self.appointment.deposit_status, "paid")

    def test_an_excess_that_stripe_cannot_return_is_written_down(self):
        self._deposit("50.00")  # caparra incassata in salone: nessun intent
        response = self._checkout(price="20.00", paid="0")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(
            ActivityLog.objects.filter(
                salon=self.salon, type="deposit.excess_refund_due"
            ).exists()
        )

    def test_the_checkout_does_not_overwrite_a_deposit_paid_meanwhile(self):
        """La cliente paga il link mentre la cassiera chiude il conto: il salvataggio
        finale riportava la caparra a «richiesta» e cancellava il PaymentIntent."""
        from apps.sales.api import finalize_sale as real_finalize

        def _paid_meanwhile(*args, **kwargs):
            self.Appointment.objects.filter(pk=self.appointment.pk).update(
                deposit_status="paid", deposit_payment_intent_id="pi_late"
            )
            return real_finalize(*args, **kwargs)

        with patch("apps.sales.api.finalize_sale", side_effect=_paid_meanwhile):
            response = self._checkout()
        self.assertEqual(response.status_code, 200, response.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "closed")
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_late")

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_closing_the_bill_closes_the_payment_link(self):
        """Il link restava pagabile a conto chiuso: 100 in salone + 30 sul link."""
        from . import stripe_service

        self.appointment.deposit_status = "required"
        self.appointment.deposit_amount = Decimal("30.00")
        self.appointment.deposit_checkout_session_id = "cs_1"
        self.appointment.save()
        with patch.object(stripe_service, "expire_deposit_checkout") as expire:
            self.assertEqual(self._checkout().status_code, 200)
        expire.assert_called_once()

    def test_the_sale_detail_asks_for_the_sales_permission(self):
        from apps.accounts.models import Membership, Role, User

        self.assertEqual(self._checkout().status_code, 200)
        sale = Sale.objects.get(appointment=self.appointment)
        other = User.objects.create_user(email="nina@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Sala", scopes=["agenda"])
        Membership.objects.create(user=other, salon=self.salon, role=role)
        token = create_staff_tokens(other, self.salon)["access"]
        response = self.client.get(
            f"/api/sales/{sale.id}", HTTP_AUTHORIZATION=f"Bearer {token}"
        )
        self.assertEqual(response.status_code, 403, response.content)

    def test_a_negative_page_is_refused_not_a_500(self):
        response = self.client.get("/api/sales/?limit=-1", **self.auth)
        self.assertEqual(response.status_code, 422, response.content)

    def test_filtering_by_operator_counts_only_her_lines(self):
        """Una vendita da 100 con 20 di Giulia le veniva attribuita per intero."""
        import json

        from apps.staff.models import Operator

        anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="Neri")
        body = {
            "blocks": [
                {"operator_id": self.operator.id, "lines": [
                    {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "20.00"}]},
                {"operator_id": anna.id, "lines": [
                    {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "80.00"}]},
            ],
            "payments": [{"method": "cash", "amount": "100.00"}],
        }
        response = self.client.post(
            f"/api/sales/checkout/{self.appointment.id}", json.dumps(body),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(response.status_code, 200, response.content)
        listed = self.client.get(f"/api/sales/?operator_id={self.operator.id}", **self.auth)
        self.assertEqual(listed.json()["kpi"]["revenue"], "20.00")


class DepositIsCashOfItsOwnDayTests(TestCase):
    """La caparra si conta il giorno in cui arriva, non quello del conto finale."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="required", deposit_amount=Decimal("30.00"),
        )
        self.metadata = {
            "appointment_id": str(self.appointment.id),
            "salon_id": str(self.salon.id),
            "kind": "deposit",
        }

    def test_the_deposit_paid_online_enters_the_till_that_day(self):
        from .api import _payment_intent_succeeded

        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata)
        sale = Sale.objects.get(deposit_appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("30.00"))
        self.assertEqual(sale.payments.get().method, "card")
        summary = today_summary(self.salon)
        self.assertEqual(summary["cash_in"], Decimal("30.00"))
        # È un anticipo, non un conto: denaro in cassa, ma niente venduto e
        # nessuno scontrino in più nel riepilogo.
        self.assertEqual(summary["deposit_cashed"], Decimal("30.00"))
        self.assertEqual(summary["total"], Decimal("0.00"))
        self.assertEqual(summary["count"], 0)
        # lo stesso evento ripetuto non incassa due volte
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata)
        self.assertEqual(Sale.objects.filter(deposit_appointment=self.appointment).count(), 1)

    def test_the_same_money_is_not_counted_twice_at_the_checkout(self):
        from .api import _payment_intent_succeeded

        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata)
        self.appointment.refresh_from_db()
        with patch(PATCH_LOYALTY):
            finalize_sale(
                self.salon, kind=Sale.Kind.CHECKOUT, client=self.client_obj,
                appointment=self.appointment,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "service", "qty": 1, "unit_price": Decimal("100.00")}]}],
                payments=[{"method": "cash", "amount": Decimal("70.00")}],
                deposit_deducted=self.appointment.deposit_credit,
            )
        summary = today_summary(self.salon)
        self.assertEqual(summary["deposit_used"], Decimal("30.00"))
        # 30 di caparra + 70 saldati: cento euro, contati una volta sola
        self.assertEqual(summary["cash_in"], Decimal("100.00"))
        # e il venduto è il conto, non conto + anticipo
        self.assertEqual(summary["total"], Decimal("100.00"))
        self.assertEqual(summary["count"], 1)

    def test_paying_the_link_after_the_bill_is_given_back(self):
        """Caparra pagata a conto già chiuso: prima diventava semplicemente
        «pagata» e il salone teneva 130 € per un conto da 100."""
        from .api import _payment_intent_succeeded

        self.appointment.status = "closed"
        self.appointment.save(update_fields=["status"])
        Sale.objects.create(
            salon=self.salon, kind=Sale.Kind.CHECKOUT, appointment=self.appointment,
            client=self.client_obj, total=Decimal("100.00"),
        )
        _payment_intent_succeeded({"id": "pi_late", "amount_received": 3000}, self.metadata)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "refund_due")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_late")
        self.assertFalse(Sale.objects.filter(deposit_appointment=self.appointment).exists())

    def test_a_payment_from_the_account_of_its_own_link_is_accepted(self):
        """Il titolare collega Stripe mentre un link è in volo: l'evento nasce
        sull'account di prima e veniva scartato con i soldi già incassati."""
        from apps.core.models import SalonSettings

        from . import stripe_service
        from .api import _payment_intent_succeeded

        token = stripe_service.account_token(self.salon)  # nessun account: piattaforma
        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"stripe_account_id": "acct_nuovo"}
        )
        self.salon.refresh_from_db()
        _payment_intent_succeeded(
            {"id": "pi_1", "amount_received": 3000}, {**self.metadata, "acct": token}, ""
        )
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")

    def test_an_event_from_an_unknown_account_is_still_ignored(self):
        from .api import _payment_intent_succeeded

        _payment_intent_succeeded(
            {"id": "pi_1", "amount_received": 3000},
            {**self.metadata, "acct": "firma-inventata"},
            "acct_estraneo",
        )
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "required")
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.payment_ignored").exists()
        )


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


class BugHunt21SeptemberTests(TestCase):
    """Difetti trovati nella caccia ai bug del 21/09/2026 (docs/BUG_HUNT_2026-09-21.md)."""

    def setUp(self):
        from django.utils import timezone

        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.Appointment = Appointment
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure",
            duration_min=60, price=Decimal("50.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + timezone.timedelta(hours=2),
            deposit_status="required", deposit_amount=Decimal("20.00"),
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal("50.00"),
        )
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _checkout(self, amount="50.00"):
        import json

        return self.client.post(
            f"/api/sales/checkout/{self.appointment.id}",
            json.dumps({
                "blocks": [{"operator_id": self.operator.id, "lines": [
                    {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "50.00"}
                ]}],
                "payments": [{"method": "cash", "amount": amount}],
            }),
            content_type="application/json",
            **self.auth,
        )

    # ---- B17 -------------------------------------------------------------

    def test_a_deposit_paid_while_the_checkout_runs_is_not_wiped(self):
        """La visita si chiudeva con un save() completo su un'istanza letta
        all'inizio della richiesta: il webhook della caparra pagata, arrivato
        nel frattempo, veniva riscritto all'indietro — denaro incassato su
        Stripe e PaymentIntent perso, quindi nemmeno rimborsabile."""
        from . import api as sales_api

        real_finalize = sales_api.finalize_sale

        def interleaved(*args, **kwargs):
            # il webhook Stripe arriva mentre il checkout è in corso
            self.Appointment.objects.filter(pk=self.appointment.pk).update(
                deposit_status="paid", deposit_payment_intent_id="pi_probe_123", deposit_due_at=None
            )
            return real_finalize(*args, **kwargs)

        with patch.object(sales_api, "finalize_sale", side_effect=interleaved):
            response = self._checkout()
        self.assertEqual(response.status_code, 200, response.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "closed")
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_probe_123")

    def test_the_deposit_deducted_is_the_one_read_under_the_lock(self):
        """Caparra già pagata: il conto la detrae, e il pagamento chiesto alla
        cliente è il saldo."""
        self.appointment.deposit_status = "paid"
        self.appointment.save(update_fields=["deposit_status"])
        response = self._checkout(amount="30.00")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Decimal(response.json()["sale"]["deposit_deducted"]), Decimal("20.00"))

    def test_a_cancelled_appointment_is_still_refused(self):
        self.appointment.status = "cancelled"
        self.appointment.save(update_fields=["status"])
        response = self._checkout()
        self.assertEqual(response.status_code, 400, response.content)
        self.assertFalse(Sale.objects.filter(appointment=self.appointment).exists())

    def test_the_same_appointment_cannot_be_cashed_twice(self):
        self.assertEqual(self._checkout().status_code, 200)
        second = self._checkout()
        self.assertEqual(second.status_code, 400, second.content)
        self.assertEqual(Sale.objects.filter(appointment=self.appointment).count(), 1)

    # ---- B25 -------------------------------------------------------------

    def test_every_gift_card_sold_has_its_own_line(self):
        """Con una riga da tre carte ne venivano emesse tre ma una sola restava
        collegata alla vendita: le altre risultavano «mai vendute» e
        reincassabili una seconda volta dalla sezione Fedeltà."""
        from apps.marketing.models import GiftCard
        from .services import record_gift_card_cashed

        with patch(PATCH_LOYALTY):
            sale = finalize_sale(
                self.salon,
                kind=Sale.Kind.POS,
                blocks=_blocks([{"line_type": "gift_card", "value": Decimal("50.00"), "qty": 3}]),
                payments=[{"method": "cash", "amount": Decimal("150.00")}],
                client=self.client_obj,
            )
        cards = list(GiftCard.objects.filter(salon=self.salon).order_by("id"))
        self.assertEqual(len(cards), 3)
        self.assertEqual(sale.total, Decimal("150.00"))
        lines = list(SaleLine.objects.filter(sale=sale).order_by("id"))
        self.assertEqual(len(lines), 3)
        self.assertEqual([line.qty for line in lines], [1, 1, 1])
        self.assertEqual(
            sorted(line.gift_card_id for line in lines), sorted(c.id for c in cards)
        )
        # nessuna carta può essere incassata una seconda volta
        for card in cards:
            self.assertIsNone(record_gift_card_cashed(self.salon, card, method="cash"))
