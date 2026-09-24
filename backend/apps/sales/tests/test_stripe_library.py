"""Caccia del 22/09 — Stripe con la libreria VERA (stripe==15.6.1).

Solo lo strato HTTP è finto (`FakeStripeHTTP`): richieste, risposte e oggetti
sono quelli della libreria, quindi `Session`, `Refund`, `Event`… sono
`StripeObject` e non dict. I test di prima mockavano le chiamate con dict e per
questo non vedevano che ogni `.get()` su una risposta esplodeva (05-01).
"""

import time
from decimal import Decimal

from django.core import signing
from django.test import override_settings

from apps.agenda.models import Appointment
from apps.core.models import ActivityLog
from common.auth import create_client_tokens

from ..models import Sale
from .base import StripeTestBase, event_payload


@override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_platform")
class StripeObjectsAreNotDictsTests(StripeTestBase):
    """05-01: ogni risposta Stripe va letta come oggetto della libreria, non come dict."""

    def test_the_deposit_link_is_created_and_stored(self):
        from .. import stripe_service

        http = self.fake([("POST", "/v1/checkout/sessions", {
            "id": "cs_test_1", "object": "checkout.session",
            "url": "https://checkout.stripe.com/c/pay/cs_test_1",
            "expires_at": int(time.time()) + 3600,
        })])
        url = stripe_service.ensure_deposit_link(self.appointment)
        self.assertEqual(url, "https://checkout.stripe.com/c/pay/cs_test_1")
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_payment_link, url)
        self.assertEqual(self.appointment.deposit_checkout_session_id, "cs_test_1")
        self.assertEqual(len(http.calls_to("/v1/checkout/sessions")), 1)

    def test_the_staff_link_endpoint_answers(self):
        self.fake([("POST", "/v1/checkout/sessions", {
            "id": "cs_test_2", "object": "checkout.session", "url": "https://checkout.stripe.com/c/pay/cs_test_2",
        })])
        res = self.client.post(
            f"/api/sales/appointments/{self.appointment.id}/deposit-link", data="{}",
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_test_2")

    def test_a_signed_payment_event_pays_the_deposit(self):
        payload = event_payload("payment_intent.succeeded", {
            "id": "pi_1", "object": "payment_intent", "amount": 3000, "amount_received": 3000,
            "metadata": self.metadata(),
        })
        res = self.post_event(payload)
        self.assertEqual(res.status_code, 200, res.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_1")
        self.assertEqual(Sale.objects.get(deposit_appointment=self.appointment).total, Decimal("30.00"))

    def test_a_signed_checkout_completed_event_pays_the_deposit(self):
        payload = event_payload("checkout.session.completed", {
            "id": "cs_1", "object": "checkout.session", "payment_status": "paid",
            "payment_intent": "pi_from_session", "amount_total": 3000,
            "metadata": self.metadata(),
        })
        res = self.post_event(payload)
        self.assertEqual(res.status_code, 200, res.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_from_session")

    def test_a_refund_event_is_recorded(self):
        Appointment.objects.filter(pk=self.appointment.pk).update(
            deposit_status="paid", deposit_payment_intent_id="pi_dep",
        )
        payload = event_payload("refund.updated", {
            "id": "re_1", "object": "refund", "amount": 3000, "status": "succeeded",
            "payment_intent": "pi_dep",
        })
        res = self.post_event(payload)
        self.assertEqual(res.status_code, 200, res.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "refunded")
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("30.00"))

    @override_settings(STRIPE_CONNECT_CLIENT_ID="ca_test")
    def test_connect_exchange_saves_the_account(self):
        from .. import stripe_service

        self.fake([("POST", "/oauth/token", {
            "access_token": "sk_x", "stripe_user_id": "acct_123", "livemode": False,
            "token_type": "bearer", "scope": "read_write",
        })])
        state = signing.dumps({"salon": self.salon.id}, salt="youty.stripe-connect")
        self.assertEqual(stripe_service.connect_exchange(self.salon, "ac_code", state), "acct_123")
        self.salon.settings.refresh_from_db()
        self.assertEqual(self.salon.settings.stripe_account_id, "acct_123")

    def test_cancelling_refunds_the_deposit(self):
        from apps.agenda.services import cancel_appointment

        Appointment.objects.filter(pk=self.appointment.pk).update(
            deposit_status="paid", deposit_payment_intent_id="pi_1",
        )
        self.appointment.refresh_from_db()
        http = self.fake([("POST", "/v1/refunds", {
            "id": "re_1", "object": "refund", "amount": 3000, "status": "succeeded",
            "payment_intent": "pi_1",
        })])
        cancel_appointment(self.appointment, reason="", by_client=False)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "refunded")
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("30.00"))
        self.assertEqual(http.calls_to("/v1/refunds")[0]["data"]["payment_intent"], "pi_1")

    def test_the_checkout_refunds_a_deposit_bigger_than_the_bill(self):
        appointment = self.make_appointment(
            price="20.00", deposit_status="paid", deposit_payment_intent_id="pi_dep",
        )
        http = self.fake([
            ("POST", "/v1/checkout/sessions", {"id": "cs_x", "object": "checkout.session"}),
            ("POST", "/v1/refunds", {
                "id": "re_excess", "object": "refund", "amount": 1000, "status": "succeeded",
                "payment_intent": "pi_dep",
            }),
        ])
        res = self.client.post(
            f"/api/sales/checkout/{appointment.id}", data=self.checkout_body("20.00"),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(http.calls_to("/v1/refunds")[0]["data"]["amount"], "1000")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))

    def test_a_reminder_expires_the_previous_session(self):
        from .. import stripe_service

        sessions = iter([
            {"id": "cs_1", "object": "checkout.session", "url": "https://checkout.stripe.com/c/pay/cs_1"},
            {"id": "cs_2", "object": "checkout.session", "url": "https://checkout.stripe.com/c/pay/cs_2"},
        ])
        http = self.fake([
            ("POST", "/v1/checkout/sessions/cs_1/expire", {"id": "cs_1", "object": "checkout.session", "status": "expired"}),
            ("POST", "/v1/checkout/sessions", lambda url, data: next(sessions)),
        ])
        stripe_service.ensure_deposit_link(self.appointment)
        self.appointment.refresh_from_db()
        stripe_service.ensure_deposit_link(self.appointment, resend=True)
        self.assertEqual(len(http.calls_to("/v1/checkout/sessions/cs_1/expire")), 1)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_checkout_session_id, "cs_2")

    def test_the_client_can_ask_for_a_setup_intent(self):
        http = self.fake([
            ("POST", "/v1/customers", {"id": "cus_1", "object": "customer"}),
            ("POST", "/v1/setup_intents", {
                "id": "seti_1", "object": "setup_intent", "client_secret": "seti_1_secret_x",
            }),
        ])
        token = create_client_tokens(self.client_obj)["access"]
        res = self.client.post(
            "/api/sales/client/setup-intent", data="{}", content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json(), {"setup_intent_id": "seti_1", "client_secret": "seti_1_secret_x"})
        self.client_obj.refresh_from_db()
        self.assertEqual(self.client_obj.stripe_customer_id, "cus_1")
        self.assertEqual(http.calls_to("/v1/setup_intents")[0]["data"]["customer"], "cus_1")

    def test_a_no_show_is_charged(self):
        self.client_obj.consents = {"card_charge": True}
        self.client_obj.stripe_customer_id = "cus_1"
        self.client_obj.stripe_payment_method_id = "pm_1"
        self.client_obj.save()
        appointment = self.make_appointment(deposit_status="none", deposit_amount=Decimal("0"), status="no_show")
        self.fake([("POST", "/v1/payment_intents", {
            "id": "pi_ns", "object": "payment_intent", "amount": 10000, "status": "succeeded",
        })])
        res = self.client.post(
            f"/api/sales/appointments/{appointment.id}/charge-no-show", data="{}",
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["payment_intent_id"], "pi_ns")
        appointment.refresh_from_db()
        self.assertEqual(appointment.no_show_payment_intent_id, "pi_ns")

    def test_a_second_payment_on_the_same_deposit_is_refunded(self):
        from ..api import _payment_intent_succeeded

        _payment_intent_succeeded({"id": "pi_first", "amount_received": 3000}, self.metadata())
        http = self.fake([("POST", "/v1/refunds", {
            "id": "re_dup", "object": "refund", "amount": 3000, "status": "succeeded",
            "payment_intent": "pi_second",
        })])
        payload = event_payload("payment_intent.succeeded", {
            "id": "pi_second", "object": "payment_intent", "amount": 3000, "amount_received": 3000,
            "metadata": self.metadata(),
        }, event_id="evt_2")
        self.assertEqual(self.post_event(payload).status_code, 200)
        self.assertEqual(http.calls_to("/v1/refunds")[0]["data"]["payment_intent"], "pi_second")
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.duplicate_payment")
        self.assertEqual(log.payload["refund_id"], "re_dup")
