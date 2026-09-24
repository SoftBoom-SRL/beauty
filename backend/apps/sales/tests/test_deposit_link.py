"""Caccia del 22/09 — vita del link caparra, account Stripe e pagamenti anomali.

05-12 (account della caparra), 05-10 (durata del link), 05-11 (scadenza senza
link), 02-06/05-07 (link vecchio dopo la riduzione, pagamento in eccesso),
02-07/03-02/05-08/18-01 (pagamento di un appuntamento che non c'è più).
Libreria stripe vera, finto solo l'HTTP (vedi tests_caccia22_stripe).
"""

import datetime as dt
import json
import time
from decimal import Decimal
from unittest.mock import patch

from django.test import override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.agenda.models import Appointment
from apps.core.models import ActivityLog, DepositRule, OutboxEvent, SalonSettings
from common.auth import create_client_tokens

from ..models import Sale
from .test_stripe_library import StripeTestBase, event_payload


def _session(session_id, *, expires_in=3600, **extra):
    return {
        "id": session_id,
        "object": "checkout.session",
        "url": f"https://checkout.stripe.com/c/pay/{session_id}",
        "status": "open",
        "expires_at": int(time.time()) + expires_in,
        **extra,
    }


def _refund(refund_id, amount, intent, status="succeeded"):
    return {"id": refund_id, "object": "refund", "amount": amount, "status": status, "payment_intent": intent}


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
