"""Affidabilità calcolata: 100 − 25 per ogni no-show − 10 per ogni annullamento tardivo.

Era un numero scritto a mano che nessuno aggiornava. Ora la calcola il
gestionale sugli ultimi 12 mesi, un giorno alla volta, e la ricalcola quando
una visita diventa no-show o annullata in ritardo e quando «torna indietro»
da quegli stati; il comando `recompute_reliability` la rifà per tutte le
schede (dopo un import, e ogni giorno per i no-show che escono dalla finestra).
"""

import datetime as dt
import io
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.test import TestCase
from django.utils import timezone

from apps.core.models import ActivityLog, Salon
from common.testing import aware, staff_context

from ..api import get_client
from ..models import Client
from ..services import (
    client_facts,
    recompute_reliability,
    reliability_basis,
    reliability_score,
    reliability_since,
)


class _Base(TestCase):
    def setUp(self):
        from apps.accounts.models import User
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        self.anna = Client.objects.create(salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233")
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.marta = Operator.objects.create(salon=self.salon, first_name="Marta", last_name="Neri")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=60, price=Decimal("40")
        )
        self.today = timezone.localdate()

    def visit(self, start, *, client=None, operator=None, **fields):
        from apps.agenda.models import Appointment, AppointmentService

        operator = operator or self.giulia
        appointment = Appointment.objects.create(
            salon=self.salon, client=client or self.anna, operator=operator, start=start, forced=True, **fields
        )
        AppointmentService.objects.create(
            appointment=appointment, service=self.service, operator=operator, duration_min=60, price=Decimal("40"),
        )
        return appointment

    def days_ago(self, days, hour=10):
        return aware(self.today - dt.timedelta(days=days), hour)


class ScoreTests(_Base):
    def test_the_formula_stays_between_0_and_100(self):
        self.assertEqual(reliability_score(0, 0), 100)
        self.assertEqual(reliability_score(1, 0), 75)
        self.assertEqual(reliability_score(0, 1), 90)
        self.assertEqual(reliability_score(1, 2), 55)
        self.assertEqual(reliability_score(5, 0), 0)

    def test_two_no_shows_on_the_same_day_are_one(self):
        """Mani e piedi in contemporanea con due operatrici, saltati: un appuntamento mancato, non due."""
        self.visit(self.days_ago(3), status="no_show")
        self.visit(self.days_ago(3), operator=self.marta, status="no_show")
        basis = reliability_basis(self.anna)
        self.assertEqual((basis["score"], basis["no_shows"]), (75, 1))

    def test_a_day_with_a_no_show_does_not_also_count_as_late(self):
        self.visit(self.days_ago(3), status="no_show")
        self.visit(self.days_ago(3, 11), operator=self.marta, status="cancelled", cancelled_late=True)
        self.visit(self.days_ago(20), status="cancelled", cancelled_late=True)
        self.visit(self.days_ago(21), status="cancelled")  # annullata in tempo: non pesa
        basis = reliability_basis(self.anna)
        self.assertEqual((basis["no_shows"], basis["late_cancellations"], basis["score"]), (1, 1, 65))

    def test_only_the_last_twelve_months_count(self):
        self.visit(self.days_ago(400), status="no_show")
        self.assertEqual(reliability_basis(self.anna)["score"], 100)
        self.visit(self.days_ago(300), status="no_show")
        basis = reliability_basis(self.anna)
        self.assertEqual((basis["score"], basis["since"]), (75, reliability_since(self.today)))

    def test_the_twelve_months_start_on_the_same_day_last_year(self):
        self.assertEqual(reliability_since(dt.date(2026, 10, 15)), dt.date(2025, 10, 15))
        self.assertEqual(reliability_since(dt.date(2028, 2, 29)), dt.date(2027, 2, 28))

    def test_facts_use_the_calculated_score_and_count_days(self):
        """Le regole caparra leggono il punteggio calcolato ora, non la colonna."""
        Client.objects.filter(pk=self.anna.pk).update(reliability=40)
        self.anna.refresh_from_db()
        self.visit(self.days_ago(500), status="no_show")
        self.visit(self.days_ago(5), status="no_show")
        self.visit(self.days_ago(5), operator=self.marta, status="no_show")
        facts = client_facts(self.anna)
        self.assertEqual(facts["reliability"], 75)
        # di sempre, ma un giorno è un no-show
        self.assertEqual((facts["noshow_count"], facts["latecancel_count"]), (2, 0))


class FollowsTheAgendaTests(_Base):
    def _windows(self):
        return patch("apps.staff.services.shift_windows", return_value=[(0, 24 * 60)])

    def test_a_no_show_lowers_it_and_says_so(self):
        from apps.agenda.services.transitions import mark_no_show

        appointment = self.visit(timezone.now() - dt.timedelta(minutes=30))
        mark_no_show(appointment, actor=self.user)
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 75)
        log = ActivityLog.objects.get(type="client.updated")
        self.assertEqual(log.payload, {"client_id": self.anna.id, "fields": ["reliability"], "reliability": 75})

    def test_a_late_cancellation_by_the_client_lowers_it(self):
        from apps.agenda.services.transitions import cancel_appointment

        appointment = self.visit(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, by_client=True)
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 90)

    def test_a_cancellation_by_the_salon_does_not(self):
        from apps.agenda.services.transitions import cancel_appointment

        appointment = self.visit(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, actor=self.user)
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 100)
        self.assertFalse(ActivityLog.objects.filter(type="client.updated").exists())

    def test_undoing_the_no_show_gives_the_points_back(self):
        from apps.agenda.models import UndoEntry
        from apps.agenda.services.transitions import mark_no_show
        from apps.agenda.undo import perform

        appointment = self.visit(timezone.now() - dt.timedelta(minutes=30))
        mark_no_show(appointment, actor=self.user)
        with self._windows():
            perform(UndoEntry.objects.get(actor=self.user), actor=self.user)
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 100)

    def test_undoing_a_late_cancellation_gives_the_points_back(self):
        from apps.agenda.models import UndoEntry
        from apps.agenda.services.transitions import cancel_appointment
        from apps.agenda.undo import perform

        appointment = self.visit(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, actor=self.user, by_client=True, undoable=True)
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 90)
        with self._windows():
            perform(UndoEntry.objects.get(actor=self.user), actor=self.user)
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 100)

    def test_a_no_show_arriving_from_yourang_counts(self):
        from apps.agenda.models import Appointment
        from apps.integrations.sync import _create_from_event, _yourang_service

        start = timezone.now() - dt.timedelta(days=2)
        data = {"client_full_name": "Anna Verdi", "client_phone_number": "+393331112233"}
        remote = {"remote_start": start, "remote_duration_min": 60}
        _create_from_event(
            self.salon, "ev-1", data, remote, Appointment.Status.NO_SHOW, _yourang_service(self.salon)
        )
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 75)


class NotWritableTests(_Base):
    def test_the_card_shows_the_calculated_score_and_fixes_the_column(self):
        """La colonna rimasta indietro (un no-show uscito dalla finestra) si
        corregge appena qualcuno apre la scheda: la lista la ritrova giusta."""
        Client.objects.filter(pk=self.anna.pk).update(reliability=40)
        self.visit(self.days_ago(10), status="no_show")
        detail = get_client(SimpleNamespace(auth=staff_context(self.salon, {"clients"})), self.anna.id)
        self.assertEqual(detail.reliability, 75)
        self.assertEqual(
            detail.reliability_basis,
            {"score": 75, "no_shows": 1, "late_cancellations": 0, "since": reliability_since(self.today)},
        )
        self.anna.refresh_from_db()
        self.assertEqual(self.anna.reliability, 75)

    def test_recompute_writes_only_when_it_changes(self):
        self.assertEqual(recompute_reliability(self.anna), 100)
        self.assertFalse(ActivityLog.objects.exists())


class RecomputeCommandTests(_Base):
    def test_every_card_of_the_salon_is_recomputed(self):
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        stranger = Client.objects.create(salon=other_salon, first_name="Estranea", phone="+393330000009", reliability=10)
        bea = Client.objects.create(salon=self.salon, first_name="Bea", phone="+393334445566", reliability=30)
        carla = Client.objects.create(salon=self.salon, first_name="Carla", phone="+393337778899")
        # Anna: due giorni di no-show (uno con due appuntamenti) e un annullamento tardivo
        self.visit(self.days_ago(3), status="no_show")
        self.visit(self.days_ago(3), operator=self.marta, status="no_show")
        self.visit(self.days_ago(40), status="no_show")
        self.visit(self.days_ago(60), status="cancelled", cancelled_late=True)
        self.visit(self.days_ago(500), client=carla, status="no_show")  # fuori finestra
        out = io.StringIO()
        call_command("recompute_reliability", "--salon", str(self.salon.id), stdout=out)
        self.anna.refresh_from_db()
        bea.refresh_from_db()
        carla.refresh_from_db()
        stranger.refresh_from_db()
        self.assertEqual((self.anna.reliability, bea.reliability, carla.reliability), (40, 100, 100))
        self.assertEqual(stranger.reliability, 10)  # un altro salone non si tocca
        self.assertIn("2 schede aggiornate", out.getvalue())
        log = ActivityLog.objects.get(type="client.reliability_recomputed")
        self.assertEqual((log.salon_id, log.payload), (self.salon.id, {"changed": 2}))
        # Rilanciato non cambia niente; senza --salon passa da tutti i saloni.
        out = io.StringIO()
        call_command("recompute_reliability", "--salon", str(self.salon.id), stdout=out)
        self.assertIn("0 schede aggiornate in tutto", out.getvalue())
        call_command("recompute_reliability", stdout=io.StringIO())
        stranger.refresh_from_db()
        self.assertEqual(stranger.reliability, 100)

    def test_an_unknown_salon_is_an_error(self):
        with self.assertRaises(CommandError):
            call_command("recompute_reliability", "--salon", "999999", stdout=io.StringIO())
