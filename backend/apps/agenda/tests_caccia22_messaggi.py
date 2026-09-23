"""Caccia ai bug del 22/09 — messaggi trattenuti verso Yourang e lista d'attesa.

Cosa la cliente sa (l'ultimo messaggio consegnato) contro cosa le si dice dopo
una fusione, un «torna indietro», un annullamento o un rilascio; e cosa sente
la lista d'attesa. Ogni test descrive il comportamento giusto: prima delle
correzioni fallivano.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import DepositRule, OutboxEvent, SalonSettings
from common.auth import create_staff_tokens

from .models import Appointment, WaitlistEntry
from .services import (
    appointment_event_key,
    cancel_appointment,
    check_in,
    create_appointment,
    edit_appointment,
    mark_no_show,
    move_appointment,
)
from .tests import AgendaTestBase, _aware

WIDE = [(0, 24 * 60)]


class _Base(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }
        windows = self._windows({self.op1.id: WIDE, self.op2.id: WIDE})
        windows.start()
        self.addCleanup(windows.stop)

    def _book(self, hour=10, minute=0, via="dashboard", items=None, **kwargs):
        return create_appointment(
            self.salon, self.client_obj,
            items or [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, hour, minute), via=via, actor=self.user, **kwargs,
        )

    def _all_sent(self):
        """Tutto quello che era in coda è arrivato da un pezzo."""
        OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).update(
            status=OutboxEvent.Status.SENT, sent_at=timezone.now(), attempts=1
        )

    def _pending(self, prefix="appointment:"):
        return list(
            OutboxEvent.objects.filter(
                status=OutboxEvent.Status.PENDING, coalesce_key__startswith=prefix
            ).order_by("id")
        )

    def _freed(self):
        return [
            (e.payload["operator_id"], parse_datetime(e.payload["start"]), e.payload["duration_min"])
            for e in self._pending("slot:")
        ]

    def _undo(self):
        return self.client.post(
            "/api/agenda/undo", data=json.dumps({}), content_type="application/json", **self.auth
        )


class MergedMoveKeepsWhatTheClientKnowsTests(_Base):
    """02-14 / 03-06 / 18-04 B (contratto C22): il primo `old_start` della fusione."""

    def test_two_moves_tell_the_time_the_client_knew(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 11), actor=self.user)
        move_appointment(appointment, _aware(self.day, 12), actor=self.user)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertEqual(parse_datetime(event.payload["start"]), _aware(self.day, 12))
        self.assertEqual(parse_datetime(event.payload["old_start"]), _aware(self.day, 10))

    def test_a_move_then_a_resize_is_still_a_move_from_the_old_time(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 12), actor=self.user)
        item = appointment.items.get()
        edit_appointment(
            appointment,
            items=[{"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id, "duration_min": 75}],
            actor=self.user,
        )
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertEqual(parse_datetime(event.payload["old_start"]), _aware(self.day, 10))

    def test_moved_back_before_the_message_left_says_nothing(self):
        WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        move_appointment(appointment, _aware(self.day, 10), actor=self.user)
        self.assertEqual(self._pending(), [])
        self.assertEqual(self._freed(), [])


class FreedSlotSaysWhatReallyFreedUpTests(_Base):
    """02-12, 02-13, 03-04: lo slot annunciato è quello davvero liberato."""

    def test_two_moves_announce_the_slot_the_client_left(self):
        WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 14), actor=self.user)
        move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        self.assertEqual(self._freed(), [(self.op1.id, _aware(self.day, 10), 60)])

    def test_a_quarter_hour_nudge_frees_a_quarter_hour(self):
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 10, 15), actor=self.user)
        self.assertEqual(self._freed(), [(self.op1.id, _aware(self.day, 10), 15)])

    def test_a_column_change_frees_the_operator_who_left(self):
        from apps.staff.models import Operator

        op3 = Operator.objects.create(salon=self.salon, first_name="Sara", last_name="Blu", color="#CCCCCC")
        for operator in (self.op2, op3):
            operator.services.add(self.svc60, self.svc30)
        waiting_op1 = WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc30, operator=self.op1
        )
        waiting_op2 = WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc30, operator=self.op2
        )
        with self._windows({o.id: WIDE for o in (self.op1, self.op2, op3)}):
            visit = self._book(10, items=[
                {"service_id": self.svc60.id, "operator_id": self.op1.id},
                {"service_id": self.svc30.id, "operator_id": self.op2.id},
            ])
            self._all_sent()
            move_appointment(visit, visit.start, operator=op3, from_operator=self.op2, actor=self.user)
        self.assertEqual(self._freed(), [(self.op2.id, _aware(self.day, 11), 30)])
        (event,) = self._pending("slot:")
        self.assertEqual(event.payload["matching_waitlist"], [waiting_op2.id])
        self.assertNotIn(waiting_op1.id, event.payload["matching_waitlist"])

    def test_a_past_slot_is_not_offered(self):
        self._no_automation_delay()
        appointment = create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            timezone.now() - dt.timedelta(hours=3), via="dashboard", force=True,
        )
        mark_no_show(appointment)
        self.assertFalse(OutboxEvent.objects.filter(event_type="slot.freed").exists())

    def test_what_is_left_of_a_started_slot_is_offered_from_now(self):
        self._no_automation_delay()
        appointment = create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            timezone.now() - dt.timedelta(minutes=20), via="dashboard", force=True,
        )
        mark_no_show(appointment)
        freed = OutboxEvent.objects.get(event_type="slot.freed")
        self.assertGreaterEqual(parse_datetime(freed.payload["start"]), timezone.now())
        self.assertLessEqual(freed.payload["duration_min"], 40)

    def test_a_service_that_does_not_fit_is_not_matched(self):
        long_wait = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        appointment = self._book(10)
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 10, 15), actor=self.user)
        (event,) = self._pending("slot:")
        self.assertNotIn(long_wait.id, event.payload["matching_waitlist"])


class ClientWhoKnowsIsAlwaysToldTests(_Base):
    """03-05: chi ha prenotato dall'app o ha il link caparra va avvisata anche entro la trattenuta."""

    def test_the_salon_cancels_an_app_booking_right_away(self):
        appointment = self._book(10, via="app")
        cancel_appointment(appointment, reason="operatrice malata", actor=self.user)
        self.assertEqual([e.event_type for e in self._pending()], ["appointment.cancelled"])

    def test_the_salon_cancels_a_booking_whose_deposit_link_was_sent(self):
        appointment = self._book(10)
        OutboxEvent.objects.create(
            salon=self.salon, event_type="deposit.payment_link",
            payload={"appointment_id": appointment.id}, status=OutboxEvent.Status.SENT,
        )
        cancel_appointment(appointment, actor=self.user)
        self.assertEqual([e.event_type for e in self._pending()], ["appointment.cancelled"])

    def test_a_desk_booking_nobody_heard_of_still_disappears_silently(self):
        appointment = self._book(10)
        cancel_appointment(appointment, actor=self.user)
        self.assertEqual(self._pending(), [])


class LateJoinerOfTheWaitlistTests(_Base):
    """03-10: chi si è messa in lista mentre lo slot era occupato viene avvisata."""

    def test_only_who_joined_after_the_booking_hears_of_it(self):
        before = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        WaitlistEntry.objects.filter(pk=before.pk).update(created_at=timezone.now() - dt.timedelta(hours=1))
        appointment = self._book(10)
        later = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        cancel_appointment(appointment, actor=self.user)
        (event,) = self._pending("slot:")
        self.assertEqual(event.payload["matching_waitlist"], [later.id])

    def test_nobody_new_nothing_said(self):
        early = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        WaitlistEntry.objects.filter(pk=early.pk).update(created_at=timezone.now() - dt.timedelta(hours=1))
        appointment = self._book(10)
        cancel_appointment(appointment, actor=self.user)
        self.assertEqual(self._pending("slot:"), [])


class DelaySwitchedOffTests(_Base):
    """03-09: passando a «Subito» la conferma trattenuta si fonde e parte subito."""

    def test_the_held_confirmation_leaves_with_the_right_time(self):
        appointment = self._book(10)
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"automation_delay_seconds": 0})
        move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.created")
        self.assertEqual(parse_datetime(event.payload["start"]), _aware(self.day, 16))
        self.assertIsNone(event.next_attempt_at)  # parte al prossimo giro del worker


class ReleaseForUnpaidDepositTests(_Base):
    """02-17 / 03-11 / 05-13: il rilascio è un evento finale e chiude il link."""

    def setUp(self):
        super().setUp()
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"deposit_hold_minutes": 30})
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        for target in ("apps.sales.stripe_service.payments_enabled",):
            enabled = patch(target, return_value=True)
            enabled.start()
            self.addCleanup(enabled.stop)
        self.salon.refresh_from_db()

    def test_no_move_message_is_left_behind_the_release(self):
        from .services import process_deposit_holds

        with patch("apps.clients.services.client_facts", return_value={}):
            appointment = self._book(10, via="app")
        Appointment.objects.filter(pk=appointment.pk).update(deposit_checkout_session_id="cs_1")
        self._all_sent()
        move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        appointment.refresh_from_db()
        with patch("apps.sales.stripe_service.expire_deposit_checkout") as expire:
            with self.captureOnCommitCallbacks(execute=True):
                process_deposit_holds(self.salon, now=appointment.deposit_due_at + dt.timedelta(seconds=1))
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)
        self.assertEqual([e.event_type for e in self._pending()], ["appointment.released_unpaid"])
        self.assertEqual(self._pending()[0].coalesce_key, appointment_event_key(appointment.id))
        self.assertTrue(expire.called, "il link della caparra resta pagabile dopo il rilascio")


class CancelClosesTheDepositLinkTests(_Base):
    """05-13: annullando, il link della caparra non incassa più."""

    def test_the_link_is_withdrawn_and_closed_after_commit(self):
        appointment = self._book(10)
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.REQUIRED, deposit_amount=Decimal("10.00"),
            deposit_checkout_session_id="cs_1", deposit_payment_link="https://pay.test/cs_1",
        )
        link = OutboxEvent.objects.create(
            salon=self.salon, event_type="deposit.payment_link",
            payload={"appointment_id": appointment.id},
        )
        calls = []
        with patch(
            "apps.sales.stripe_service.expire_deposit_checkout",
            side_effect=lambda a: calls.append(a.deposit_checkout_session_id),
        ):
            with self.captureOnCommitCallbacks(execute=True) as callbacks:
                cancel_appointment(appointment, actor=self.user)
                self.assertEqual(calls, [], "Stripe va chiamato solo a transazione chiusa")
        self.assertEqual(len(callbacks), 1)
        self.assertEqual(calls, ["cs_1"])
        link.refresh_from_db()
        self.assertEqual(link.status, OutboxEvent.Status.SUPERSEDED)


class PayloadCarriesThePreferencesTests(_Base):
    """06-09: chi ha spento i promemoria WhatsApp lo dice anche a Yourang."""

    def test_reminder_preference_and_service_details(self):
        self.client_obj.whatsapp_reminders = False
        self.client_obj.wa = False
        self.client_obj.save(update_fields=["whatsapp_reminders", "wa"])
        self._book(10)
        (event,) = self._pending()
        self.assertIs(event.payload["whatsapp_reminders"], False)
        self.assertIs(event.payload["wa"], False)
        self.assertEqual(
            event.payload["services"][0],
            {
                "id": self.svc60.id, "name": self.svc60.name_it, "duration_min": 60,
                "soak_min": 0, "operator_id": self.op1.id,
            },
        )


class UndoNeverSilencesAChangeInForceTests(_Base):
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
