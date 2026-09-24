"""Basi e aiuti condivisi dai moduli di test delle vendite.

Qui non vanno test: il runner raccoglie solo i file `test*.py`, e una classe
con dei test importata in un altro modulo verrebbe eseguita due volte.
"""

import datetime as dt
import hashlib
import hmac
import json
import time
from decimal import Decimal
from urllib.parse import parse_qs

import stripe
from django.test import TestCase
from django.utils import timezone
from stripe import _http_client

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.staff.models import Operator
from common.auth import create_staff_tokens

PATCH_DEDUCT = "apps.inventory.services.deduct_stock_for_sale"
PATCH_LOYALTY = "apps.marketing.services.accrue_loyalty"
PATCH_REDEEM = "apps.marketing.gift_cards.redeem_gift_card"
PATCH_CREATE_GC = "apps.marketing.gift_cards.create_gift_card"

WEBHOOK_URL = "/api/sales/stripe/webhook"


def _blocks(lines, operator_id=None):
    return [{"operator_id": operator_id, "lines": lines}]


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


def _refund(refund_id, amount, intent, status="succeeded"):
    return {"id": refund_id, "object": "refund", "amount": amount, "status": status, "payment_intent": intent}


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
