"""Caccia ai bug del 22/09 — ciclo di vita dell'appuntamento: stati, lock, posa altrui.

Ogni test descrive il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt
from decimal import Decimal
from unittest.mock import patch

from django.db import transaction
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import OutboxEvent, Salon

from ..models import Appointment, UndoEntry
from ..services import (
    _lock_and_reload,
    check_in,
    create_appointment,
    lock_salon,
    mark_no_show,
    move_appointment,
    start_appointment,
)
from .test_agenda_legacy import AgendaTestBase, _aware


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


class ClientMoveNeverLandsInAnotherSoakTests(AgendaTestBase):
    """01-11 / 04-08 (spostamento): dall'app mai dentro la posa di un'altra cliente."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        from apps.catalog.models import Service
        from apps.clients.models import Client

        cls.colour = Service.objects.create(
            salon=cls.salon, category=cls.svc60.category, name_it="Colore",
            duration_min=30, soak_min=60, price=Decimal("70.00"),
        )
        cls.op1.services.add(cls.colour)
        cls.other = Client.objects.create(
            salon=cls.salon, first_name="Anna", last_name="Neri", phone="+390000000009"
        )

    def setUp(self):
        self.windows = self._windows({self.op1.id: [(8 * 60, 20 * 60)]})
        self.windows.start()
        self.addCleanup(self.windows.stop)
        # Anna: colore alle 10:00, lavoro fino alle 10:30 e posa fino alle 11:30
        create_appointment(
            self.salon, self.other,
            [{"service_id": self.colour.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard",
        )
        self.mine = create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            _aware(self.day, 14), via="app",
        )

    def test_the_app_cannot_move_into_the_soak(self):
        with self.assertRaises(HttpError) as err:
            move_appointment(self.mine, _aware(self.day, 10, 30), allow_past=False)
        self.assertEqual(err.exception.status_code, 409)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.start, _aware(self.day, 14))

    def test_the_app_can_still_move_to_a_free_time(self):
        move_appointment(self.mine, _aware(self.day, 12), allow_past=False)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.start, _aware(self.day, 12))

    def test_the_staff_still_decides_by_hand(self):
        move_appointment(self.mine, _aware(self.day, 10, 30))
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.start, _aware(self.day, 10, 30))
        self.assertFalse(self.mine.forced)


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
