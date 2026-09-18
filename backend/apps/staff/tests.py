"""Test essenziali: shift_windows (turno normale, con pausa, con assenza, cycle_weeks=2)
e l'endpoint pubblico /public/operators (scelta stilista in prenotazione)."""

import datetime as dt
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon

from .models import Absence, Operator, WeeklyShift
from .services import shift_windows


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


class PublicOperatorsApiTests(TestCase):
    """GET /api/staff/public/operators: elenco operatrici attive, senza auth."""

    def setUp(self):
        from apps.catalog.models import Service, ServiceCategory

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon,
            category=category,
            name_it="Manicure",
            duration_min=30,
            price=Decimal("20.00"),
        )
        self.op_active = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi", color="#AACCEE"
        )
        self.op_active.services.add(self.service)
        self.op_inactive = Operator.objects.create(
            salon=self.salon, first_name="Marta", last_name="Verdi", active=False
        )

    def test_public_operators_no_auth(self):
        resp = self.client.get(f"/api/staff/public/operators?salon={self.salon.slug}")
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        ids = [o["id"] for o in data]
        self.assertIn(self.op_active.id, ids)
        self.assertNotIn(self.op_inactive.id, ids)
        active = next(o for o in data if o["id"] == self.op_active.id)
        self.assertEqual(active["service_ids"], [self.service.id])
        self.assertEqual(active["initials"], "GR")
        self.assertEqual(active["color"], "#AACCEE")

    def test_public_operators_unknown_salon_404(self):
        resp = self.client.get("/api/staff/public/operators?salon=inesistente")
        self.assertEqual(resp.status_code, 404, resp.content)


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


class OperatorColorApiTests(TestCase):
    """Il colore dell'operatrice in agenda è condiviso fra le postazioni."""

    def test_patch_color_is_persisted_and_logged(self):
        from apps.accounts.models import Membership, Role, User
        from apps.core.models import ActivityLog
        from common.auth import create_staff_tokens

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        operator = Operator.objects.create(salon=salon, first_name="Giulia", last_name="Rossi", color="#AAAAAA")
        user = User.objects.create_user(email="front@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}
        res = self.client.patch(f"/api/staff/{operator.id}/color", data='{"color": "#c9b8f2"}', content_type="application/json", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        operator.refresh_from_db()
        self.assertEqual(operator.color, "#C9B8F2")
        self.assertTrue(ActivityLog.objects.filter(salon=salon, type="operator.updated").exists())
        res = self.client.patch(f"/api/staff/{operator.id}/color", data='{"color": "rosso"}', content_type="application/json", **auth)
        self.assertEqual(res.status_code, 400)


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
        from .services import _week_index

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
        from .services import _week_index

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


class StaffApiTestCase(TestCase):
    """Base con token staff reale: questi test passano dall'HTTP vero."""

    scopes = ["team"]

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="titolare@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Team", scopes=self.scopes)
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }

    def operator_payload(self, **overrides):
        payload = {
            "first_name": "Giulia",
            "last_name": "Rossi",
            "color": "#A5B4FC",
            "cycle_weeks": 1,
            "order": 0,
        }
        payload.update(overrides)
        return payload

    def put_operator(self, operator, **overrides):
        return self.client.put(
            f"/api/staff/{operator.id}",
            data=self.operator_payload(**overrides),
            content_type="application/json",
            **self.auth,
        )


class OperatorValidationTests(StaffApiTestCase):
    """Colore, ciclo e ordine fuori range sono 400, non errori del database."""

    def test_invalid_color_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(color="viola"),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(Operator.objects.exists())

    def test_zero_cycle_weeks_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(cycle_weeks=0),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_absurd_cycle_weeks_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(cycle_weeks=100000),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_negative_order_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(order=-3),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_valid_payload_creates_the_operator(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(cycle_weeks=2),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Operator.objects.get().cycle_weeks, 2)

    def test_a_user_cannot_be_linked_to_two_operators(self):
        first = Operator.objects.create(
            salon=self.salon, first_name="Anna", last_name="Bianchi", user=self.user
        )
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(user_id=self.user.id),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("Anna", res.json()["detail"])
        self.assertEqual(Operator.objects.count(), 1)
        first.refresh_from_db()
        self.assertEqual(first.user_id, self.user.id)


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


class PerformanceSeriesTests(TestCase):
    """La serie di rendimento non deve poter essere allungata a piacere."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi"
        )

    def test_months_are_capped(self):
        from .services import MAX_PERFORMANCE_MONTHS, performance_series

        series = performance_series(self.operator, months=5_000_000)
        self.assertEqual(len(series), MAX_PERFORMANCE_MONTHS)

    def test_months_below_one_fall_back_to_one(self):
        from .services import performance_series

        self.assertEqual(len(performance_series(self.operator, months=0)), 1)

    def test_series_is_built_with_a_bounded_number_of_queries(self):
        from .services import performance_series

        with self.assertNumQueries(1):
            series = performance_series(self.operator, months=24)
        self.assertEqual(len(series), 24)
        self.assertEqual(series[-1]["month"], timezone.localdate().strftime("%Y-%m"))


class OperatorListQueryCountTests(StaffApiTestCase):
    """La lista operatrici è la pagina che il salone tiene aperta tutto il
    giorno: il numero di query non deve crescere con le operatrici."""

    scopes = ["team", "agenda"]

    def _make_operators(self, how_many):
        for index in range(how_many):
            operator = Operator.objects.create(
                salon=self.salon, first_name=f"Op{index}", last_name="Rossi"
            )
            WeeklyShift.objects.create(
                operator=operator, week_index=0, weekday=1, start_min=540, end_min=1080
            )

    def _count_queries(self, expected_rows):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as captured:
            res = self.client.get("/api/staff/", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()), expected_rows)
        return len(captured)

    def test_query_count_does_not_grow_with_the_team(self):
        self._make_operators(2)
        with_two = self._count_queries(2)
        self._make_operators(6)
        with_eight = self._count_queries(8)
        self.assertEqual(with_two, with_eight)

    def test_list_works_without_salon_settings(self):
        self._make_operators(1)
        res = self.client.get("/api/staff/", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()), 1)
        self.assertIn("on_shift", res.json()[0])
