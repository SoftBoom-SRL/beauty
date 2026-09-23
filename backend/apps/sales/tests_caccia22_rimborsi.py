"""Caccia del 22/09 — una caparra restituita esce dalla cassa (02-11, 05-04, 08-17, C23)."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.staff.models import Operator
from common.auth import create_staff_tokens

from .models import DepositRefund, Sale
from .services import record_deposit_cashed, today_summary


class RefundLeavesTheTillTests(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales", "agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.user = user
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore", duration_min=60, price=Decimal("20.00"),
        )

    def _appointment(self, deposit="20.00", price="20.00", status="required"):
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + dt.timedelta(days=3),
            deposit_status=status, deposit_amount=Decimal(deposit),
        )
        AppointmentService.objects.create(
            appointment=appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal(price),
        )
        return appointment

    def test_a_deposit_given_back_in_cash_leaves_the_till(self):
        from apps.agenda.services import cancel_appointment, mark_deposit_cashed, mark_deposit_refunded

        appointment = self._appointment()
        mark_deposit_cashed(appointment, method="cash")      # 20 € in contanti al banco
        cancel_appointment(appointment, reason="imprevisto")  # il salone annulla: da rimborsare
        appointment.refresh_from_db()
        mark_deposit_refunded(appointment)                    # 20 € restituiti dalla cassa
        summary = today_summary(self.salon)
        self.assertEqual(summary["deposit_cashed"], Decimal("20.00"))
        self.assertEqual(summary["deposit_refunded"], Decimal("20.00"))
        self.assertEqual(summary["cash_in"], Decimal("0.00"))
        self.assertEqual(DepositRefund.objects.get().method, "cash")

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_deposit_refunded_on_stripe_leaves_the_till(self):
        from apps.agenda.services import cancel_appointment

        from .api import _payment_intent_succeeded

        appointment = self._appointment(deposit="30.00", price="100.00")
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, {
            "appointment_id": str(appointment.id), "salon_id": str(self.salon.id), "kind": "deposit",
        })
        appointment.refresh_from_db()
        refunded = {"id": "re_1", "amount": 3000, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_deposit", return_value=refunded):
            cancel_appointment(appointment, reason="", actor=self.user, by_client=False)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, "refunded")
        summary = today_summary(self.salon)
        self.assertEqual(summary["deposit_refunded"], Decimal("30.00"))
        self.assertEqual(summary["cash_in"], Decimal("0.00"))
        self.assertEqual(DepositRefund.objects.get().method, "card")

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_the_excess_given_back_at_the_checkout_leaves_the_till(self):
        appointment = self._appointment(deposit="50.00", price="20.00", status="paid")
        appointment.deposit_payment_intent_id = "pi_dep"
        appointment.save(update_fields=["deposit_payment_intent_id"])
        record_deposit_cashed(self.salon, appointment, method="card")
        body = {
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "20.00"},
            ]}],
            "payments": [],  # C17: la caparra copre tutto il conto
        }
        refunded = {"id": "re_excess", "amount": 3000, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded):
            res = self.client.post(
                f"/api/sales/checkout/{appointment.id}", data=json.dumps(body),
                content_type="application/json", **self.auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        summary = today_summary(self.salon)
        # entrati 50 di caparra, restituiti 30: in cassa i 20 del conto
        self.assertEqual(summary["deposit_refunded"], Decimal("30.00"))
        self.assertEqual(summary["cash_in"], Decimal("20.00"))

    def test_a_refund_counts_on_the_day_it_happens(self):
        from apps.agenda.services import record_deposit_refund

        appointment = self._appointment(status="paid")
        record_deposit_cashed(self.salon, appointment, method="card")
        Sale.objects.filter(deposit_appointment=appointment).update(
            created_at=timezone.now() - dt.timedelta(days=2)
        )
        record_deposit_refund(appointment, refund_id="re_1", cents=2000, status="succeeded")
        summary = today_summary(self.salon)
        self.assertEqual(summary["deposit_cashed"], Decimal("0.00"))
        self.assertEqual(summary["deposit_refunded"], Decimal("20.00"))
        self.assertEqual(summary["cash_in"], Decimal("-20.00"))

    def test_a_refund_that_fails_later_puts_the_money_back(self):
        from apps.agenda.services import record_deposit_refund

        appointment = self._appointment(status="paid")
        record_deposit_cashed(self.salon, appointment, method="card")
        record_deposit_refund(appointment, refund_id="re_1", cents=2000, status="succeeded")
        self.assertEqual(today_summary(self.salon)["deposit_refunded"], Decimal("20.00"))
        record_deposit_refund(appointment, refund_id="re_1", cents=2000, status="failed")
        self.assertEqual(today_summary(self.salon)["deposit_refunded"], Decimal("0.00"))
        self.assertFalse(DepositRefund.objects.exists())

    def test_a_deposit_that_never_entered_the_till_leaves_nothing(self):
        # pagata a visita già annullata: niente vendita-caparra, niente da stornare
        from apps.agenda.services import record_deposit_refund

        appointment = self._appointment(status="refund_due")
        record_deposit_refund(appointment, refund_id="re_1", cents=2000, status="succeeded")
        summary = today_summary(self.salon)
        self.assertEqual(summary["deposit_refunded"], Decimal("0.00"))
        self.assertEqual(summary["cash_in"], Decimal("0.00"))

    def test_the_today_summary_endpoint_carries_deposit_refunded(self):
        from apps.agenda.services import record_deposit_refund

        appointment = self._appointment(status="paid")
        record_deposit_cashed(self.salon, appointment, method="card")
        record_deposit_refund(appointment, refund_id="re_1", cents=500, status="succeeded")
        res = self.client.get("/api/sales/today-summary", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["deposit_refunded"]), Decimal("5.00"))
        self.assertEqual(Decimal(res.json()["cash_in"]), Decimal("15.00"))

    def test_insights_count_deposits_net_of_refunds(self):
        from apps.agenda.services import record_deposit_refund
        from apps.insights.services import kpis

        appointment = self._appointment(deposit="30.00", status="paid")
        record_deposit_cashed(self.salon, appointment, method="card")
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="succeeded")
        result = kpis(self.salon, "month")
        self.assertEqual(result["deposit_cashed"], Decimal("0.00"))
        self.assertEqual(result["cash_in"], Decimal("0.00"))
