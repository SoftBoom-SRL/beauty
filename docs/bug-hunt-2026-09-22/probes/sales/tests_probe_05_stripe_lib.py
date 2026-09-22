"""PROBE TEMPORANEO revisore 05: libreria stripe REALE (15.6.1), solo l'HTTP è finto."""

import hashlib
import hmac
import json
import time
from decimal import Decimal

import stripe
from django.test import TestCase, override_settings
from django.utils import timezone
from stripe import _http_client

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.staff.models import Operator


class FakeHTTP(_http_client.HTTPClient):
    """Risponde come l'API Stripe, senza rete."""

    name = "fake"

    def __init__(self, routes):
        super().__init__()
        self.routes = routes
        self.calls = []

    def request(self, method, url, headers, post_data=None, *, _usage=None):
        self.calls.append((method, url))
        for fragment, body in self.routes.items():
            if fragment in url:
                return json.dumps(body), 200, {}
        return json.dumps({"error": {"message": "not found"}}), 404, {}

    def close(self):
        pass


class Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        op = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        svc = Service.objects.create(salon=self.salon, category=cat, name_it="Colore",
                                     duration_min=60, price=Decimal("100.00"))
        self.appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=op,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="required", deposit_amount=Decimal("30.00"),
        )
        AppointmentService.objects.create(appointment=self.appt, service=svc, operator=op,
                                          duration_min=60, price=Decimal("100.00"))
        self._old = stripe.default_http_client

    def tearDown(self):
        stripe.default_http_client = self._old

    def fake(self, routes):
        stripe.default_http_client = FakeHTTP(routes)
        return stripe.default_http_client


@override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_test")
class RealLibProbe(Base):
    def test_deposit_link_creation(self):
        from apps.sales import stripe_service

        http = self.fake({"/v1/checkout/sessions": {
            "id": "cs_test_1", "object": "checkout.session", "url": "https://checkout.stripe.com/c/pay/cs_test_1"}})
        try:
            url = stripe_service.ensure_deposit_link(self.appt)
            print("\nPROBE link OK:", url)
        except Exception as exc:  # noqa: BLE001
            print("\nPROBE link creation:", type(exc).__name__, exc, "| http calls:", http.calls)
            raise

    def test_webhook_signed_event(self):
        payload = json.dumps({
            "id": "evt_1", "object": "event", "type": "payment_intent.succeeded",
            "data": {"object": {"id": "pi_1", "object": "payment_intent", "amount": 3000,
                                "amount_received": 3000,
                                "metadata": {"appointment_id": str(self.appt.id),
                                             "salon_id": str(self.salon.id), "kind": "deposit"}}},
        })
        ts = int(time.time())
        sig = hmac.new(b"whsec_test", f"{ts}.{payload}".encode(), hashlib.sha256).hexdigest()
        self.client.raise_request_exception = False
        r = self.client.post("/api/sales/stripe/webhook", data=payload, content_type="application/json",
                             HTTP_STRIPE_SIGNATURE=f"t={ts},v1={sig}")
        self.appt.refresh_from_db()
        print("\nPROBE webhook status:", r.status_code, "deposit:", self.appt.deposit_status)

    def test_connect_exchange(self):
        from apps.sales import stripe_service

        self.fake({"/oauth/token": {"access_token": "sk_x", "stripe_user_id": "acct_123",
                                    "livemode": False, "token_type": "bearer", "scope": "read_write"}})
        with override_settings(STRIPE_CONNECT_CLIENT_ID="ca_x"):
            from django.core import signing
            state = signing.dumps({"salon": self.salon.id}, salt="youty.stripe-connect")
            try:
                acct = stripe_service.connect_exchange(self.salon, "ac_code", state)
                print("\nPROBE connect OK:", acct)
            except Exception as exc:  # noqa: BLE001
                print("\nPROBE connect exchange:", type(exc).__name__, exc)
                raise

    def test_refund_on_cancel(self):
        from apps.agenda.services import cancel_appointment

        self.appt.deposit_status = "paid"
        self.appt.deposit_payment_intent_id = "pi_1"
        self.appt.save()
        http = self.fake({"/v1/refunds": {"id": "re_1", "object": "refund", "amount": 3000,
                                          "status": "succeeded", "payment_intent": "pi_1"}})
        try:
            cancel_appointment(self.appt, reason="", by_client=False)
        except Exception as exc:  # noqa: BLE001
            self.appt.refresh_from_db()
            print("\nPROBE cancel refund:", type(exc).__name__, exc, "| status", self.appt.status,
                  self.appt.deposit_status, "| http", http.calls)
            raise
