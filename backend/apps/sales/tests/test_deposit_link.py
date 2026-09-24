"""Link caparra (Checkout Stripe), Stripe Connect del titolare e vita del link.

Caccia del 22/09 — vita del link caparra e account Stripe: 05-12 (account della
caparra), 05-10 (durata del link), 05-11 (scadenza senza link), 02-06/05-07
(link vecchio dopo la riduzione, pagamento in eccesso), 11-19 (ritorno della
cliente senza CLIENT_APP_ORIGIN). Libreria stripe vera, finto solo l'HTTP
(vedi tests_caccia22_stripe).
"""

import datetime as dt
import importlib
import json
import os
import time
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.agenda.models import Appointment
from apps.clients.models import Client
from apps.core.models import ActivityLog, DepositRule, OutboxEvent, Salon, SalonSettings
from apps.staff.models import Operator
from common.auth import create_client_tokens, create_staff_tokens

from ..models import Sale
from .base import StripeTestBase, _refund, event_payload


def _session(session_id, *, expires_in=3600, **extra):
    return {
        "id": session_id,
        "object": "checkout.session",
        "url": f"https://checkout.stripe.com/c/pay/{session_id}",
        "status": "open",
        "expires_at": int(time.time()) + expires_in,
        **extra,
    }


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
        from .. import stripe_service

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
        from .. import stripe_service

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
        from ..models import Payment, Sale, SaleLine
        from ..services import today_summary

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


@override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_platform")
class DepositAccountTests(StripeTestBase):
    """05-12: rimborsi e chiusure vanno sull'account dove la caparra vive."""

    def _connect(self, account):
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"stripe_account_id": account})
        self.salon.refresh_from_db()

    def _pay(self, account=""):
        from .. import stripe_service

        metadata = self.metadata(acct=stripe_service.account_token(self.salon))
        payload = event_payload("payment_intent.succeeded", {
            "id": "pi_dep", "object": "payment_intent", "amount": 3000, "amount_received": 3000,
            "metadata": metadata,
        }, account=account)
        self.assertEqual(self.post_event(payload).status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")

    def _cancel(self):
        from apps.agenda.services import cancel_appointment

        appointment = Appointment.objects.select_related("salon", "salon__settings", "client").get(
            pk=self.appointment.pk
        )
        cancel_appointment(appointment, reason="", by_client=False)
        self.appointment.refresh_from_db()

    def test_a_deposit_paid_on_the_platform_is_refunded_there_after_connecting(self):
        self._pay(account="")
        self.assertEqual(self.appointment.deposit_stripe_account, "")
        self._connect("acct_new")
        http = self.fake([("POST", "/v1/refunds", _refund("re_1", 3000, "pi_dep"))])
        self._cancel()
        refund = http.calls_to("/v1/refunds")[0]
        self.assertNotIn("Stripe-Account", refund["headers"])
        self.assertEqual(self.appointment.deposit_status, "refunded")

    def test_a_deposit_paid_on_the_connected_account_is_refunded_there_after_disconnecting(self):
        self._connect("acct_salon")
        self._pay(account="acct_salon")
        self.assertEqual(self.appointment.deposit_stripe_account, "acct_salon")
        self._connect("")
        http = self.fake([("POST", "/v1/refunds", _refund("re_1", 3000, "pi_dep"))])
        self._cancel()
        self.assertEqual(http.calls_to("/v1/refunds")[0]["headers"].get("Stripe-Account"), "acct_salon")
        self.assertEqual(self.appointment.deposit_status, "refunded")

    def test_the_old_link_is_closed_on_the_account_it_was_created_on(self):
        from .. import stripe_service

        sessions = iter([_session("cs_platform"), _session("cs_connected")])
        http = self.fake([
            ("POST", "/v1/checkout/sessions/cs_platform/expire", {"id": "cs_platform", "object": "checkout.session"}),
            ("POST", "/v1/checkout/sessions", lambda url, data: next(sessions)),
        ])
        stripe_service.ensure_deposit_link(self.appointment)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_stripe_account, "")
        self._connect("acct_new")
        appointment = Appointment.objects.select_related("salon", "salon__settings", "client").get(
            pk=self.appointment.pk
        )
        stripe_service.ensure_deposit_link(appointment, resend=True)
        expire = http.calls_to("/v1/checkout/sessions/cs_platform/expire")
        self.assertEqual(len(expire), 1)
        self.assertNotIn("Stripe-Account", expire[0]["headers"])
        created = [c for c in http.calls_to("/v1/checkout/sessions") if c["url"].endswith("/v1/checkout/sessions")]
        self.assertEqual(created[-1]["headers"].get("Stripe-Account"), "acct_new")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_stripe_account, "acct_new")
        self.assertEqual(appointment.deposit_checkout_session_id, "cs_connected")


@override_settings(STRIPE_SECRET_KEY="sk_test_x")
class LinkLifetimeTests(StripeTestBase):
    """05-10: la sessione del link muore (24 ore al massimo): si rifà, non si rimanda."""

    def _client_link(self):
        token = create_client_tokens(self.client_obj)["access"]
        return self.client.post(
            f"/api/sales/client/appointments/{self.appointment.id}/deposit-link", data="{}",
            content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {token}",
        )

    def _with_link(self, *, expires_at):
        Appointment.objects.filter(pk=self.appointment.pk).update(
            deposit_payment_link="https://checkout.stripe.com/c/pay/cs_old",
            deposit_checkout_session_id="cs_old",
            deposit_link_expires_at=expires_at,
            deposit_stripe_account="",
        )
        self.appointment.refresh_from_db()

    def test_the_session_expiry_is_stored_with_the_link(self):
        from .. import stripe_service

        session = _session("cs_1", expires_in=7200)
        self.fake([("POST", "/v1/checkout/sessions", session)])
        stripe_service.ensure_deposit_link(self.appointment)
        self.appointment.refresh_from_db()
        self.assertEqual(int(self.appointment.deposit_link_expires_at.timestamp()), session["expires_at"])

    def test_the_client_gets_a_new_link_when_the_session_has_expired(self):
        self._with_link(expires_at=timezone.now() - dt.timedelta(hours=1))
        http = self.fake([
            ("GET", "/v1/checkout/sessions/cs_old", _session("cs_old", expires_in=-3600, status="expired")),
            ("POST", "/v1/checkout/sessions/cs_old/expire", {"id": "cs_old", "object": "checkout.session"}),
            ("POST", "/v1/checkout/sessions", _session("cs_new")),
        ])
        res = self._client_link()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_new")
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_checkout_session_id, "cs_new")
        self.assertEqual(len(http.calls_to("/v1/checkout/sessions/cs_old/expire")), 1)

    def test_a_link_still_open_is_given_back_without_calling_stripe(self):
        self._with_link(expires_at=timezone.now() + dt.timedelta(hours=2))
        http = self.fake([])
        res = self._client_link()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_old")
        self.assertEqual(http.calls, [])

    def test_a_session_already_paid_is_not_replaced(self):
        # Il pagamento c'è, il webhook non è ancora arrivato: un link nuovo
        # farebbe pagare la caparra due volte.
        self._with_link(expires_at=timezone.now() - dt.timedelta(minutes=5))
        http = self.fake([
            ("GET", "/v1/checkout/sessions/cs_old", _session("cs_old", status="complete")),
        ])
        res = self._client_link()
        self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_old")
        self.assertEqual(http.calls_to("/v1/checkout/sessions"), [])

    def test_a_link_from_before_is_checked_on_stripe(self):
        self._with_link(expires_at=None)
        self.fake([("GET", "/v1/checkout/sessions/cs_old", _session("cs_old", expires_in=5 * 3600))])
        res = self._client_link()
        self.assertEqual(res.json()["url"], "https://checkout.stripe.com/c/pay/cs_old")
        self.appointment.refresh_from_db()
        self.assertIsNotNone(self.appointment.deposit_link_expires_at)

    def test_the_reminder_carries_a_link_that_still_works(self):
        from apps.agenda.services import process_deposit_holds

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"deposit_hold_minutes": 60, "deposit_reminder_minutes": 10}
        )
        self.salon.refresh_from_db()
        self._with_link(expires_at=timezone.now() - dt.timedelta(minutes=1))
        # sollecito dovuto adesso: 10' dopo una prenotazione con 60' di termine
        due = timezone.now() + dt.timedelta(minutes=50)
        Appointment.objects.filter(pk=self.appointment.pk).update(
            deposit_due_at=due, deposit_hold_until=due,
        )
        self.fake([
            ("GET", "/v1/checkout/sessions/cs_old", _session("cs_old", expires_in=-60, status="expired")),
            ("POST", "/v1/checkout/sessions/cs_old/expire", {"id": "cs_old", "object": "checkout.session"}),
            ("POST", "/v1/checkout/sessions", _session("cs_new")),
        ])
        result = process_deposit_holds(self.salon, now=timezone.now() + dt.timedelta(seconds=5))
        self.assertEqual(result["reminded"], 1)
        reminder = OutboxEvent.objects.get(event_type="deposit.reminder")
        self.assertEqual(reminder.payload["deposit_payment_link"], "https://checkout.stripe.com/c/pay/cs_new")
        self.assertEqual(reminder.coalesce_key, f"appointment:{self.appointment.id}")

    def test_no_link_for_a_released_appointment(self):
        Appointment.objects.filter(pk=self.appointment.pk).update(status="cancelled", auto_released=True)
        http = self.fake([("POST", "/v1/checkout/sessions", _session("cs_x"))])
        res = self._client_link()
        self.assertEqual(res.status_code, 400)
        self.assertEqual(http.calls, [])


@override_settings(STRIPE_SECRET_KEY="sk_test_x")
class HoldWithoutLinkTests(StripeTestBase):
    """05-11: senza un link pagabile la caparra non ha scadenza e lo slot non si libera."""

    def _book_via_api(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"deposit_hold_minutes": 20})
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", active=True, conditions={},
            amount_type="fixed", amount=Decimal("20.00"),
        )
        self.client_obj.deposit_always = True
        self.client_obj.save()
        self.service.operators.add(self.operator)
        user = User.objects.create_user(email="agenda@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Agenda", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        start = (timezone.now() + dt.timedelta(days=3)).replace(hour=10, minute=0, second=0, microsecond=0)
        res = self.client.post("/api/agenda/appointments", json.dumps({
            "client_id": self.client_obj.id,
            "items": [{"service_id": self.service.id, "operator_id": self.operator.id}],
            "start": start.isoformat(), "force": True,
        }), content_type="application/json", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        return Appointment.objects.get(pk=res.json()["id"])

    def test_a_link_that_cannot_be_created_leaves_no_deadline(self):
        from apps.agenda.services import process_deposit_holds

        self.fake([("POST", "/v1/checkout/sessions", ({
            "error": {"message": "Your account cannot currently make live charges.", "type": "invalid_request_error"},
        }, 400))])
        appointment = self._book_via_api()
        self.assertEqual(appointment.deposit_status, "required")
        self.assertEqual(appointment.deposit_payment_link, "")
        self.assertIsNone(appointment.deposit_due_at)
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.link_failed")
        self.assertTrue(log.payload["hold_suspended"])
        result = process_deposit_holds(self.salon, now=timezone.now() + dt.timedelta(minutes=21))
        self.assertEqual(result["released"], 0)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, "confirmed")
        self.assertFalse(OutboxEvent.objects.filter(event_type="appointment.released_unpaid").exists())

    def test_a_failed_reminder_keeps_the_deadline_while_the_old_link_works(self):
        from .. import stripe_service

        due = timezone.now() + dt.timedelta(minutes=40)
        Appointment.objects.filter(pk=self.appointment.pk).update(
            deposit_due_at=due,
            deposit_payment_link="https://checkout.stripe.com/c/pay/cs_old",
            deposit_checkout_session_id="cs_old",
            deposit_link_expires_at=timezone.now() + dt.timedelta(hours=1),
            deposit_stripe_account="",
        )
        self.appointment.refresh_from_db()
        http = self.fake([("POST", "/v1/checkout/sessions", ({"error": {"message": "boom"}}, 500))])
        with self.assertRaises(HttpError):
            stripe_service.ensure_deposit_link(self.appointment, resend=True)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_due_at, due)
        self.assertEqual(self.appointment.deposit_payment_link, "https://checkout.stripe.com/c/pay/cs_old")
        # il link vecchio resta aperto: non è stato chiuso prima di averne uno nuovo
        self.assertEqual(http.calls_to("/v1/checkout/sessions/cs_old/expire"), [])


@override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_platform")
class AmountChangeTests(StripeTestBase):
    """02-06, 05-07: caparra ridotta → link nuovo; pagamento del link vecchio → eccedenza restituita."""

    def _two_services(self, **fields):
        from apps.agenda.models import AppointmentService
        from apps.catalog.models import Service

        extra = Service.objects.create(
            salon=self.salon, category=self.service.category, name_it="Piega", duration_min=30,
            price=Decimal("20.00"),
        )
        extra.operators.add(self.operator)
        self.service.operators.add(self.operator)
        appointment = self.make_appointment(**fields)
        AppointmentService.objects.create(
            appointment=appointment, service=extra, operator=self.operator,
            duration_min=30, price=Decimal("20.00"), order=1,
        )
        return appointment, extra

    def test_reducing_a_required_deposit_replaces_the_link(self):
        from apps.agenda.services import edit_appointment

        appointment, extra = self._two_services(
            deposit_amount=Decimal("70.00"),
            deposit_payment_link="https://checkout.stripe.com/c/pay/cs_old",
            deposit_checkout_session_id="cs_old",
            deposit_link_expires_at=timezone.now() + dt.timedelta(hours=3),
            deposit_stripe_account="",
        )
        piega = appointment.items.get(service=extra)
        http = self.fake([
            ("POST", "/v1/checkout/sessions/cs_old/expire", {"id": "cs_old", "object": "checkout.session"}),
            ("POST", "/v1/checkout/sessions", _session("cs_new")),
        ])
        with patch("apps.staff.services.shift_windows", return_value=[(0, 24 * 60)]):
            with self.captureOnCommitCallbacks(execute=True):
                edit_appointment(
                    appointment,
                    items=[{"id": piega.id, "service_id": extra.id, "operator_id": self.operator.id}],
                    force=True,
                )
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_amount, Decimal("20.00"))
        self.assertEqual(appointment.deposit_checkout_session_id, "cs_new")
        self.assertEqual(len(http.calls_to("/v1/checkout/sessions/cs_old/expire")), 1)
        created = [c for c in http.calls if c["url"].endswith("/v1/checkout/sessions")]
        self.assertEqual(created[0]["data"]["line_items[0][price_data][unit_amount]"], "2000")
        event = OutboxEvent.objects.filter(event_type="deposit.payment_link").latest("id")
        self.assertEqual(event.payload["reason"], "amount_changed")
        self.assertEqual(event.payload["amount"], "20.00")

    def test_undoing_the_reduction_brings_back_a_link_for_the_restored_amount(self):
        """Revisione finale: «Indietro» rimetteva la caparra a 70 € con il link da 20."""
        from apps.agenda import undo
        from apps.agenda.models import UndoEntry
        from apps.agenda.services import edit_appointment

        appointment, extra = self._two_services(
            deposit_amount=Decimal("70.00"),
            deposit_payment_link="https://checkout.stripe.com/c/pay/cs_old",
            deposit_checkout_session_id="cs_old",
            deposit_link_expires_at=timezone.now() + dt.timedelta(hours=3),
            deposit_stripe_account="",
        )
        piega = appointment.items.get(service=extra)
        self.fake([
            ("POST", "/v1/checkout/sessions/cs_old/expire", {"id": "cs_old", "object": "checkout.session"}),
            ("POST", "/v1/checkout/sessions", _session("cs_new")),
        ])
        with patch("apps.staff.services.shift_windows", return_value=[(0, 24 * 60)]):
            with self.captureOnCommitCallbacks(execute=True):
                edit_appointment(
                    appointment,
                    items=[{"id": piega.id, "service_id": extra.id, "operator_id": self.operator.id}],
                    force=True, actor=self.user,
                )
        appointment.refresh_from_db()
        self.assertEqual((appointment.deposit_amount, appointment.deposit_checkout_session_id),
                         (Decimal("20.00"), "cs_new"))
        http = self.fake([
            ("POST", "/v1/checkout/sessions/cs_new/expire", {"id": "cs_new", "object": "checkout.session"}),
            ("POST", "/v1/checkout/sessions", _session("cs_back")),
        ])
        entry = UndoEntry.objects.filter(salon=self.salon, kind=UndoEntry.Kind.EDIT).latest("id")
        with patch("apps.staff.services.shift_windows", return_value=[(0, 24 * 60)]):
            with self.captureOnCommitCallbacks(execute=True):
                undo.perform(entry, actor=self.user)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_amount, Decimal("70.00"))
        # la cliente riceve un link da 70, e quello da 20 si chiude su Stripe
        self.assertEqual(appointment.deposit_checkout_session_id, "cs_back")
        created = [c for c in http.calls if c["url"].endswith("/v1/checkout/sessions")]
        self.assertEqual(created[0]["data"]["line_items[0][price_data][unit_amount]"], "7000")
        self.assertEqual(len(http.calls_to("/v1/checkout/sessions/cs_new/expire")), 1)
        # il messaggio col link da 20 ancora in coda non parte più
        alive = OutboxEvent.objects.filter(event_type="deposit.payment_link").exclude(
            status=OutboxEvent.Status.SUPERSEDED
        )
        self.assertEqual([e.payload["amount"] for e in alive], ["70.00"])

    def test_paying_the_old_amount_gives_the_excess_back(self):
        # link da 30 partito, caparra scesa a 20: la cliente paga 30
        self.fake([("POST", "/v1/refunds", _refund("re_over", 1000, "pi_old"))])
        Appointment.objects.filter(pk=self.appointment.pk).update(deposit_amount=Decimal("20.00"))
        payload = event_payload("payment_intent.succeeded", {
            "id": "pi_old", "object": "payment_intent", "amount": 3000, "amount_received": 3000,
            "metadata": self.metadata(),
        })
        self.assertEqual(self.post_event(payload).status_code, 200)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        # vendita-caparra e rimborso rendono conto dei 30 arrivati
        self.assertEqual(Sale.objects.get(deposit_appointment=self.appointment).total, Decimal("30.00"))
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("10.00"))
        self.assertEqual(self.appointment.deposit_credit, Decimal("20.00"))
        self.assertTrue(ActivityLog.objects.filter(salon=self.salon, type="deposit.overpaid").exists())

    def test_an_excess_that_cannot_be_refunded_is_written_down_and_stays_deductible(self):
        self.fake([("POST", "/v1/refunds", ({"error": {"message": "balance insufficient"}}, 400))])
        Appointment.objects.filter(pk=self.appointment.pk).update(deposit_amount=Decimal("20.00"))
        payload = event_payload("payment_intent.succeeded", {
            "id": "pi_old", "object": "payment_intent", "amount": 3000, "amount_received": 3000,
            "metadata": self.metadata(),
        })
        self.assertEqual(self.post_event(payload).status_code, 200)
        self.appointment.refresh_from_db()
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.overpaid")
        self.assertIn("a mano", log.summary)
        # nessuno perde i 10: restano detraibili al conto
        self.assertEqual(self.appointment.deposit_credit, Decimal("30.00"))


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
