"""Test essenziali: shift_windows (turno normale, con pausa, con assenza, cycle_weeks=2)."""

import datetime as dt

from django.test import TestCase

from apps.core.models import Salon

from .models import Absence, Operator, WeeklyShift
from .services import shift_windows


class ShiftWindowsTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi"
        )
        # mercoledì 1 luglio 2026: settimana ISO 27 (27 % 2 == 1)
        self.day = dt.date(2026, 7, 1)
        assert self.day.weekday() == 2

    def test_turno_normale(self):
        WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=2, start_min=540, end_min=1020
        )
        self.assertEqual(shift_windows(self.operator, self.day), [(540, 1020)])

    def test_turno_con_pausa(self):
        WeeklyShift.objects.create(
            operator=self.operator,
            week_index=0,
            weekday=2,
            start_min=540,
            end_min=1020,
            break_start_min=780,
            break_end_min=840,
        )
        self.assertEqual(shift_windows(self.operator, self.day), [(540, 780), (840, 1020)])

    def test_assenza_annulla_il_turno(self):
        WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=2, start_min=540, end_min=1020
        )
        Absence.objects.create(
            operator=self.operator,
            date_from=self.day,
            date_to=self.day,
            type=Absence.Type.VACATION,
        )
        self.assertEqual(shift_windows(self.operator, self.day), [])

    def test_nessun_turno_nessuna_finestra(self):
        self.assertEqual(shift_windows(self.operator, self.day), [])

    def test_cycle_weeks_due(self):
        self.operator.cycle_weeks = 2
        self.operator.save(update_fields=["cycle_weeks"])
        WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=2, start_min=540, end_min=1020
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=1, weekday=2, start_min=600, end_min=900
        )
        day_a = self.day  # settimana ISO 27 -> week_index 1
        day_b = self.day + dt.timedelta(days=7)  # settimana ISO 28 -> week_index 0
        self.assertEqual(day_a.isocalendar()[1] % 2, 1)
        self.assertEqual(day_b.isocalendar()[1] % 2, 0)
        self.assertEqual(shift_windows(self.operator, day_a), [(600, 900)])
        self.assertEqual(shift_windows(self.operator, day_b), [(540, 1020)])
