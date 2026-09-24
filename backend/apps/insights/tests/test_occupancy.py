"""Occupazione: minuti prenotati sulla capacità dei turni, per giorno della
settimana e nel periodo, con i giorni chiusi a null.

Caccia del 22/09:
- 15-14 (contratto C10): un giorno senza capacità è null, non 0 %.
"""

from datetime import date

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.staff.models import Operator, WeeklyShift
from common.auth import create_staff_tokens

from ..services import kpis, occupancy_by_weekday
from .base import _Base, _aware


class OccupancyStatusTests(TestCase):
    """Check-in e trattamento in corso occupano la poltrona come un confermato:
    l'occupazione non deve scendere quando la cliente arriva."""

    def setUp(self):
        from apps.staff.models import WeeklyShift

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Piega", duration_min=60, price=25
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")
        WeeklyShift.objects.create(operator=operator, week_index=0, weekday=2, start_min=540, end_min=1020)
        client = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )
        self.day = date(2026, 7, 1)  # mercoledì
        start = timezone.make_aware(timezone.datetime(2026, 7, 1, 10, 0))
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=client, operator=operator, start=start, status="confirmed"
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=service, operator=operator, duration_min=60, price=25
        )

    def _wednesday_pct(self):
        rows = occupancy_by_weekday(self.salon, "month", self.day)
        return next(r["occupancy_pct"] for r in rows if r["weekday"] == 2)

    def test_check_in_and_in_progress_keep_the_slot_occupied(self):
        confirmed = self._wednesday_pct()
        self.assertGreater(confirmed, 0)
        for status in ("checked_in", "in_progress", "closed"):
            self.appointment.status = status
            self.appointment.save(update_fields=["status"])
            self.assertEqual(self._wednesday_pct(), confirmed, status)
        self.appointment.status = "cancelled"
        self.appointment.save(update_fields=["status"])
        self.assertEqual(self._wednesday_pct(), 0)


class ShiftCapacityQueryBudgetTests(TestCase):
    """La capacità dei turni non deve interrogare il database giorno per giorno.

    Senza precaricare turni, assenze e impostazioni, una sola operatrice su
    trenta giorni costava 63 query: il conto cresceva con operatrici × giorni.
    """

    def setUp(self):
        from apps.core.models import SalonSettings

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        SalonSettings.objects.create(salon=self.salon)
        self.operators = [
            Operator.objects.create(salon=self.salon, first_name=f"Op{n}", last_name="Rossi")
            for n in range(3)
        ]

    def test_thirty_days_and_three_operators_cost_a_handful_of_queries(self):
        from datetime import timedelta

        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from ..services import _daily_shift_minutes

        start = timezone.localdate()
        days = [start + timedelta(days=i) for i in range(30)]
        with CaptureQueriesContext(connection) as captured:
            _daily_shift_minutes(self.salon, days)
        # Una lettura per operatrici, turni e assenze: il numero di giorni non
        # entra nel conto.
        self.assertLessEqual(len(captured), 5, [q["sql"] for q in captured])


class OccupancyAfterStaffChangesTests(TestCase):
    """L'occupazione di una giornata già chiusa non deve cambiare quando
    un'operatrice viene disattivata: i suoi appuntamenti restano fra i minuti
    prenotati, quindi il suo turno deve restare nella capacità.
    Difetto della caccia ai bug del 21/09/2026 (B22)."""

    def setUp(self):
        from apps.staff.models import WeeklyShift

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Piega", duration_min=180, price=60
        )
        client = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )
        self.day = date(2026, 7, 1)  # mercoledì
        self.operators = []
        for index, name in enumerate(("Sofia", "Marta")):
            operator = Operator.objects.create(salon=self.salon, first_name=name, last_name="Ricci")
            # turno 9–18 = 540 minuti di capacità a testa
            WeeklyShift.objects.create(
                operator=operator, week_index=0, weekday=2, start_min=540, end_min=1080
            )
            appointment = Appointment.objects.create(
                salon=self.salon, client=client, operator=operator,
                start=timezone.make_aware(timezone.datetime(2026, 7, 1, 10 + index * 4, 0)),
                status="closed",
            )
            AppointmentService.objects.create(
                appointment=appointment, service=service, operator=operator,
                duration_min=180, price=60,
            )
            self.operators.append(operator)

    def _pct(self):
        return kpis(self.salon, "custom", date_from=self.day, date_to=self.day)["occupancy_pct"]

    def test_deactivating_a_stylist_does_not_rewrite_a_closed_day(self):
        before = self._pct()
        self.assertAlmostEqual(before, 33.3, places=1)   # 360' su 1.080'
        self.operators[1].active = False
        self.operators[1].save(update_fields=["active"])
        self.assertAlmostEqual(self._pct(), before, places=1)

    def test_an_inactive_stylist_without_work_does_not_count_as_capacity(self):
        from apps.staff.models import WeeklyShift

        idle = Operator.objects.create(
            salon=self.salon, first_name="Lucia", last_name="Neri", active=False
        )
        WeeklyShift.objects.create(operator=idle, week_index=0, weekday=2, start_min=540, end_min=1080)
        self.assertAlmostEqual(self._pct(), 33.3, places=1)


class ClosedWeekdaysTests(_Base):
    """15-14 / contratto C10: un giorno senza capacità è null, non 0 %."""

    def test_closed_days_are_null_and_open_empty_days_are_zero(self):
        for weekday in range(6):  # lun–sab, domenica chiuso
            WeeklyShift.objects.create(
                operator=self.op, week_index=0, weekday=weekday, start_min=540, end_min=1140
            )
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="C")
        svc = Service.objects.create(salon=self.salon, category=cat, name_it="P", duration_min=60, price=25)
        appt = self._appt(self._client(), _aware(2025, 7, 2), status="confirmed")  # mercoledì
        AppointmentService.objects.create(
            appointment=appt, service=svc, operator=self.op, duration_min=60, price=25
        )
        rows = {r["weekday"]: r["occupancy_pct"] for r in occupancy_by_weekday(self.salon, "month", date(2025, 7, 1))}
        self.assertIsNone(rows[6])
        self.assertEqual(rows[0], 0)
        self.assertGreater(rows[2], 0)

    def test_the_api_serialises_null(self):
        from apps.accounts.models import Membership, User

        user = User.objects.create_user(email="own@x.it", password="pw-lunga-123")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        resp = self.client.get("/api/insights/occupancy-by-weekday?period=month&date=2025-07-01", **auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual([row["occupancy_pct"] for row in resp.json()], [None] * 7)
