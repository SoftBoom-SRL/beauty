"""«Torna indietro»: quando rifiutare, con quale motivo, cosa ripristinare, cosa dire.

Le classi con un reperto della caccia del 22/09 nella docstring (NN-MM)
descrivono il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import DepositRule, OutboxEvent, Salon, SalonSettings
from common.testing import bearer, put_json

from ..models import Appointment, Pause, UndoEntry, WaitlistEntry
from ..services.appointments import create_appointment, edit_appointment, move_appointment, split_appointment
from ..services.transitions import cancel_appointment, check_in, mark_no_show
from .base import WIDE, AgendaTestBase, MessagesTestBase, _aware


class UndoTests(AgendaTestBase):
    """«Torna indietro»: il gesto sbagliato si disfa, e senza avvisare nessuno."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        Membership.objects.create(user=self.user, salon=self.salon, role=self.role)
        self.auth = bearer(self.user, self.salon)

    def _other_staff(self):
        from apps.accounts.models import Membership, User

        other = User.objects.create_user(email="collega@theparlour.it", password="x" * 10)
        Membership.objects.create(user=other, salon=self.salon, role=self.role)
        return other

    def _book(self, hour=10, actor=None):
        return create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, hour), via="dashboard", actor=actor or self.user,
        )

    def test_a_wrong_move_goes_back_where_it_was(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
            res = self._undo()
        self.assertEqual(res.status_code, 200)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 10))
        # la conferma non era ancora partita: resta una sola, con l'orario vero
        alive = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
        self.assertEqual(alive.count(), 1)
        self.assertEqual(
            parse_datetime(alive.get().payload["start"]), _aware(self.day, 10)
        )

    def test_undoing_a_booking_makes_it_disappear(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            res = self._undo()
        self.assertEqual(res.status_code, 200)
        self.assertFalse(Appointment.objects.filter(id=appointment.id).exists())
        self.assertFalse(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).exists()
        )

    def test_the_undone_event_says_which_visits_it_touched(self):
        """Il pannello aperto su un'altra visita non deve rileggersi a ogni «Indietro»."""
        from apps.core.models import ActivityLog

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            moved = self._book()
            move_appointment(moved, _aware(self.day, 16), actor=self.user)
            self.assertEqual(self._undo().status_code, 200)
            booked = self._book(hour=12)
            self.assertEqual(self._undo().status_code, 200)
        logs = ActivityLog.objects.filter(salon=self.salon, type="appointment.undone").order_by("id")
        self.assertEqual(logs[0].payload["appointment_ids"], [moved.id])
        # anche la visita tolta: il suo pannello deve accorgersene e chiudersi
        self.assertEqual(logs[1].payload["appointment_ids"], [booked.id])

    def test_undoing_a_booking_already_confirmed_warns_the_client(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            res = self._undo()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(Appointment.objects.filter(id=appointment.id).exists())
        self.assertTrue(
            OutboxEvent.objects.filter(
                event_type="appointment.cancelled", status=OutboxEvent.Status.PENDING
            ).exists()
        )

    def test_undo_brings_back_a_cancelled_appointment(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            cancel_appointment(appointment, reason="sbaglio mio", actor=self.user)
            res = self._undo()
        self.assertEqual(res.status_code, 200)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        self.assertEqual(appointment.cancel_reason, "")

    def test_undo_puts_back_the_services_of_a_detached_one(self):
        from ..services.appointments import split_appointment

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},
                ],
                _aware(self.day, 10), via="dashboard", actor=self.user,
            )
            item = appointment.items.order_by("order").last()
            _, created = split_appointment(
                appointment, item_id=item.id, new_start=_aware(self.day, 17), actor=self.user
            )
            res = self._undo()
        self.assertEqual(res.status_code, 200)
        self.assertFalse(Appointment.objects.filter(id=created.id).exists())
        self.assertEqual(appointment.items.count(), 2)

    def test_undo_restores_a_removed_break(self):
        from apps.staff.models import Operator  # noqa: F401 (documenta il contesto)

        pause = Pause.objects.create(
            salon=self.salon, operator=self.op1, start=_aware(self.day, 13), duration_min=60
        )
        res = self.client.delete(f"/api/agenda/pauses/{pause.id}", **self.auth)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(self._undo().status_code, 200)
        back = Pause.objects.get(id=pause.id)
        self.assertEqual(back.start, _aware(self.day, 13))
        self.assertEqual(back.duration_min, 60)

    def test_a_colleague_cannot_be_undone(self):
        other = self._other_staff()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            self._book(actor=other)
        self.assertEqual(self.client.get("/api/agenda/undo", **self.auth).json(), [])
        self.assertEqual(self._undo().status_code, 404)

    def test_what_someone_else_changed_is_not_overwritten(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
            # una collega, da un'altra postazione, lo sposta ancora
            move_appointment(appointment, _aware(self.day, 18), actor=self._other_staff())
            res = self._undo({"entry_id": self.client.get("/api/agenda/undo", **self.auth).json()[0]["id"]})
        self.assertEqual(res.status_code, 409)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 18))

    def test_too_late_to_go_back(self):
        from ..models import UndoEntry

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        UndoEntry.objects.update(
            created_at=timezone.now() - dt.timedelta(minutes=30)
        )
        self.assertEqual(self.client.get("/api/agenda/undo", **self.auth).json(), [])
        self.assertEqual(self._undo().status_code, 404)

    def test_the_till_wins(self):
        """Conto chiuso: non si torna indietro, si dice perché."""
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        Appointment.objects.filter(id=appointment.id).update(
            status=Appointment.Status.CLOSED
        )
        res = self._undo()
        self.assertEqual(res.status_code, 409)

    def test_the_stack_goes_back_more_than_one_step(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
            move_appointment(appointment, _aware(self.day, 18), actor=self.user)
            self.assertEqual(self._undo().status_code, 200)
            self.assertEqual(self._undo().status_code, 200)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 10))


class UndoNeverSilencesAChangeInForceTests(MessagesTestBase):
    """02-03 / 03-01 / 18-04 A: «torna indietro» e i gesti precedenti ancora trattenuti."""

    def _about(self, when):
        return [e for e in self._pending() if parse_datetime(e.payload.get("start")) == when]

    def test_move_move_undo(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertEqual(parse_datetime(event.payload["start"]), _aware(self.day, 14))
        self.assertEqual(parse_datetime(event.payload["old_start"]), _aware(self.day, 10))

    def test_move_edit_undo(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        edit_appointment(appointment, note="nota sbagliata", actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual([e.event_type for e in self._about(_aware(self.day, 14))], ["appointment.moved"])

    def test_move_cancel_undo(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        cancel_appointment(appointment, reason="dito scivolato", actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertEqual(parse_datetime(event.payload["start"]), _aware(self.day, 15))
        self.assertEqual(parse_datetime(event.payload["old_start"]), _aware(self.day, 10))

    def test_move_check_in_undo(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        check_in(appointment, actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual([e.event_type for e in self._about(_aware(self.day, 15))], ["appointment.moved"])

    def test_a_late_undo_tells_the_time_the_client_knew(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        self._all_sent()  # lo spostamento è partito: la cliente sa «alle 14»
        self.assertEqual(self._undo().status_code, 200)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertEqual(parse_datetime(event.payload["start"]), _aware(self.day, 10))
        self.assertEqual(parse_datetime(event.payload["old_start"]), _aware(self.day, 14))

    def test_undo_within_the_hold_still_says_nothing(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(self._pending(), [])
        self.assertEqual(self._pending("slot:"), [])

    def test_undo_of_a_known_booking_frees_the_slot_for_the_waitlist(self):
        """03-12: la conferma era partita, il posto si libera davvero."""
        WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        self._book(10)
        self._all_sent()
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(self._freed(), [(self.op1.id, _aware(self.day, 10), 60)])

    def test_undo_of_a_communicated_move_frees_the_new_slot(self):
        """03-12: lo spostamento era partito; tornando indietro si libera l'orario nuovo."""
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        self._all_sent()
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(self._freed(), [(self.op1.id, _aware(self.day, 14), 60)])

    def test_without_any_history_the_undo_behaves_as_before(self):
        """Importato da Yourang (nessun messaggio nostro): via i trattenuti, niente altro."""
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1,
            start=_aware(self.day, 10), created_via=Appointment.CreatedVia.YOURANG,
        )
        appointment.items.create(service=self.svc60, operator=self.op1, duration_min=60, price=Decimal("50.00"))
        WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        # l'orario di partenza era noto (la prenotazione viene da Yourang)
        self.assertEqual(self._freed(), [(self.op1.id, _aware(self.day, 10), 60)])
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(self._pending(), [])
        # le 14 non le ha mai viste occupate nessuno, e le 10 sono di nuovo prese
        self.assertEqual(self._pending("slot:"), [])


class UndoTestBase(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda", "sales"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = bearer(self.user, self.salon)
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

    def _other_client(self):
        from apps.clients.models import Client

        return Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Neri", phone="+390000000007"
        )


class UndoRefusedWhenMoneyMovedTests(UndoTestBase):
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


class UndoTellsTheRealReasonTests(UndoTestBase):
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


class UndoOfABookingWithADepositLinkTests(UndoTestBase):
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


class UndoRechecksTheSlotTests(UndoTestBase):
    """02-08: si torna dov'era solo se quel posto è ancora libero."""

    BREAK_TAKEN = "Nel frattempo quell'orario è stato occupato: la pausa non si può rimettere dov'era"

    def _booked_by_someone_else(self, start):
        return create_appointment(
            self.salon, self._other_client(),
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            start, via="app",
        )

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

    def test_a_removed_break_does_not_come_back_on_top_of_a_booking(self):
        """Bug sospetto 6 (24/09): alle 12:55 si toglie la pausa di Giulia delle
        13:00, alle 12:58 una cliente prenota dall'app alle 13:00 con lei, alle
        13:02 «Indietro» rimetteva la pausa sopra la visita, senza un avviso."""
        pause = Pause.objects.create(
            salon=self.salon, operator=self.op1, start=_aware(self.day, 13), duration_min=60
        )
        self.assertEqual(self.client.delete(f"/api/agenda/pauses/{pause.id}", **self.auth).status_code, 200)
        self._booked_by_someone_else(_aware(self.day, 13))
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], self.BREAK_TAKEN)
        self.assertFalse(Pause.objects.filter(id=pause.id).exists())

    def test_a_moved_break_does_not_go_back_on_top_of_a_booking(self):
        pause = Pause.objects.create(
            salon=self.salon, operator=self.op1, start=_aware(self.day, 13), duration_min=60
        )
        moved = put_json(
            self.client, f"/api/agenda/pauses/{pause.id}",
            {"operator_id": self.op1.id, "start": _aware(self.day, 15).isoformat(), "duration_min": 60, "note": ""},
            **self.auth,
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        self._booked_by_someone_else(_aware(self.day, 13, 30))
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], self.BREAK_TAKEN)
        pause.refresh_from_db()
        self.assertEqual(pause.start, _aware(self.day, 15))

    def test_a_break_past_midnight_is_checked_on_the_next_day_too(self):
        pause = Pause.objects.create(
            salon=self.salon, operator=self.op1, start=_aware(self.day, 23), duration_min=120
        )
        self.assertEqual(self.client.delete(f"/api/agenda/pauses/{pause.id}", **self.auth).status_code, 200)
        self._booked_by_someone_else(_aware(self.day + dt.timedelta(days=1), 0, 30))
        res = self._undo()
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res.json()["detail"], self.BREAK_TAKEN)

    def test_a_booking_right_after_the_break_does_not_stop_it(self):
        pause = Pause.objects.create(
            salon=self.salon, operator=self.op1, start=_aware(self.day, 13), duration_min=60
        )
        self.assertEqual(self.client.delete(f"/api/agenda/pauses/{pause.id}", **self.auth).status_code, 200)
        self._booked_by_someone_else(_aware(self.day, 14))
        self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(Pause.objects.get(id=pause.id).start, _aware(self.day, 13))

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


class UndoRestoresTheSameRowsTests(UndoTestBase):
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


class UndoOfACancellationSendsANewLinkTests(UndoTestBase):
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


class UndoKeepsTheDepositDeadlineOnTheRealStartTests(UndoTestBase):
    """Seguito della voce 4 (24/09): con «Indietro» la scadenza della caparra segue l'orario vero."""

    def setUp(self):
        super().setUp()
        # Due giorni di termine: per una visita di domani la scadenza è
        # tagliata sull'inizio, per una della settimana prossima no.
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"deposit_hold_minutes": 48 * 60})
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def test_undoing_a_move_cuts_the_deadline_on_the_start_again(self):
        tomorrow = _aware(timezone.localdate() + dt.timedelta(days=1), 10)
        with patch("apps.clients.services.client_facts", return_value={}):
            appointment = self._book(tomorrow)
        self.assertEqual(appointment.deposit_due_at, tomorrow)
        move_appointment(appointment, _aware(self.day, 10), actor=self.user)
        appointment.refresh_from_db()
        self.assertGreater(appointment.deposit_due_at, tomorrow)
        # lo spostamento è già partito: «Indietro» manda un messaggio nuovo
        OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now(), attempts=1)
        self.assertEqual(self._undo().status_code, 200)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, tomorrow)
        self.assertEqual(appointment.deposit_due_at, tomorrow)
        (event,) = OutboxEvent.objects.filter(
            status=OutboxEvent.Status.PENDING, event_type="appointment.moved"
        )
        self.assertEqual(parse_datetime(event.payload["deposit_due_at"]), tomorrow)


class UndoOfANoShowSendsANewLinkTests(UndoTestBase):
    """Bug sospetto 1 (24/09), lato undo: il no-show chiude il link, «Indietro» ne manda uno nuovo."""

    def test_the_link_is_reissued_after_commit(self):
        appointment = self._book(timezone.now() - dt.timedelta(minutes=30), force=True)
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.REQUIRED, deposit_amount=Decimal("10.00"),
            deposit_checkout_session_id="cs_1", deposit_payment_link="https://pay.test/cs_1",
        )
        appointment.refresh_from_db()
        with patch("apps.sales.stripe_service.expire_deposit_checkout") as expire:
            with self.captureOnCommitCallbacks(execute=True):
                mark_no_show(appointment, actor=self.user)
        expire.assert_called_once()
        sent = []
        with patch("apps.sales.stripe_service.payments_enabled", return_value=True), patch(
            "apps.sales.stripe_service.ensure_deposit_link",
            side_effect=lambda a, **kw: sent.append(a.deposit_payment_link) or "https://pay.test/cs_2",
        ):
            with self.captureOnCommitCallbacks(execute=True):
                self.assertEqual(self._undo().status_code, 200)
        self.assertEqual(sent, [""])  # la sessione di prima è chiusa: se ne apre una nuova
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
