from datetime import date

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.sales.models import Sale, SaleLine
from apps.staff.models import Operator

from .services import (
    custom_range,
    kpis,
    occupancy_by_weekday,
    period_range,
    resolve_range,
    revenue_by_category,
    revenue_series,
)


class PeriodRangeTests(TestCase):
    def test_month(self):
        start, end = period_range("month", date(2026, 7, 15))
        self.assertEqual(start.date(), date(2026, 7, 1))
        self.assertEqual(end.date(), date(2026, 8, 1))

    def test_quarter(self):
        start, end = period_range("quarter", date(2026, 8, 10))
        self.assertEqual(start.date(), date(2026, 7, 1))
        self.assertEqual(end.date(), date(2026, 10, 1))

    def test_quarter_year_boundary(self):
        start, end = period_range("quarter", date(2026, 12, 20))
        self.assertEqual(start.date(), date(2026, 10, 1))
        self.assertEqual(end.date(), date(2027, 1, 1))

    def test_year(self):
        start, end = period_range("year", date(2026, 3, 1))
        self.assertEqual(start.date(), date(2026, 1, 1))
        self.assertEqual(end.date(), date(2027, 1, 1))

    def test_default_date_is_today(self):
        start, end = period_range("month")
        today = timezone.localdate()
        self.assertLessEqual(start.date(), today)
        self.assertGreater(end.date(), today)

    def test_invalid_period_raises_400(self):
        from ninja.errors import HttpError

        with self.assertRaises(HttpError):
            period_range("week")


class CustomRangeTests(TestCase):
    def test_custom_range_end_is_exclusive_next_day(self):
        start, end = custom_range(date(2026, 7, 7), date(2026, 7, 14))
        self.assertEqual(start.date(), date(2026, 7, 7))
        self.assertEqual(end.date(), date(2026, 7, 15))  # end esclusivo = data finale + 1 giorno

    def test_custom_range_from_after_to_raises_400(self):
        from ninja.errors import HttpError

        with self.assertRaises(HttpError):
            custom_range(date(2026, 7, 14), date(2026, 7, 7))

    def test_resolve_range_uses_custom_when_both_dates_given(self):
        start, end = resolve_range("month", None, date(2026, 3, 3), date(2026, 3, 5))
        self.assertEqual(start.date(), date(2026, 3, 3))
        self.assertEqual(end.date(), date(2026, 3, 6))

    def test_resolve_range_falls_back_to_period(self):
        start, end = resolve_range("month", date(2026, 7, 15), None, None)
        self.assertEqual(start.date(), date(2026, 7, 1))
        self.assertEqual(end.date(), date(2026, 8, 1))


class KpisMinimalDatasetTests(TestCase):
    """Nessun KPI deve mai sollevare eccezioni, con dati assenti o minimi."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_kpis_without_any_data(self):
        result = kpis(self.salon, "month")
        self.assertEqual(result["revenue"], 0)
        self.assertEqual(result["sales_count"], 0)
        self.assertEqual(result["avg_ticket"], 0)
        self.assertEqual(result["retail_revenue"], 0)
        self.assertEqual(result["appointments_count"], 0)
        self.assertEqual(result["noshow_rate"], 0)
        self.assertEqual(result["cancel_rate"], 0)
        self.assertEqual(result["occupancy_pct"], 0)
        self.assertEqual(result["return_rate"], 0)
        self.assertEqual(result["rebooking_rate"], 0)
        self.assertEqual(result["new_clients"], 0)
        self.assertEqual(result["returning_clients"], 0)
        self.assertEqual(result["avg_frequency"], 0)
        self.assertEqual(result["clients_by_category"], [])

    def test_revenue_series_and_by_category_without_data(self):
        self.assertEqual(revenue_by_category(self.salon, "month"), [{"category": "Prodotti", "revenue": 0}])
        series = revenue_series(self.salon, "month", "day")
        self.assertTrue(all(point["revenue"] == 0 for point in series))

    def test_occupancy_by_weekday_without_data(self):
        result = occupancy_by_weekday(self.salon, "month")
        self.assertEqual(len(result), 7)
        self.assertTrue(all(row["occupancy_pct"] == 0 for row in result))

    def test_kpis_with_minimal_dataset(self):
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        service = Service.objects.create(
            salon=self.salon,
            category=category,
            name_it="Piega",
            duration_min=30,
            price=25,
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")
        client = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )

        today = timezone.localdate()
        start = timezone.make_aware(timezone.datetime.combine(today, timezone.datetime.min.time()))
        appointment = Appointment.objects.create(
            salon=self.salon,
            client=client,
            operator=operator,
            start=start.replace(hour=10),
            status="closed",
        )
        AppointmentService.objects.create(
            appointment=appointment,
            service=service,
            operator=operator,
            duration_min=30,
            price=25,
        )

        sale = Sale.objects.create(salon=self.salon, kind="checkout", client=client, total=25)
        SaleLine.objects.create(
            sale=sale,
            service=service,
            line_type="service",
            qty=1,
            unit_price=25,
            amount=25,
        )

        result = kpis(self.salon, "month", today)

        self.assertEqual(result["revenue"], 25)
        self.assertEqual(result["sales_count"], 1)
        self.assertEqual(result["avg_ticket"], 25)
        self.assertEqual(result["appointments_count"], 1)
        self.assertEqual(result["avg_frequency"], 1)


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

        from .services import _daily_shift_minutes

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
