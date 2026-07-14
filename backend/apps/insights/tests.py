from datetime import date

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.sales.models import Sale, SaleLine
from apps.staff.models import Operator

from .services import kpis, occupancy_by_weekday, period_range, revenue_by_category, revenue_series


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
