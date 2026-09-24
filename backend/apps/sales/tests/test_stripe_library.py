"""Caccia del 22/09 — Stripe con la libreria VERA (stripe==15.6.1).

Solo lo strato HTTP è finto (`FakeStripeHTTP`): richieste, risposte e oggetti
sono quelli della libreria, quindi `Session`, `Refund`, `Event`… sono
`StripeObject` e non dict. I test di prima mockavano le chiamate con dict e per
questo non vedevano che ogni `.get()` su una risposta esplodeva (05-01).
"""

import hashlib
import hmac
import importlib
import json
import os
import time
from decimal import Decimal
from unittest.mock import patch
from urllib.parse import parse_qs

import stripe
from django.core import signing
from django.test import TestCase, override_settings
from django.utils import timezone
from stripe import _http_client

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon
from apps.staff.models import Operator
from common.auth import create_client_tokens, create_staff_tokens

from ..models import Sale

WEBHOOK_URL = "/api/sales/stripe/webhook"


class FakeStripeHTTP(_http_client.HTTPClient):
    """Risponde come l'API Stripe, senza rete.

    `routes` è una lista di (metodo, frammento di URL, risposta): la risposta è
    il JSON da restituire, oppure una funzione (url, post_data) → JSON o
    (JSON, stato HTTP). Ogni richiesta resta in `calls` con intestazioni e corpo.
    """

    name = "fake"

    def __init__(self, routes):
        super().__init__()
        self.routes = routes
        self.calls = []

    def request(self, method, url, headers, post_data=None, *, _usage=None):
        call = {
            "method": method.upper(),
            "url": url,
            "headers": dict(headers or {}),
            "data": {k: v[0] for k, v in parse_qs(post_data or "").items()},
        }
        self.calls.append(call)
        for route_method, fragment, response in self.routes:
            if route_method == call["method"] and fragment in url:
                body = response(url, call["data"]) if callable(response) else response
                status = 200
                if isinstance(body, tuple):
                    body, status = body
                return json.dumps(body), status, {}
        error = {"error": {"message": f"No such route {url}", "type": "invalid_request_error"}}
        return json.dumps(error), 404, {}

    def close(self):
        pass

    def calls_to(self, fragment, method="POST"):
        return [c for c in self.calls if c["method"] == method and fragment in c["url"]]


def sign(payload: str, secret: str) -> str:
    """Intestazione Stripe-Signature valida per `payload` con `secret`."""
    ts = int(time.time())
    digest = hmac.new(secret.encode(), f"{ts}.{payload}".encode(), hashlib.sha256).hexdigest()
    return f"t={ts},v1={digest}"


def event_payload(event_type: str, obj: dict, *, account: str = "", event_id: str = "evt_1") -> str:
    event = {
        "id": event_id,
        "object": "event",
        "type": event_type,
        "created": int(time.time()),
        "data": {"object": obj},
    }
    if account:
        event["account"] = account
    return json.dumps(event)


class StripeTestBase(TestCase):
    """Salone, cliente, operatrice e una visita da 100 € con caparra 30 € richiesta."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales", "agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.user = user
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            email="sofia@example.com",
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore", duration_min=60,
            price=Decimal("100.00"),
        )
        self.appointment = self.make_appointment()
        self._previous_http = stripe.default_http_client
        self.addCleanup(self._restore_http)

    def _restore_http(self):
        stripe.default_http_client = self._previous_http

    def make_appointment(self, price="100.00", **fields):
        values = {
            "deposit_status": "required",
            "deposit_amount": Decimal("30.00"),
        }
        values.update(fields)
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + timezone.timedelta(days=2), **values,
        )
        AppointmentService.objects.create(
            appointment=appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal(price),
        )
        return appointment

    def fake(self, routes):
        stripe.default_http_client = FakeStripeHTTP(routes)
        return stripe.default_http_client

    def metadata(self, appointment=None, **extra):
        appointment = appointment or self.appointment
        return {
            "appointment_id": str(appointment.id),
            "salon_id": str(self.salon.id),
            "kind": "deposit",
            **extra,
        }

    def post_event(self, payload: str, secret: str = "whsec_platform"):
        return self.client.post(
            WEBHOOK_URL, data=payload, content_type="application/json",
            HTTP_STRIPE_SIGNATURE=sign(payload, secret),
        )

    def checkout_body(self, price="100.00", payments=None):
        return json.dumps({
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": price},
            ]}],
            "payments": payments if payments is not None else [],
        })


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


@override_settings(STRIPE_SECRET_KEY="sk_test_x")
class WebhookSecretsTests(StripeTestBase):
    """05-02: l'endpoint della piattaforma e quello Connect firmano con segreti diversi."""

    def _paid_event(self, **kw):
        return event_payload("payment_intent.succeeded", {
            "id": "pi_1", "object": "payment_intent", "amount": 3000, "amount_received": 3000,
            "metadata": self.metadata(),
        }, **kw)

    @override_settings(STRIPE_WEBHOOK_SECRET="whsec_platform", STRIPE_CONNECT_WEBHOOK_SECRET="whsec_connect")
    def test_an_event_signed_by_the_connect_endpoint_is_accepted(self):
        from apps.core.models import SalonSettings

        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"stripe_account_id": "acct_salon"})
        res = self.post_event(self._paid_event(account="acct_salon"), secret="whsec_connect")
        self.assertEqual(res.status_code, 200, res.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")

    @override_settings(STRIPE_WEBHOOK_SECRET="whsec_platform", STRIPE_CONNECT_WEBHOOK_SECRET="whsec_connect")
    def test_the_platform_secret_keeps_working(self):
        self.assertEqual(self.post_event(self._paid_event(), secret="whsec_platform").status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")

    @override_settings(STRIPE_WEBHOOK_SECRET="", STRIPE_WEBHOOK_SECRETS=["whsec_old", "whsec_new"])
    def test_a_list_of_secrets_is_accepted_and_anything_else_refused(self):
        self.assertEqual(self.post_event(self._paid_event(), secret="whsec_other").status_code, 400)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "required")
        self.assertEqual(self.post_event(self._paid_event(), secret="whsec_new").status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")

    @override_settings(STRIPE_WEBHOOK_SECRET="", STRIPE_CONNECT_WEBHOOK_SECRET="", STRIPE_WEBHOOK_SECRETS=[])
    def test_without_any_secret_the_webhook_is_refused(self):
        self.assertEqual(self.post_event(self._paid_event(), secret="whsec_x").status_code, 503)


class ClientAppOriginTests(TestCase):
    """11-19: senza CLIENT_APP_ORIGIN la cliente torna su FRONTEND_ORIGIN, non su localhost."""

    def test_the_default_falls_back_to_the_dashboard_origin(self):
        import config.settings as settings_module

        from ..stripe_service import _deposit_return_urls

        env = {k: v for k, v in os.environ.items() if k != "CLIENT_APP_ORIGIN"}
        with patch.dict(os.environ, env, clear=True):
            default = importlib.reload(settings_module).CLIENT_APP_ORIGIN
        importlib.reload(settings_module)  # ripristina il modulo com'era
        self.assertEqual(default, "")

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        client = Client.objects.create(salon=salon, first_name="Sofia", last_name="Ricci", phone="+393331112222")
        operator = Operator.objects.create(salon=salon, first_name="Giulia", last_name="Bianchi")
        appointment = Appointment.objects.create(
            salon=salon, client=client, operator=operator, start=timezone.now() + timezone.timedelta(days=1),
        )
        with override_settings(CLIENT_APP_ORIGIN=default, FRONTEND_ORIGIN="https://beauty.example.com"):
            success, cancel = _deposit_return_urls(appointment)
        self.assertTrue(success.startswith("https://beauty.example.com/the-parlour?deposit=paid"))
        self.assertTrue(cancel.startswith("https://beauty.example.com/the-parlour?deposit=cancelled"))
