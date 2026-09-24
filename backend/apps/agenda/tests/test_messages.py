"""Messaggi verso Yourang trattenuti: un gesto corretto un istante dopo non fa due messaggi.

Cosa la cliente sa (l'ultimo messaggio consegnato) contro cosa le si dice dopo
una fusione, un annullamento o un rilascio; e cosa sente la lista d'attesa.

Le classi con un reperto della caccia del 22/09 nella docstring (NN-MM)
descrivono il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt
from decimal import Decimal
from unittest.mock import patch

from django.db import models
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import DepositRule, OutboxEvent, SalonSettings

from ..models import Appointment, WaitlistEntry
from ..services.appointments import create_appointment, edit_appointment, move_appointment
from ..services.messages import appointment_event_key
from ..services.transitions import cancel_appointment, mark_no_show
from .base import WIDE, AgendaTestBase, MessagesTestBase, _aware


class AutomationDelayTests(AgendaTestBase):
    """Un gesto corretto un istante dopo non deve diventare due messaggi.

    Gli eventi dell'appuntamento restano trattenuti qualche secondo; finché
    sono lì si fondono con quelli successivi, e alla cliente arriva soltanto
    l'ultimo stato — o niente, se il gesto viene annullato.
    """

    def setUp(self):
        self.user = self._staff_user()

    def _staff_user(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return user

    def _book(self, hour=10, **kwargs):
        return create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, hour), via="dashboard", actor=self.user, **kwargs,
        )

    def _deliverable(self):
        """Eventi che un worker consegnerebbe adesso."""
        now = timezone.now()
        return list(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
            .filter(models.Q(next_attempt_at__isnull=True) | models.Q(next_attempt_at__lte=now))
            .order_by("id")
        )

    def test_the_confirmation_waits_before_leaving(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            self._book()
        event = OutboxEvent.objects.get(event_type="appointment.created")
        self.assertIsNotNone(event.next_attempt_at)
        self.assertGreater(event.next_attempt_at, timezone.now())
        self.assertEqual(self._deliverable(), [])  # nessuno lo consegna ancora

    def test_moving_right_after_booking_sends_one_message(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        alive = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
        self.assertEqual(alive.count(), 1)
        event = alive.get()
        # resta la CONFERMA, con l'orario buono: la cliente non ha ancora
        # ricevuto niente, quindi non c'è nessuno spostamento da raccontarle
        self.assertEqual(event.event_type, "appointment.created")
        self.assertEqual(event.payload["start"], _aware(self.day, 15).isoformat())
        self.assertEqual(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.SUPERSEDED).count(), 0
        )

    def test_cancelling_right_after_booking_sends_nothing(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            cancel_appointment(appointment, actor=self.user)
        self.assertFalse(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).exists()
        )
        # e nemmeno alla lista d'attesa: quello slot non si è mai occupato
        self.assertFalse(OutboxEvent.objects.filter(event_type="slot.freed").exists())

    def test_cancelling_a_known_appointment_still_speaks(self):
        """Se la conferma è già partita, l'annullamento si comunica eccome."""
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            cancel_appointment(appointment, actor=self.user)
        pending = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
        self.assertEqual(
            set(pending.values_list("event_type", flat=True)),
            {"appointment.cancelled", "slot.freed"},
        )

    def test_a_salon_can_turn_the_delay_off(self):
        self._no_automation_delay()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        types = list(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
            .values_list("event_type", flat=True)
        )
        self.assertIn("appointment.created", types)
        self.assertIn("appointment.moved", types)
        self.assertEqual(self._deliverable(), list(OutboxEvent.objects.order_by("id")))

    def test_the_hold_does_not_stretch_forever(self):
        """Chi continua a ritoccare non rimanda il messaggio all'infinito."""
        from ..services.messages import MAX_HOLD_FACTOR

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"automation_delay_seconds": 30}
        )
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            event = OutboxEvent.objects.get(event_type="appointment.created")
            # come se la conferma fosse stata accodata parecchi minuti fa
            OutboxEvent.objects.filter(id=event.id).update(
                created_at=timezone.now() - dt.timedelta(minutes=5)
            )
            move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        event.refresh_from_db()
        self.assertLessEqual(
            event.next_attempt_at,
            event.created_at + dt.timedelta(seconds=30 * MAX_HOLD_FACTOR),
        )

    def test_a_delivered_event_is_never_merged(self):
        """Un evento già tentato può essere arrivato: non si tocca più."""
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book()
            OutboxEvent.objects.update(attempts=1, next_attempt_at=timezone.now() + dt.timedelta(minutes=1))
            move_appointment(appointment, _aware(self.day, 15), actor=self.user)
        created = OutboxEvent.objects.get(event_type="appointment.created")
        self.assertEqual(created.payload["start"], _aware(self.day, 10).isoformat())
        self.assertTrue(OutboxEvent.objects.filter(event_type="appointment.moved").exists())
        self.assertFalse(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.SUPERSEDED).exists()
        )


class MergedMoveKeepsWhatTheClientKnowsTests(MessagesTestBase):
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


class FreedSlotSaysWhatReallyFreedUpTests(MessagesTestBase):
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


class ClientWhoKnowsIsAlwaysToldTests(MessagesTestBase):
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


class DelaySwitchedOffTests(MessagesTestBase):
    """03-09: passando a «Subito» la conferma trattenuta si fonde e parte subito."""

    def test_the_held_confirmation_leaves_with_the_right_time(self):
        appointment = self._book(10)
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"automation_delay_seconds": 0})
        move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.created")
        self.assertEqual(parse_datetime(event.payload["start"]), _aware(self.day, 16))
        self.assertIsNone(event.next_attempt_at)  # parte al prossimo giro del worker


class ReleaseForUnpaidDepositTests(MessagesTestBase):
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
        from ..services.deposit_holds import process_deposit_holds

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


class CancelClosesTheDepositLinkTests(MessagesTestBase):
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


class PayloadCarriesThePreferencesTests(MessagesTestBase):
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
