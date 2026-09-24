"""Webhook Stripe: firma e segreti, `metadata.kind`, importo, pagamenti doppi o senza appuntamento.

Caccia del 22/09: 05-02 (l'endpoint della piattaforma e quello Connect firmano
con segreti diversi), 02-07/03-02/05-08/18-01 (pagamento di un appuntamento
che non c'è più).
"""

from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings

from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon

from ..models import Sale
from .base import StripeTestBase, _refund, event_payload


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

        from .. import stripe_service

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

        from ..api import _payment_intent_succeeded

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


@override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_platform")
class OrphanPaymentTests(StripeTestBase):
    """Pagamento di un appuntamento cancellato («Torna indietro»): rimborso e traccia."""

    def _ghost_event(self, event_type="payment_intent.succeeded", *, account="", event_id="evt_1"):
        metadata = {"appointment_id": "999999", "salon_id": str(self.salon.id), "kind": "deposit"}
        if event_type == "payment_intent.succeeded":
            obj = {"id": "pi_ghost", "object": "payment_intent", "amount": 2000, "amount_received": 2000,
                   "metadata": metadata}
        else:
            obj = {"id": "cs_ghost", "object": "checkout.session", "payment_status": "paid",
                   "payment_intent": "pi_ghost", "amount_total": 2000, "metadata": metadata}
        return event_payload(event_type, obj, account=account, event_id=event_id)

    def test_the_payment_is_refunded_and_written_down(self):
        http = self.fake([("POST", "/v1/refunds", _refund("re_ghost", 2000, "pi_ghost"))])
        self.assertEqual(self.post_event(self._ghost_event()).status_code, 200)
        self.assertEqual(http.calls_to("/v1/refunds")[0]["data"]["payment_intent"], "pi_ghost")
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.orphan_payment")
        self.assertEqual(log.payload["refund_id"], "re_ghost")
        self.assertEqual(log.payload["appointment_id"], "999999")
        self.assertEqual(Sale.objects.count(), 0)

    def test_intent_and_session_events_refund_and_log_once(self):
        http = self.fake([("POST", "/v1/refunds", _refund("re_ghost", 2000, "pi_ghost"))])
        self.post_event(self._ghost_event())
        self.post_event(self._ghost_event("checkout.session.completed", event_id="evt_2"))
        self.assertEqual(len(http.calls_to("/v1/refunds")), 1)
        self.assertEqual(ActivityLog.objects.filter(type="deposit.orphan_payment").count(), 1)

    def test_an_event_from_a_foreign_account_is_left_alone(self):
        http = self.fake([("POST", "/v1/refunds", _refund("re_ghost", 2000, "pi_ghost"))])
        self.assertEqual(self.post_event(self._ghost_event(account="acct_estraneo")).status_code, 200)
        self.assertEqual(http.calls_to("/v1/refunds"), [])
        self.assertFalse(ActivityLog.objects.filter(type="deposit.orphan_payment").exists())


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
