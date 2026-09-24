"""Caccia del 22/09 — caparra lato agenda: riduzioni, scadenze, rimborsi."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone

from apps.core.models import ActivityLog

from ..models import Appointment
from ..services import create_appointment
from .test_agenda_legacy import AgendaTestBase, _aware


class PaidDepositOnAShorterVisitTests(AgendaTestBase):
    """02-01, 05-06: ridurre la visita non fa perdere quello che la cliente ha versato."""

    def _paid_visit(self, deposit):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=deposit,
            deposit_payment_intent_id="pi_dep",
        )
        appointment.refresh_from_db()
        return appointment

    def _split_first(self, appointment):
        from ..services import split_appointment

        first = appointment.items.order_by("order").first()  # il servizio da 50
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, _created = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        return original

    def test_the_checkout_still_sees_the_whole_excess(self):
        original = self._split_first(self._paid_visit(Decimal("70.00")))  # visita ora da 30
        self.assertEqual(original.deposit_amount, Decimal("70.00"))
        self.assertEqual(original.deposit_credit, Decimal("70.00"))
        # al conto si detraggono 30, i 40 in più tornano alla cliente
        self.assertEqual(original.deposit_credit - min(original.deposit_credit, original.total_price), Decimal("40.00"))
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.excess")
        self.assertEqual(log.payload["amount"], "40.00")

    def test_refunding_the_excess_by_hand_does_not_eat_the_credit_twice(self):
        from ..services import record_deposit_refund

        original = self._split_first(self._paid_visit(Decimal("70.00")))
        # il titolare restituisce i 40 dalla dashboard Stripe
        record_deposit_refund(original, refund_id="re_excess", cents=4000, status="succeeded")
        original.refresh_from_db()
        # versati 70, tornati 40: in cassa ne restano 30, quanto la visita
        self.assertEqual(original.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(original.deposit_credit, Decimal("30.00"))

    def test_the_checkout_gives_the_excess_back(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        original = self._split_first(self._paid_visit(Decimal("70.00")))
        user = User.objects.create_user(email="cassa22@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa22", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        item = original.items.get()
        body = {
            "blocks": [{"operator_id": self.op1.id, "lines": [
                {"line_type": "service", "service_id": item.service_id, "qty": 1, "unit_price": str(item.price)},
            ]}],
            "payments": [],
        }
        refunded = {"id": "re_ex", "amount": 4000, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self.client.post(
                f"/api/sales/checkout/{original.id}", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["sale"]["deposit_deducted"], "30.00")
        self.assertEqual(refund.call_args.kwargs["amount_cents"], 4000)
        original.refresh_from_db()
        self.assertEqual(original.deposit_refunded_amount, Decimal("40.00"))


class RefundEventsOrderTests(AgendaTestBase):
    """05-14, 02-21: lo stato della caparra non dipende dall'ordine degli eventi Stripe."""

    def _paid(self, amount="30.00"):
        return Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=_aware(self.day, 10),
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal(amount),
            deposit_payment_intent_id="pi_dep",
        )

    def test_a_late_pending_event_does_not_undo_a_succeeded_refund(self):
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="succeeded")
        # arriva in ritardo `refund.created`, con lo stato che aveva allora
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="pending")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("30.00"))

    def test_the_charge_refunded_total_is_remembered(self):
        from ..services import record_deposit_refund

        appointment = self._paid()
        # rimborso di 10 dalla dashboard Stripe: prima arriva `charge.refunded`…
        record_deposit_refund(appointment, floor_cents=1000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        # …poi il suo `refund.created`, che non lo conta una seconda volta
        record_deposit_refund(appointment, refund_id="re_dash", cents=1000, status="succeeded")
        # e un rimborso diverso che fallisce non tocca i 10 già restituiti
        record_deposit_refund(appointment, refund_id="re_2", cents=500, status="failed")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))

    def test_a_failure_after_charge_refunded_puts_the_money_back(self):
        """Il pavimento resta il massimo visto: un rimborso poi fallito non lo abbassa
        da solo. Prima la caparra restava «rimborsata» con i soldi ancora al salone."""
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, floor_cents=3000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="failed")
        appointment.refresh_from_db()
        # stato e importo insieme: niente restituito, la caparra torna detraibile
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("30.00"))
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refund_update").exists()
        )

    def test_a_pending_refund_counted_in_charge_refunded_is_not_subtracted_twice(self):
        """Se Stripe conta nel totale del `charge.refunded` anche il rimborso in corso,
        la cassa detraeva 10 invece di 20 e il rimborso risultava già fatto."""
        from apps.sales.models import DepositRefund
        from apps.sales.services import deposit_retained

        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="pending")
        record_deposit_refund(appointment, floor_cents=1000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDING)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(deposit_retained(appointment), Decimal("20.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))
        self.assertFalse(DepositRefund.objects.filter(appointment=appointment).exists())
        # riuscito: dieci restituiti, una volta sola
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="succeeded")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))

    def test_a_whole_refund_still_pending_is_not_yet_refunded(self):
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_all", cents=3000, status="pending")
        record_deposit_refund(appointment, floor_cents=3000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDING)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("0.00"))

    def test_a_partial_pending_refund_never_costs_the_client_the_rest(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        from ..models import AppointmentService
        from ..services import record_deposit_refund

        appointment = self._paid()
        AppointmentService.objects.create(
            appointment=appointment, service=self.svc60, operator=self.op1,
            duration_min=60, price=Decimal("50.00"),
        )
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="pending")
        appointment.refresh_from_db()
        user = User.objects.create_user(email="cassa25@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa25", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        # la cassa vede la quota detraibile e incassa il resto del conto
        due = Decimal("50.00") - appointment.deposit_credit
        body = {
            "blocks": [{"operator_id": self.op1.id, "lines": [
                {"line_type": "service", "service_id": self.svc60.id, "qty": 1, "unit_price": "50.00"},
            ]}],
            "payments": [{"method": "cash", "amount": str(due)}] if due else [],
        }
        refunded = {"id": "re_rest", "amount": int((Decimal("20.00") - appointment.deposit_credit) * 100),
                    "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self.client.post(
                f"/api/sales/checkout/{appointment.id}", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        deducted = Decimal(res.json()["sale"]["deposit_deducted"])
        # dei 30 versati: 10 stanno tornando, il resto è detratto o restituito qui
        given_back = Decimal(refund.call_args.kwargs["amount_cents"]) / 100 if refund.called else Decimal("0")
        self.assertEqual(deducted + given_back, Decimal("20.00"))

    def test_a_pending_partial_refund_leaves_the_rest_deductible(self):
        """02-21: con 10 € in restituzione la cassa detrae i 20 rimasti, non zero."""
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="pending")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))

    def test_a_refund_written_by_hand_is_not_counted_again(self):
        """Un rimborso scritto dall'admin senza la sua riga resta un rimborso."""
        from apps.sales.services import deposit_retained

        appointment = self._paid()
        Appointment.objects.filter(pk=appointment.pk).update(deposit_refunded_amount=Decimal("10.00"))
        appointment.refresh_from_db()
        self.assertEqual(deposit_retained(appointment), Decimal("20.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))


class DepositHoldFollowsTheVisitTests(AgendaTestBase):
    """02-04, 02-16: scadenza e sollecito seguono il termine vero, non un inizio che non c'è più."""

    def _settings(self, hold, reminder=0):
        from apps.core.models import DepositRule, Salon, SalonSettings

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"deposit_hold_minutes": hold, "deposit_reminder_minutes": reminder}
        )
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def _book(self, start):
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appointment = create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    start, via="dashboard", force=True,
                )
        appointment.refresh_from_db()
        return appointment

    def _move(self, appointment, start):
        from ..services import move_appointment

        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            move_appointment(appointment, start, force=True)
        appointment.refresh_from_db()

    def test_a_last_minute_booking_moved_later_is_not_released_at_the_old_time(self):
        from ..services import process_deposit_holds

        self._settings(hold=24 * 60)
        booked_at = timezone.now()
        start = booked_at + dt.timedelta(hours=2)
        appointment = self._book(start)
        self.assertEqual(appointment.deposit_due_at, appointment.start)  # tagliata all'inizio
        self._move(appointment, _aware(self.day, 10))  # «spostami a martedì prossimo»
        result = process_deposit_holds(self.salon, now=start + dt.timedelta(minutes=1))
        self.assertEqual(result["released"], 0)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        # la scadenza mostrata è di nuovo quella vera: 24 ore dalla prenotazione
        self.assertAlmostEqual(
            (appointment.deposit_due_at - booked_at).total_seconds(), 24 * 3600, delta=60
        )
        # e allo scadere delle 24 ore, se non paga, lo slot si libera
        result = process_deposit_holds(self.salon, now=booked_at + dt.timedelta(hours=24, minutes=1))
        self.assertEqual(result["released"], 1)

    def test_a_visit_moved_earlier_gets_the_deadline_cut_on_the_new_start(self):
        from ..services import process_deposit_holds

        self._settings(hold=24 * 60)
        appointment = self._book(_aware(self.day, 10))
        soon = timezone.now() + dt.timedelta(hours=2)
        self._move(appointment, soon)
        process_deposit_holds(self.salon, now=timezone.now())
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_due_at, appointment.start)
        # a visita cominciata non la si libera più
        result = process_deposit_holds(self.salon, now=appointment.start + dt.timedelta(minutes=5))
        self.assertEqual(result["released"], 0)

    def test_a_deadline_from_before_the_fix_follows_the_move_too(self):
        from ..services import process_deposit_holds

        self._settings(hold=24 * 60)
        now = timezone.now()
        appointment = self._book(now + dt.timedelta(hours=2))
        # riga scritta prima di `deposit_hold_until`: solo la scadenza tagliata
        Appointment.objects.filter(pk=appointment.pk).update(deposit_hold_until=None)
        self._move(appointment, _aware(self.day, 10))
        result = process_deposit_holds(self.salon, now=now + dt.timedelta(hours=2, minutes=1))
        self.assertEqual(result["released"], 0)

    def test_no_reminder_right_after_a_last_minute_booking(self):
        from ..services import process_deposit_holds

        self._settings(hold=60, reminder=30)
        now = timezone.now()
        self._book(now + dt.timedelta(minutes=20))
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=1))["reminded"], 0)
        # il sollecito cadrebbe dopo la scadenza (all'inizio della visita): non parte
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=19))["reminded"], 0)

    def test_the_reminder_still_comes_when_it_falls_before_the_cut_deadline(self):
        from ..services import process_deposit_holds

        self._settings(hold=60, reminder=10)
        now = timezone.now()
        self._book(now + dt.timedelta(minutes=40))
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=5))["reminded"], 0)
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=11))["reminded"], 1)
