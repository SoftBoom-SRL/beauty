"""Ciclo di vita dell'appuntamento: annullamento, check-in, no-show, gesti concorrenti, lock.

Le classi con un reperto della caccia del 22/09 nella docstring (NN-MM)
descrivono il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt
from decimal import Decimal
from unittest.mock import patch

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import ActivityLog, OutboxEvent, Salon

from ..models import Appointment, AppointmentService, UndoEntry
from ..services import (
    _lock_and_reload,
    cancel_appointment,
    check_in,
    create_appointment,
    lock_salon,
    mark_no_show,
    start_appointment,
)
from .base import AgendaTestBase, RealShiftsTestBase, _aware


class CancelAppointmentTests(AgendaTestBase):
    def _make(self, start, deposit_status=Appointment.DepositStatus.PAID):
        appointment = Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=self.op1,
            start=start,
            deposit_status=deposit_status,
            deposit_amount=Decimal("15.00"),
        )
        # Un appuntamento vero ha i suoi servizi: senza, annullandolo non si
        # libera niente da annunciare alla lista d'attesa (caccia 22/09, 02-13).
        AppointmentService.objects.create(
            appointment=appointment, service=self.svc60, operator=self.op1,
            duration_min=60, price=Decimal("50.00"),
        )
        return appointment

    def test_salon_cancelling_at_the_last_minute_does_not_punish_the_client(self):
        # Il test di prima pretendeva caparra trattenuta e `cancelled_late` da un
        # annullamento senza attore, cioè fatto dal salone: blindava il difetto.
        # L'app cliente rifiuta l'annullamento sotto le 24 ore, quindi l'unico
        # modo di arrivare qui a due ore dalla visita è che sia la reception ad
        # annullare (l'operatrice si è ammalata): la cliente non deve perdere la
        # caparra né finire fra le inaffidabili.
        appointment = self._make(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, reason="imprevisto")
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)
        self.assertFalse(appointment.cancelled_late)
        self.assertEqual(
            appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE
        )
        self.assertEqual(appointment.cancel_reason, "imprevisto")
        types = set(OutboxEvent.objects.values_list("event_type", flat=True))
        self.assertIn("appointment.cancelled", types)
        self.assertIn("slot.freed", types)

    def test_late_cancel_by_the_client_forfeits_deposit(self):
        # La penale resta, ma solo per chi annulla all'ultimo: la cliente.
        appointment = self._make(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, reason="non ce la faccio", by_client=True)
        appointment.refresh_from_db()
        self.assertTrue(appointment.cancelled_late)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.FORFEITED)

    def test_client_cancelling_in_time_gets_the_deposit_back(self):
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment, by_client=True)
        appointment.refresh_from_db()
        self.assertFalse(appointment.cancelled_late)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE)

    def test_mark_deposit_refunded_also_writes_how_much_came_back(self):
        # La scheda diceva «Caparra 15 · Rimborsato 0 · Stato: rimborsata».
        from ..services import mark_deposit_refunded

        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        appointment.refresh_from_db()
        mark_deposit_refunded(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("15.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("0.00"))

    def test_early_cancel_without_stripe_leaves_deposit_refund_due(self):
        # Nessun rimborso è avvenuto (Stripe non configurato, caparra incassata in
        # salone): lo stato deve dirlo, non fingere «rimborsata».
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        appointment.refresh_from_db()
        self.assertFalse(appointment.cancelled_late)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE)
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refund_due").exists()
        )

    def test_early_cancel_refunds_on_stripe_when_possible(self):
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        appointment.deposit_payment_intent_id = "pi_test_123"
        appointment.save(update_fields=["deposit_payment_intent_id"])
        refunded = {"id": "re_test_1", "amount": 1500, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_deposit", return_value=refunded) as refund:
            cancel_appointment(appointment)
        refund.assert_called_once_with(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refunded").exists()
        )

    def test_mark_deposit_refunded_manually(self):
        from ..services import mark_deposit_refunded

        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        appointment.refresh_from_db()
        mark_deposit_refunded(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        with self.assertRaises(HttpError) as caught:
            mark_deposit_refunded(appointment)
        self.assertEqual(caught.exception.status_code, 400)

    def test_cancelled_appointment_is_not_editable(self):
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        with self.assertRaises(HttpError) as caught:
            cancel_appointment(appointment)
        self.assertEqual(caught.exception.status_code, 400)


class ConcurrentTransitionTests(AgendaTestBase):
    """Due postazioni che lavorano sullo stesso appuntamento.

    Ogni mutazione decideva sullo stato che l'istanza aveva quando la richiesta
    era entrata, e salvava tutti i campi: chi spostava un appuntamento appena
    annullato da un'altra postazione lo riportava in agenda come confermato.
    """

    def _appointment(self):
        start = timezone.make_aware(dt.datetime.combine(self.day, dt.time(10)))
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=start
        )
        AppointmentService.objects.create(
            appointment=appointment,
            service=self.svc60,
            operator=self.op1,
            duration_min=60,
            price=Decimal("50.00"),
            order=0,
        )
        return appointment

    def test_a_move_on_a_stale_copy_cannot_undo_a_cancellation(self):
        from ..services import cancel_appointment, move_appointment

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)  # copia letta prima
        cancel_appointment(appointment)

        with self._windows({self.op1.id: [(0, 1440)]}):
            with self.assertRaises(HttpError) as caught:
                move_appointment(stale, appointment.start + dt.timedelta(hours=2))
        self.assertEqual(caught.exception.status_code, 400)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)

    def test_a_move_does_not_overwrite_a_deposit_paid_meanwhile(self):
        from ..services import move_appointment

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)
        # La caparra arriva (webhook Stripe) mentre lo spostamento è in volo.
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("20.00")
        )
        with self._windows({self.op1.id: [(0, 1440)]}):
            move_appointment(stale, appointment.start + dt.timedelta(hours=2))
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_amount, Decimal("20.00"))

    def test_check_in_is_refused_on_an_appointment_cancelled_meanwhile(self):
        from ..services import cancel_appointment, check_in

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)
        cancel_appointment(appointment)
        with self.assertRaises(HttpError):
            check_in(stale)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)


# ---- La reception registra la disdetta della cliente (seguito di 13-02) --------


class StaffRecordsClientCancellationTests(RealShiftsTestBase):
    """L'app rifiuta l'annullamento sotto le ore minime e manda la cliente dal
    salone; la reception, annullando sempre «come salone», non poteva applicare
    la penale: caparra rimborsata e nessuna disdetta tardiva nella scheda."""

    def _paid(self, hours_ahead):
        start = timezone.now() + dt.timedelta(hours=hours_ahead)
        appointment = self.book(self.anna, self.giulia, start, [(self.cut30, 30, 0)])
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("20.00"),
        )
        appointment.refresh_from_db()
        return appointment

    def _cancel(self, appointment, **body):
        return self.post(
            f"/api/agenda/appointments/{appointment.id}/cancel",
            {"reason": "Imprevisto", **body}, self.staff_auth(),
        )

    def test_a_late_cancellation_by_the_client_keeps_the_deposit(self):
        from apps.core.models import ActivityLog

        from ..models import UndoEntry

        appointment = self._paid(hours_ahead=3)
        res = self._cancel(appointment, by_client=True)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["status"], body["deposit_status"], body["cancelled_late"]),
                         ("cancelled", "forfeited", True))
        log = ActivityLog.objects.filter(salon=self.salon, type="appointment.cancelled").latest("id")
        self.assertIn("su richiesta della cliente", log.summary)
        self.assertTrue(log.payload["by_client"])
        event = OutboxEvent.objects.filter(salon=self.salon, event_type="appointment.cancelled").latest("id")
        self.assertEqual((event.payload["by_client"], event.payload["late"]), (True, True))
        # è un gesto della postazione: si può disfare
        self.assertTrue(UndoEntry.objects.filter(salon=self.salon, kind=UndoEntry.Kind.CANCEL).exists())

    def test_in_time_the_client_gets_the_deposit_back(self):
        appointment = self._paid(hours_ahead=72)
        body = self._cancel(appointment, by_client=True).json()
        self.assertEqual((body["deposit_status"], body["cancelled_late"]), ("refund_due", False))

    def test_the_salon_cancelling_late_still_refunds(self):
        appointment = self._paid(hours_ahead=3)
        body = self._cancel(appointment).json()
        self.assertEqual((body["deposit_status"], body["cancelled_late"]), ("refund_due", False))

    def test_undo_puts_back_the_deposit_and_clears_the_late_mark(self):
        appointment = self._paid(hours_ahead=3)
        self.assertEqual(self._cancel(appointment, by_client=True).status_code, 200)
        res = self.post("/api/agenda/undo", {}, self.staff_auth())
        self.assertEqual(res.status_code, 200, res.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertFalse(appointment.cancelled_late)


class _StaffMixin:
    def _staff(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return user

    def _visit(self, start, **kwargs):
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            return create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                start, via="dashboard", force=True, **kwargs,
            )


class CheckInNeverGoesBackwardsTests(_StaffMixin, AgendaTestBase):
    """02-19: il check-in non riporta indietro un trattamento già iniziato."""

    def test_an_in_progress_treatment_stays_in_progress(self):
        appointment = self._visit(timezone.now())
        start_appointment(appointment)
        with self.assertRaises(HttpError) as err:
            check_in(Appointment.objects.get(pk=appointment.pk))  # la scheda vecchia
        self.assertEqual(err.exception.status_code, 400)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.IN_PROGRESS)

    def test_a_second_check_in_changes_nothing(self):
        user = self._staff()
        appointment = self._visit(timezone.now(), actor=user)
        check_in(appointment, actor=user)
        events = OutboxEvent.objects.count()
        entries = UndoEntry.objects.count()
        check_in(Appointment.objects.get(pk=appointment.pk), actor=user)
        self.assertEqual(OutboxEvent.objects.count(), events)
        self.assertEqual(UndoEntry.objects.count(), entries)


class NoShowOnlyForAConfirmedStartedVisitTests(_StaffMixin, AgendaTestBase):
    """02-09: no-show solo da «confermato» e dopo l'orario d'inizio."""

    def test_not_once_the_client_is_in_the_salon(self):
        for advance in (check_in, lambda a: (check_in(a), start_appointment(a))):
            appointment = self._visit(timezone.now() - dt.timedelta(minutes=10))
            advance(appointment)
            with self.assertRaises(HttpError) as err:
                mark_no_show(appointment)
            self.assertEqual(err.exception.status_code, 400)
            appointment.refresh_from_db()
            self.assertNotEqual(appointment.status, Appointment.Status.NO_SHOW)

    def test_not_before_the_start(self):
        appointment = self._visit(_aware(self.day, 15))  # fra una settimana
        with self.assertRaises(HttpError):
            mark_no_show(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)

    def test_a_missed_appointment_is_still_a_no_show(self):
        appointment = self._visit(timezone.now() - dt.timedelta(minutes=20))
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("10.00")
        )
        mark_no_show(appointment, reason="non venuta")
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.NO_SHOW)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.FORFEITED)


class LockOrderTests(_StaffMixin, AgendaTestBase):
    """02-23 / 18-08: salone (FOR NO KEY UPDATE) e poi la riga dell'appuntamento."""

    def test_the_salon_lock_does_not_block_foreign_key_checks(self):
        with patch.object(
            Salon.objects, "select_for_update", wraps=Salon.objects.select_for_update
        ) as salon_lock:
            with transaction.atomic():
                lock_salon(self.salon)
        salon_lock.assert_called_once_with(no_key=True)

    def test_the_row_is_locked_after_the_salon(self):
        appointment = self._visit(_aware(self.day, 10))
        calls = []
        with patch.object(
            Salon.objects, "select_for_update",
            side_effect=lambda *a, **k: calls.append("salon") or Salon._base_manager.select_for_update(*a, **k),
        ), patch.object(
            Appointment.objects, "select_for_update",
            side_effect=lambda *a, **k: calls.append("appointment") or Appointment._base_manager.select_for_update(*a, **k),
        ):
            with transaction.atomic():
                _lock_and_reload(appointment)
        self.assertEqual(calls, ["salon", "appointment"])
