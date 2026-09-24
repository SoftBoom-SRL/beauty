"""Caccia del 22/09 — ordine dei lock (05-20, 18-08) e Customer Stripe unico (18-11).

Su SQLite i lock sono un no-op: qui si verifica l'ORDINE in cui cassa, webhook,
rimborsi e rilascio li chiedono, che su PostgreSQL decide fra attesa e deadlock.
Tutti prendono il salone (`lock_salon`) prima della riga dell'appuntamento.
"""

import datetime as dt
from unittest.mock import patch

from django.db.models.query import QuerySet
from django.test import override_settings
from django.utils import timezone

from apps.agenda.models import Appointment
from apps.clients.models import Client
from apps.core.models import SalonSettings

from .base import StripeTestBase, event_payload

_real_select_for_update = QuerySet.select_for_update


class LockOrderTests(StripeTestBase):
    def _spy(self):
        order = []

        def lock_salon(salon):
            order.append(("salon", salon.pk))

        def select_for_update(queryset, *args, **kwargs):
            order.append(("row", queryset.model.__name__, kwargs.get("of")))
            return _real_select_for_update(queryset, *args, **kwargs)

        patches = [
            patch("apps.agenda.services.lock_salon", side_effect=lock_salon),
            patch.object(QuerySet, "select_for_update", select_for_update),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return order

    def assertSalonFirst(self, order):
        rows = [i for i, entry in enumerate(order) if entry[0] == "row" and entry[1] == "Appointment"]
        salons = [i for i, entry in enumerate(order) if entry[0] == "salon"]
        self.assertTrue(rows, order)
        self.assertTrue(salons, order)
        self.assertLess(salons[0], rows[0], order)

    def test_the_checkout_locks_the_salon_before_the_appointment(self):
        order = self._spy()
        res = self.client.post(
            f"/api/sales/checkout/{self.appointment.id}",
            data=self.checkout_body("100.00", [{"method": "cash", "amount": "100.00"}]),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertSalonFirst(order)

    def test_the_deposit_webhook_locks_the_salon_before_the_appointment(self):
        from ..api import _payment_intent_succeeded

        order = self._spy()
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata())
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertSalonFirst(order)

    def test_a_refund_locks_the_salon_before_the_appointment(self):
        from apps.agenda.services import record_deposit_refund

        Appointment.objects.filter(pk=self.appointment.pk).update(deposit_status="paid")
        order = self._spy()
        record_deposit_refund(self.appointment, refund_id="re_1", cents=1000, status="succeeded")
        self.assertSalonFirst(order)

    def test_the_manual_refund_rereads_under_lock(self):
        from apps.agenda.services import mark_deposit_refunded

        stale = Appointment.objects.get(pk=self.appointment.pk)
        Appointment.objects.filter(pk=self.appointment.pk).update(deposit_status="refund_due")
        order = self._spy()
        # la copia letta prima dice ancora «richiesta»: sotto lock si rilegge
        mark_deposit_refunded(stale)
        self.assertSalonFirst(order)
        stale.refresh_from_db()
        self.assertEqual(stale.deposit_status, "refunded")

    @override_settings(STRIPE_SECRET_KEY="sk_test_x")
    def test_the_release_locks_the_salon_and_then_only_the_appointment_row(self):
        from apps.agenda.services import process_deposit_holds

        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"deposit_hold_minutes": 30})
        self.salon.refresh_from_db()
        due = timezone.now() + dt.timedelta(minutes=30)
        Appointment.objects.filter(pk=self.appointment.pk).update(deposit_due_at=due, deposit_hold_until=due)
        order = self._spy()
        result = process_deposit_holds(self.salon, now=due + dt.timedelta(minutes=1))
        self.assertEqual(result["released"], 1)
        self.assertSalonFirst(order)
        row = next(entry for entry in order if entry[0] == "row" and entry[1] == "Appointment")
        self.assertEqual(row[2], ("self",))


@override_settings(STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_platform")
class OneStripeCustomerTests(StripeTestBase):
    """18-11: due richieste insieme non creano due Customer, e la carta resta col suo."""

    def test_a_second_request_finds_the_customer_already_created(self):
        from .. import stripe_service

        customers = iter([{"id": "cus_A", "object": "customer"}, {"id": "cus_B", "object": "customer"}])
        http = self.fake([("POST", "/v1/customers", lambda url, data: next(customers))])
        first = Client.objects.get(pk=self.client_obj.pk)
        second = Client.objects.get(pk=self.client_obj.pk)  # l'altra richiesta, letta prima
        self.assertEqual(stripe_service.ensure_customer(first), "cus_A")
        self.assertEqual(stripe_service.ensure_customer(second), "cus_A")
        self.assertEqual(len(http.calls_to("/v1/customers")), 1)
        self.client_obj.refresh_from_db()
        self.assertEqual(self.client_obj.stripe_customer_id, "cus_A")

    def test_the_saved_card_keeps_its_own_customer(self):
        self.client_obj.stripe_customer_id = "cus_A"
        self.client_obj.save()
        payload = event_payload("setup_intent.succeeded", {
            "id": "seti_1", "object": "setup_intent", "customer": "cus_B", "payment_method": "pm_1",
            "metadata": {"client_id": str(self.client_obj.id), "salon_id": str(self.salon.id)},
        })
        self.assertEqual(self.post_event(payload).status_code, 200)
        self.client_obj.refresh_from_db()
        self.assertEqual(self.client_obj.stripe_payment_method_id, "pm_1")
        self.assertEqual(self.client_obj.stripe_customer_id, "cus_B")
