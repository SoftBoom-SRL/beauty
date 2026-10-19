"""Turni: `shift_windows` (turno normale, con pausa, con assenza, ciclo di
più settimane), gli orari di apertura del salone che li limitano, la
sostituzione dei turni dall'API.

Caccia del 22/09:
- 18-14: i turni si sostituiscono sotto lock, sull'operatrice riletta.
"""

import datetime as dt
import json
from unittest import mock

from django.test import TestCase

from apps.core.models import Salon

from ..models import Absence, Operator, WeeklyShift
from ..services import shift_windows, today_status
from .base import StaffApiTestCase, _StaffSetup


class ShiftWindowsTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi"
        )
        # mercoledì 1 luglio 2026: 105 685 settimane trascorse → indice 1 su ciclo 2
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
        """Indici scritti a mano, non ricavati da `_week_index`: seminare la
        fixture con la funzione sotto esame renderebbe il test verde anche se
        la funzione sbagliasse (le settimane trascorse dal 1° gennaio dell'anno
        1 per il 2026-07-01 sono 105 685, dispari -> indice 1 su un ciclo di 2)."""
        self.operator.cycle_weeks = 2
        self.operator.save(update_fields=["cycle_weeks"])
        WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=2, start_min=540, end_min=1020
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=1, weekday=2, start_min=600, end_min=900
        )
        day_a = dt.date(2026, 7, 1)  # mercoledì, indice 1
        day_b = dt.date(2026, 7, 8)  # mercoledì successivo, indice 0
        self.assertEqual(shift_windows(self.operator, day_a), [(600, 900)])
        self.assertEqual(shift_windows(self.operator, day_b), [(540, 1020)])


class EmploymentPeriodShiftTests(TestCase):
    """16/10: fuori dal rapporto di lavoro (prima di `employed_from`, dopo
    `employed_until`) il pattern non vale. Contato, il riempimento del passato
    metteva fra la capacità i turni di chi non c'era ancora."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(salon=self.salon, first_name="Nina", last_name="N")
        for weekday in range(7):
            WeeklyShift.objects.create(operator=self.operator, week_index=0, weekday=weekday, start_min=540, end_min=1080)
        self.start, self.end = dt.date(2026, 7, 6), dt.date(2026, 7, 10)
        self.operator.employed_from, self.operator.employed_until = self.start, self.end
        self.operator.save()

    def test_no_shift_before_the_start_or_after_the_end_both_days_included(self):
        day = lambda n: self.start + dt.timedelta(days=n)  # noqa: E731
        self.assertEqual(shift_windows(self.operator, day(-1)), [])
        self.assertEqual(shift_windows(self.operator, self.start), [(540, 1080)])
        self.assertEqual(shift_windows(self.operator, self.end), [(540, 1080)])
        self.assertEqual(shift_windows(self.operator, self.end + dt.timedelta(days=1)), [])
        self.assertEqual(
            [today_status(self.operator, d)["out_of_team"] for d in (day(-1), self.start, self.end, day(5))],
            ["before", None, None, "after"],
        )
        self.assertFalse(today_status(self.operator, day(-1))["on_shift"])

    def test_without_dates_there_is_no_limit(self):
        self.operator.employed_from = self.operator.employed_until = None
        self.operator.save()
        self.assertEqual(shift_windows(self.operator, dt.date(2020, 1, 1)), [(540, 1080)])
        self.assertIsNone(today_status(self.operator, dt.date(2020, 1, 1))["out_of_team"])


class OpeningHoursIntersectionTests(TestCase):
    """Gli orari di apertura del salone (Impostazioni) limitano i turni: fuori
    orario o nei giorni di chiusura non si prenota, qualunque sia il turno."""

    def setUp(self):
        from apps.core.models import SalonSettings

        self.SalonSettings = SalonSettings
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Rossi")
        self.day = dt.date(2026, 7, 1)  # mercoledì → weekday 2
        WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=2, start_min=9 * 60, end_min=19 * 60
        )

    def _operator(self):
        return Operator.objects.select_related("salon").get(pk=self.operator.pk)

    def test_without_configured_hours_the_shift_is_untouched(self):
        self.assertEqual(shift_windows(self._operator(), self.day), [(540, 1140)])

    def test_opening_hours_clip_the_shift(self):
        self.SalonSettings.objects.create(
            salon=self.salon, opening_hours_week={"2": [["10:00", "13:00"], ["14:00", "18:00"]]}
        )
        self.assertEqual(shift_windows(self._operator(), self.day), [(600, 780), (840, 1080)])

    def test_closed_day_gives_no_windows(self):
        self.SalonSettings.objects.create(salon=self.salon, opening_hours_week={"2": []})
        self.assertEqual(shift_windows(self._operator(), self.day), [])


class ShiftCycleAndContiguityTests(TestCase):
    """Due difetti trovati nella ricerca bug del 17/09/2026."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi", cycle_weeks=2
        )

    def test_two_week_cycle_keeps_alternating_across_a_53_week_year(self):
        """2026 ha 53 settimane ISO: contando le settimane ISO, la 53ª e la 1ª del
        2027 finivano sullo stesso indice e il ciclo restava invertito per sempre."""
        from ..services import _week_index

        mondays = [
            dt.date.fromisocalendar(2026, 52, 1),
            dt.date.fromisocalendar(2026, 53, 1),
            dt.date.fromisocalendar(2027, 1, 1),
            dt.date.fromisocalendar(2027, 2, 1),
        ]
        indexes = [_week_index(day, 2) for day in mondays]
        for previous, current in zip(indexes, indexes[1:]):
            self.assertNotEqual(previous, current, f"ciclo interrotto su {mondays}")

    # Gli indici qui sotto sono scritti a mano (T22): le fixture non devono
    # essere seminate con `_week_index`, la funzione che i test verificano.
    # martedì 2026-09-22 → 105 697 settimane trascorse → indice 1 su ciclo 2
    TUESDAY = dt.date(2026, 9, 22)
    TUESDAY_WEEK_INDEX = 1

    def test_week_index_matches_the_hand_computed_values(self):
        """Valori calcolati a mano dalla data, non dalla formula di produzione."""
        from ..services import _week_index

        self.assertEqual(_week_index(dt.date(2026, 7, 1), 2), 1)  # mercoledì
        self.assertEqual(_week_index(dt.date(2026, 7, 8), 2), 0)
        self.assertEqual(_week_index(dt.date(2026, 9, 22), 2), 1)  # martedì
        self.assertEqual(_week_index(dt.date(2026, 7, 1), 3), 1)
        self.assertEqual(_week_index(dt.date(2026, 7, 8), 3), 2)
        self.assertEqual(_week_index(dt.date(2026, 7, 15), 3), 0)

    def test_sunday_belongs_to_the_week_that_started_on_monday(self):
        """La domenica chiude la settimana, non ne apre una nuova: domenica
        2026-09-27 deve usare lo stesso indice del lunedì 2026-09-21 (1)."""
        monday, sunday = dt.date(2026, 9, 21), dt.date(2026, 9, 27)
        self.assertEqual(sunday.weekday(), 6)
        WeeklyShift.objects.create(
            operator=self.operator, week_index=1, weekday=0, start_min=9 * 60, end_min=13 * 60
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=1, weekday=6, start_min=10 * 60, end_min=14 * 60
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=6, start_min=8 * 60, end_min=9 * 60
        )
        self.assertEqual(shift_windows(self.operator, monday), [(9 * 60, 13 * 60)])
        self.assertEqual(shift_windows(self.operator, sunday), [(10 * 60, 14 * 60)])

    def test_contiguous_shift_rows_become_one_window(self):
        """9–13 e 13–18 sono lo stesso turno spezzato in due righe: un servizio
        che attraversa le 13 deve poter entrare."""
        day = self.TUESDAY
        WeeklyShift.objects.create(
            operator=self.operator, week_index=self.TUESDAY_WEEK_INDEX, weekday=1,
            start_min=9 * 60, end_min=13 * 60,
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=self.TUESDAY_WEEK_INDEX, weekday=1,
            start_min=13 * 60, end_min=18 * 60,
        )
        self.assertEqual(shift_windows(self.operator, day), [(9 * 60, 18 * 60)])

    def test_a_real_lunch_break_still_splits_the_window(self):
        WeeklyShift.objects.create(
            operator=self.operator, week_index=self.TUESDAY_WEEK_INDEX, weekday=1,
            start_min=9 * 60, end_min=18 * 60,
            break_start_min=13 * 60, break_end_min=14 * 60,
        )
        self.assertEqual(
            shift_windows(self.operator, self.TUESDAY),
            [(9 * 60, 13 * 60), (14 * 60, 18 * 60)],
        )

    def test_an_overlapping_row_cannot_swallow_the_lunch_break(self):
        """Due righe sovrapposte (9–18 con pausa 13–14, più 12–15): la fusione
        ricuciva il buco e l'agenda proponeva appuntamenti durante la pausa."""
        WeeklyShift.objects.create(
            operator=self.operator, week_index=self.TUESDAY_WEEK_INDEX, weekday=1,
            start_min=9 * 60, end_min=18 * 60,
            break_start_min=13 * 60, break_end_min=14 * 60,
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=self.TUESDAY_WEEK_INDEX, weekday=1,
            start_min=12 * 60, end_min=15 * 60,
        )
        self.assertEqual(
            shift_windows(self.operator, self.TUESDAY),
            [(9 * 60, 13 * 60), (14 * 60, 18 * 60)],
        )

    def test_opening_hours_still_apply_after_the_break_is_removed(self):
        from apps.core.models import SalonSettings

        SalonSettings.objects.create(
            salon=self.salon, opening_hours_week={"1": [["10:00", "17:00"]]}
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=self.TUESDAY_WEEK_INDEX, weekday=1,
            start_min=9 * 60, end_min=18 * 60,
            break_start_min=13 * 60, break_end_min=14 * 60,
        )
        operator = Operator.objects.select_related("salon").get(pk=self.operator.pk)
        self.assertEqual(
            shift_windows(operator, self.TUESDAY),
            [(10 * 60, 13 * 60), (14 * 60, 17 * 60)],
        )


class CycleWeeksReductionTests(StaffApiTestCase):
    """Abbassare il ciclo non deve lasciare turni che nessuna data seleziona più."""

    def setUp(self):
        super().setUp()
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi", cycle_weeks=2
        )
        self.kept = WeeklyShift.objects.create(
            operator=self.operator, week_index=0, weekday=1, start_min=540, end_min=1080
        )
        self.orphan = WeeklyShift.objects.create(
            operator=self.operator, week_index=1, weekday=1, start_min=600, end_min=900
        )

    def test_orphan_shifts_are_removed_with_the_cycle(self):
        res = self.put_operator(self.operator, cycle_weeks=1)
        self.assertEqual(res.status_code, 200, res.content)
        self.operator.refresh_from_db()
        self.assertEqual(self.operator.cycle_weeks, 1)
        self.assertEqual(
            list(self.operator.shifts.values_list("id", flat=True)), [self.kept.id]
        )
        # martedì 2026-09-22: con ciclo 1 ogni settimana è l'indice 0, quindi il
        # turno superstite torna a valere tutte le settimane
        self.assertEqual(shift_windows(self.operator, dt.date(2026, 9, 22)), [(540, 1080)])

    def test_raising_the_cycle_keeps_every_shift(self):
        res = self.put_operator(self.operator, cycle_weeks=3)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.operator.shifts.count(), 2)


class ReplaceShiftsValidationTests(StaffApiTestCase):
    def setUp(self):
        super().setUp()
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi", cycle_weeks=2
        )

    def _put(self, shifts):
        return self.client.put(
            f"/api/staff/{self.operator.id}/shifts",
            data={"shifts": shifts},
            content_type="application/json",
            **self.auth,
        )

    def test_overlapping_rows_on_the_same_day_are_refused(self):
        res = self._put(
            [
                {"week_index": 0, "weekday": 1, "start_min": 540, "end_min": 1080,
                 "break_start_min": 780, "break_end_min": 840},
                {"week_index": 0, "weekday": 1, "start_min": 720, "end_min": 900},
            ]
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(WeeklyShift.objects.count(), 0)

    def test_contiguous_rows_are_still_accepted(self):
        res = self._put(
            [
                {"week_index": 0, "weekday": 1, "start_min": 540, "end_min": 780},
                {"week_index": 0, "weekday": 1, "start_min": 780, "end_min": 1080},
            ]
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(WeeklyShift.objects.count(), 2)

    def test_rows_on_different_days_may_overlap_in_time(self):
        res = self._put(
            [
                {"week_index": 0, "weekday": 1, "start_min": 540, "end_min": 1080},
                {"week_index": 0, "weekday": 2, "start_min": 540, "end_min": 1080},
                {"week_index": 1, "weekday": 1, "start_min": 540, "end_min": 1080},
            ]
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(WeeklyShift.objects.count(), 3)

    def test_negative_week_index_is_refused(self):
        res = self._put([{"week_index": -1, "weekday": 1, "start_min": 540, "end_min": 1080}])
        self.assertEqual(res.status_code, 400, res.content)

    def test_week_index_beyond_the_cycle_is_refused(self):
        res = self._put([{"week_index": 2, "weekday": 1, "start_min": 540, "end_min": 1080}])
        self.assertEqual(res.status_code, 400, res.content)


class ReplaceShiftsTests(_StaffSetup):
    """18-14: i turni si sostituiscono sotto lock, sull'operatrice riletta."""

    def test_rows_are_validated_against_the_cycle_read_under_the_lock(self):
        from .. import api as staff_api

        auth = self._member("titolare@parlour.it", owner=True)
        self.bea.cycle_weeks = 2
        self.bea.save(update_fields=["cycle_weeks"])
        real_salon_get = staff_api.salon_get

        def read_then_cycle_shrinks(model, ctx, pk, **kwargs):
            obj = real_salon_get(model, ctx, pk, **kwargs)
            if model is Operator:
                # Un'altra postazione riduce il ciclo a una settimana subito dopo.
                Operator.objects.filter(pk=obj.pk).update(cycle_weeks=1)
            return obj

        body = {"shifts": [
            {"week_index": 0, "weekday": 0, "start_min": 540, "end_min": 1080},
            {"week_index": 1, "weekday": 0, "start_min": 540, "end_min": 1080},
        ]}
        with mock.patch.object(staff_api, "salon_get", side_effect=read_then_cycle_shrinks):
            res = self.client.put(
                f"/api/staff/{self.bea.id}/shifts", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(WeeklyShift.objects.filter(operator=self.bea).exists())


class RosterTests(StaffApiTestCase):
    """GET /api/staff/roster: i turni del team giorno per giorno (16/10). Il
    calendario della scheda mostrava solo le assenze, e per sapere se il sabato
    pomeriggio era coperto bisognava aprire le schede una per una."""

    def setUp(self):
        super().setUp()
        from apps.core.models import SalonSettings

        SalonSettings.objects.create(salon=self.salon, opening_hours_week={str(d): [["09:00", "19:00"]] for d in range(6)} | {"6": []})
        # Anna: ciclo di 3 settimane, il giorno libero scorre (lunedì, mercoledì, venerdì), la domenica sempre
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="A", cycle_weeks=3, order=0)
        for week, free in enumerate((0, 2, 4)):
            for weekday in range(6):
                if weekday != free:
                    WeeklyShift.objects.create(operator=self.anna, week_index=week, weekday=weekday, start_min=540, end_min=1140, break_start_min=780, break_end_min=840)
        self.bea = Operator.objects.create(salon=self.salon, first_name="Bea", last_name="B", order=1)
        for weekday in range(6):
            WeeklyShift.objects.create(operator=self.bea, week_index=0, weekday=weekday, start_min=600, end_min=1080)
        Operator.objects.create(salon=self.salon, first_name="Vecchia", last_name="V", active=False)
        # un lunedì da cui il ciclo di Anna conta come prima settimana
        self.monday = next(dt.date(2026, 10, 5) + dt.timedelta(days=7 * k) for k in range(3) if ((dt.date(2026, 10, 5) + dt.timedelta(days=7 * k)).toordinal() - 1) // 7 % 3 == 0)

    def get(self, **params):
        res = self.client.get("/api/staff/roster", {"start": self.monday.isoformat(), **params}, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_three_weeks_of_the_rotation_with_absences_and_closed_days(self):
        Absence.objects.create(operator=self.bea, date_from=self.monday + dt.timedelta(days=1), date_to=self.monday + dt.timedelta(days=2), type="vacation", note="mare")
        out = self.get(days=21)
        self.assertEqual([o["first_name"] for o in out["operators"]], ["Anna", "Bea"], "solo le attive, in ordine")
        self.assertEqual(len(out["days"]), 21)
        anna = lambda i: out["days"][i]["cells"][0]  # noqa: E731
        bea = lambda i: out["days"][i]["cells"][1]  # noqa: E731
        # il giorno libero di Anna scorre: lunedì la 1ª settimana, mercoledì la 2ª, venerdì la 3ª
        self.assertEqual([anna(i)["week_index"] for i in (0, 7, 14)], [0, 1, 2])
        self.assertEqual([i for i in range(21) if not anna(i)["windows"]], [0, 6, 9, 13, 18, 20])
        self.assertEqual(anna(1)["windows"], [["09:00", "13:00"], ["14:00", "19:00"]])
        # la domenica il centro è chiuso
        self.assertEqual((out["days"][6]["opening"], out["days"][0]["opening"]), ([], [["09:00", "19:00"]]))
        # Bea in ferie martedì e mercoledì: niente turno, con l'assenza (per modificarla)
        self.assertEqual(bea(1)["windows"], [])
        self.assertEqual((bea(1)["absence"]["type"], bea(2)["absence"]["note"]), ("vacation", "mare"))
        self.assertIsNone(bea(3)["absence"])

    def test_days_outside_the_employment_period_have_no_shift(self):
        self.bea.employed_from = self.monday + dt.timedelta(days=2)
        self.bea.save(update_fields=["employed_from"])
        out = self.get(days=7)
        bea = [day["cells"][1] for day in out["days"]]
        self.assertEqual([c["out_of_team"] for c in bea[:3]], ["before", "before", None])
        self.assertEqual([bool(c["windows"]) for c in bea[:3]], [False, False, True])
        self.assertEqual(out["operators"][1]["employed_from"], (self.monday + dt.timedelta(days=2)).isoformat())

    def test_location_limits_and_bad_requests(self):
        from apps.core.models import Location

        nord = Location.objects.create(salon=self.salon, name="Nord")
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        self.bea.location = nord
        self.bea.save(update_fields=["location"])
        out = self.get(days=7, location_id=centro.id)
        self.assertEqual([o["first_name"] for o in out["operators"]], ["Anna"])
        for params in ({"days": 0}, {"days": 43}, {"start": "2026-02-30"}):
            res = self.client.get("/api/staff/roster", {"start": self.monday.isoformat(), **params}, **self.auth)
            self.assertEqual(res.status_code, 400, params)

    def test_the_roster_does_not_cost_a_query_per_operator_or_day(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as short:
            self.get(days=7)
        for i in range(4):
            extra = Operator.objects.create(salon=self.salon, first_name=f"Op{i}", last_name="X")
            WeeklyShift.objects.create(operator=extra, week_index=0, weekday=0, start_min=540, end_min=1080)
        with CaptureQueriesContext(connection) as long:
            self.get(days=28)
        self.assertEqual(len(long.captured_queries), len(short.captured_queries))
