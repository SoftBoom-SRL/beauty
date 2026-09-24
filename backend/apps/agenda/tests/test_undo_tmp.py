"""Caccia ai bug del 22/09 — «torna indietro»: quando rifiutare, con quale motivo, cosa ripristinare.

Ogni test descrive il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone

from apps.core.models import DepositRule, OutboxEvent
from common.auth import create_staff_tokens

from ..models import Appointment, UndoEntry
from ..services import (
    cancel_appointment,
    create_appointment,
    edit_appointment,
    mark_no_show,
    move_appointment,
    split_appointment,
)
from .test_agenda_legacy import AgendaTestBase, _aware

WIDE = [(0, 24 * 60)]


class _Base(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda", "sales"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }
        windows = self._windows({self.op1.id: WIDE, self.op2.id: WIDE})
        windows.start()
        self.addCleanup(windows.stop)

    def _book(self, start=None, via="dashboard", actor="me", items=None, **kwargs):
        return create_appointment(
            self.salon, self.client_obj,
            items or [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            start or _aware(self.day, 10), via=via,
            actor=self.user if actor == "me" else actor, **kwargs,
        )

    def _undo(self):
        return self.client.post(
            "/api/agenda/undo", data=json.dumps({}), content_type="application/json", **self.auth
        )

    def _other_client(self):
        from apps.clients.models import Client

        return Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Neri", phone="+390000000007"
        )


class UndoRefusedWhenMoneyMovedTests(_Base):
    """03-03 / 02-22 / 18-03: vendita o addebito no-show agganciati → 409."""

    def test_no_show_already_charged_on_the_card(self):
        from apps.sales.services import record_no_show_charge

        appointment = self._book(timezone.now() - dt.timedelta(minutes=30), force=True)
        mark_no_show(appointment, actor=self.user)
        Appointment.objects.filter(pk=appointment.pk).update(no_show_payment_intent_id="pi_ns")
        appointment.refresh_from_db()
        record_no_show_charge(self.salon, appointment, amount=Decimal("50.00"), actor=self.user)
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertIn("addebitato", res.json()["detail"])
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.NO_SHOW)

    def test_a_sale_hooked_to_the_visit(self):
        from apps.sales.services import record_no_show_charge

        appointment = self._book(timezone.now() - dt.timedelta(minutes=30), force=True)
        mark_no_show(appointment, actor=self.user)
        record_no_show_charge(self.salon, appointment, amount=Decimal("50.00"), actor=self.user)
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertIn("incasso", res.json()["detail"])


class UndoTellsTheRealReasonTests(_Base):
    """03-14 (e 02-07): il 409 dice cosa è successo, non «una collega»."""

    def test_the_cancellation_already_refunded_the_deposit(self):
        appointment = self._book()
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("10.00"),
            deposit_payment_intent_id="pi_dep",
        )
        with patch(
            "apps.sales.stripe_service.refund_deposit",
            return_value={"id": "re_1", "amount": 1000, "status": "succeeded"},
        ):
            cancel_appointment(appointment, reason="dito scivolato", actor=self.user)
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertIn("rimborsata", res.json()["detail"])
        self.assertNotIn("Qualcuno", res.json()["detail"])

    def test_the_deposit_was_paid_before_undoing_the_booking(self):
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        with patch("apps.clients.services.client_facts", return_value={}):
            appointment = self._book()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REQUIRED)
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_payment_intent_id="pi_1"
        )
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertIn("pagamento della caparra", res.json()["detail"])
        self.assertTrue(Appointment.objects.filter(pk=appointment.pk).exists())

    def test_released_in_the_meantime(self):
        appointment = self._book()
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        Appointment.objects.filter(pk=appointment.pk).update(
            status=Appointment.Status.CANCELLED, auto_released=True
        )
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertIn("liberato", res.json()["detail"])


class UndoOfABookingWithADepositLinkTests(_Base):
    """02-07 / 03-02 / 05-08 / 18-01 (lato undo): il link non resta pagabile."""

    def setUp(self):
        super().setUp()
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        with patch("apps.clients.services.client_facts", return_value={}):
            self.appointment = self._book()
        Appointment.objects.filter(pk=self.appointment.pk).update(
            deposit_payment_link="https://checkout.stripe.test/c/pay/cs_1",
            deposit_checkout_session_id="cs_1",
        )

    def _link(self, status):
        return OutboxEvent.objects.create(
            salon=self.salon, event_type="deposit.payment_link", status=status,
            payload={"appointment_id": self.appointment.id, "url": "https://checkout.stripe.test/c/pay/cs_1"},
        )

    def _undo_closing(self):
        closed = []
        with patch(
            "apps.sales.stripe_service.expire_deposit_checkout",
            side_effect=lambda a: closed.append((a.pk, a.deposit_checkout_session_id)),
        ):
            with self.captureOnCommitCallbacks(execute=True):
                res = self._undo()
        return res, closed

    def test_a_link_already_delivered_is_closed_and_the_client_told(self):
        self._link(OutboxEvent.Status.SENT)
        res, closed = self._undo_closing()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(Appointment.objects.filter(pk=self.appointment.pk).exists())
        self.assertEqual(closed, [(self.appointment.pk, "cs_1")])
        # la cliente ha in mano il link: le si dice che l'appuntamento non c'è più
        self.assertTrue(
            OutboxEvent.objects.filter(
                event_type="appointment.cancelled", status=OutboxEvent.Status.PENDING
            ).exists()
        )

    def test_a_link_not_yet_sent_never_leaves(self):
        link = self._link(OutboxEvent.Status.PENDING)
        res, closed = self._undo_closing()
        self.assertEqual(res.status_code, 200, res.content)
        link.refresh_from_db()
        self.assertEqual(link.status, OutboxEvent.Status.SUPERSEDED)
        self.assertEqual(closed, [(self.appointment.pk, "cs_1")])
        # non ha ricevuto niente: niente annullamento da raccontarle
        self.assertFalse(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING, coalesce_key__startswith="appointment:").exists()
        )


class UndoRechecksTheSlotTests(_Base):
    """02-08: si torna dov'era solo se quel posto è ancora libero."""

    def test_a_client_booked_the_old_time_in_the_meantime(self):
        appointment = self._book()
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        create_appointment(
            self.salon, self._other_client(),
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="app",
        )
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertIn("occupato", res.json()["detail"])
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 15))

    def test_a_cancelled_visit_does_not_come_back_on_top_of_a_new_one(self):
        appointment = self._book()
        cancel_appointment(appointment, actor=self.user)
        create_appointment(
            self.salon, self._other_client(),
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10, 30), via="app",
        )
        self.assertEqual(self._undo().status_code, 409)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)

    def test_the_same_client_does_not_count(self):
        appointment = self._book()
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        self._book(_aware(self.day, 10, 30), actor=None, items=[{"service_id": self.svc30.id, "operator_id": self.op1.id}])
        self.assertEqual(self._undo().status_code, 200)

    def test_a_place_taken_by_force_stays_a_choice(self):
        other = create_appointment(
            self.salon, self._other_client(),
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard",
        )
        appointment = self._book(force=True)  # sopra Anna, forzando
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 10))
        self.assertTrue(Appointment.objects.filter(pk=other.pk).exists())


class UndoRestoresTheSameRowsTests(_Base):
    """03-13 (lato undo): i servizi tornano nelle loro righe, con lo stesso id."""

    def test_a_move_keeps_the_row(self):
        appointment = self._book()
        item = appointment.items.get()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(list(appointment.items.values_list("id", flat=True)), [item.id])

    def test_an_edit_from_a_panel_left_open_keeps_the_agreed_price(self):
        appointment = self._book()
        old_item = appointment.items.get()
        self.svc60.price = Decimal("65.00")  # listino aggiornato dopo la prenotazione
        self.svc60.save(update_fields=["price"])
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        edit_appointment(
            appointment,
            items=[{"id": old_item.id, "service_id": self.svc60.id, "operator_id": self.op1.id,
                    "duration_min": 75}],
            actor=self.user,
        )
        self.assertEqual(appointment.items.get().price, Decimal("50.00"))

    def test_an_edit_undone_brings_back_the_original_rows(self):
        appointment = self._book()
        item = appointment.items.get()
        edit_appointment(
            appointment,
            items=[{"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id, "duration_min": 75}],
            actor=self.user,
        )
        self.assertEqual(self._undo().status_code, 200)
        restored = appointment.items.get()
        self.assertEqual((restored.id, restored.duration_min), (item.id, 60))

    def test_a_detached_service_comes_back_in_its_row(self):
        appointment = self._book(items=[
            {"service_id": self.svc60.id, "operator_id": self.op1.id},
            {"service_id": self.svc30.id, "operator_id": self.op1.id},
        ])
        ids = list(appointment.items.order_by("order").values_list("id", flat=True))
        split_appointment(appointment, item_id=ids[1], new_start=_aware(self.day, 17), actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(list(appointment.items.order_by("order").values_list("id", flat=True)), ids)

    def test_an_entry_written_before_the_ids_is_still_undoable(self):
        appointment = self._book()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        entry = UndoEntry.objects.filter(kind=UndoEntry.Kind.MOVE).latest("id")
        for field in ("before", "after"):
            snap = getattr(entry, field)
            for item in snap["appointments"][0]["items"]:
                item.pop("id")
            setattr(entry, field, snap)
        entry.save(update_fields=["before", "after"])
        self.assertEqual(self._undo().status_code, 200)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 10))
        self.assertEqual(appointment.items.count(), 1)


class UndoOfACancellationSendsANewLinkTests(_Base):
    """05-13 + undo: l'annullamento ha chiuso il link, «Indietro» ne manda uno nuovo."""

    def test_the_link_is_reissued_after_commit(self):
        appointment = self._book()
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.REQUIRED, deposit_amount=Decimal("10.00"),
            deposit_checkout_session_id="cs_1", deposit_payment_link="https://pay.test/cs_1",
        )
        appointment.refresh_from_db()
        with patch("apps.sales.stripe_service.expire_deposit_checkout"):
            with self.captureOnCommitCallbacks(execute=True):
                cancel_appointment(appointment, actor=self.user)
        sent = []
        with patch("apps.sales.stripe_service.payments_enabled", return_value=True), patch(
            "apps.sales.stripe_service.ensure_deposit_link",
            side_effect=lambda a, **kw: sent.append(a.deposit_payment_link) or "https://pay.test/cs_2",
        ):
            with self.captureOnCommitCallbacks(execute=True):
                self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(sent, [""])  # link svuotato: ensure_deposit_link ne crea uno nuovo
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
