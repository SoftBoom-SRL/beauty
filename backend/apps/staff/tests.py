"""Test essenziali: shift_windows (turno normale, con pausa, con assenza, cycle_weeks=2)
e l'endpoint pubblico /public/operators (scelta stilista in prenotazione)."""

import datetime as dt
from decimal import Decimal

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

    def test_contiguous_shift_rows_become_one_window(self):
        """9–13 e 13–18 sono lo stesso turno spezzato in due righe: un servizio
        che attraversa le 13 deve poter entrare."""
        day = dt.date(2026, 9, 22)  # martedì, week_index calcolato sotto
        from .services import _week_index

        week_index = _week_index(day, 2)
        WeeklyShift.objects.create(
            operator=self.operator, week_index=week_index, weekday=day.weekday(),
            start_min=9 * 60, end_min=13 * 60,
        )
        WeeklyShift.objects.create(
            operator=self.operator, week_index=week_index, weekday=day.weekday(),
            start_min=13 * 60, end_min=18 * 60,
        )
        self.assertEqual(shift_windows(self.operator, day), [(9 * 60, 18 * 60)])

    def test_a_real_lunch_break_still_splits_the_window(self):
        day = dt.date(2026, 9, 22)
        from .services import _week_index

        WeeklyShift.objects.create(
            operator=self.operator, week_index=_week_index(day, 2), weekday=day.weekday(),
            start_min=9 * 60, end_min=18 * 60,
            break_start_min=13 * 60, break_end_min=14 * 60,
        )
        self.assertEqual(
            shift_windows(self.operator, day), [(9 * 60, 13 * 60), (14 * 60, 18 * 60)]
        )
