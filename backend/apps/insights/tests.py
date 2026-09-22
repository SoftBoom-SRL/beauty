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

    def test_a_range_of_centuries_is_refused(self):
        # Il selettore non ha un anno minimo: "0202-01-01" sono 666.000 giorni
        # scorsi uno per uno, con un thread del server occupato per minuti.
        from ninja.errors import HttpError

        from .services import MAX_RANGE_DAYS

        with self.assertRaises(HttpError):
            custom_range(date(202, 1, 1), date(2026, 12, 31))
        with self.assertRaises(HttpError):
            custom_range(date(1, 1, 1), date(9999, 12, 31))
        # due anni restano leciti
        start, end = custom_range(date(2025, 1, 1), date(2026, 12, 31))
        self.assertEqual((end.date() - start.date()).days, 730)
        self.assertGreaterEqual(MAX_RANGE_DAYS, 731)


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


class NewClientsTests(TestCase):
    """«Nuovi clienti» era strutturalmente 0: `Client.since` non viene scritta
    dalle schede storiche, e il grafico «Nuovi vs di ritorno» mostrava sempre
    0% / 100%."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.today = timezone.localdate()

    def _client(self, name, **kwargs):
        return Client.objects.create(
            salon=self.salon, first_name=name, last_name="Verdi",
            phone=f"+3933311122{Client.objects.count():02d}", **kwargs
        )

    def test_a_client_without_since_counts_from_her_first_visit(self):
        from apps.staff.models import Operator

        operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")
        client = self._client("Anna")
        self.assertIsNone(client.since)
        start = timezone.make_aware(
            timezone.datetime.combine(self.today, timezone.datetime.min.time())
        ).replace(hour=10)
        Appointment.objects.create(
            salon=self.salon, client=client, operator=operator, start=start, status="closed"
        )
        result = kpis(self.salon, "month", self.today)
        self.assertEqual(result["new_clients"], 1)
        self.assertEqual(result["returning_clients"], 0)

    def test_a_client_without_since_counts_from_her_first_sale(self):
        client = self._client("Bea")
        Sale.objects.create(salon=self.salon, kind="pos", client=client, total=30)
        self.assertEqual(kpis(self.salon, "month", self.today)["new_clients"], 1)

    def test_a_client_of_the_past_is_not_new_and_counts_as_returning(self):
        from datetime import timedelta

        from apps.staff.models import Operator

        operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")
        old = self._client("Carla")
        long_ago = timezone.now() - timedelta(days=400)
        Appointment.objects.create(
            salon=self.salon, client=old, operator=operator, start=long_ago, status="closed"
        )
        now = timezone.now().replace(hour=10, minute=0)
        Appointment.objects.create(
            salon=self.salon, client=old, operator=operator, start=now, status="closed"
        )
        result = kpis(self.salon, "month", self.today)
        self.assertEqual(result["new_clients"], 0)
        self.assertEqual(result["returning_clients"], 1)

    def test_the_declared_since_still_wins(self):
        self._client("Dora", since=self.today)
        self._client("Elsa", since=self.today.replace(year=self.today.year - 3, day=1))
        self.assertEqual(kpis(self.salon, "month", self.today)["new_clients"], 1)


class RebookingRateTests(TestCase):
    """Il riaggancio si misura rispetto al periodo, non rispetto a oggi."""

    def setUp(self):
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")
        self.client_row = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )

    def test_a_visit_already_closed_today_is_not_a_future_booking(self):
        from datetime import timedelta

        now = timezone.now()
        visit = now - timedelta(hours=2)
        Appointment.objects.create(
            salon=self.salon, client=self.client_row, operator=self.operator,
            start=visit, status="closed",
        )
        # nessun altro appuntamento: il riaggancio è 0, non 1
        self.assertEqual(kpis(self.salon, "month", visit.date())["rebooking_rate"], 0)
        Appointment.objects.create(
            salon=self.salon, client=self.client_row, operator=self.operator,
            start=now + timedelta(days=20), status="confirmed",
        )
        self.assertEqual(kpis(self.salon, "month", visit.date())["rebooking_rate"], 1.0)


class ClientsByCategoryTests(TestCase):
    """«Clienti per categoria» seguiva l'anagrafica intera e non cambiava mai
    con il periodo scelto, accanto a KPI che invece cambiavano."""

    def test_only_the_clients_of_the_period_are_counted(self):
        from datetime import timedelta

        from apps.clients.models import ClientCategory
        from apps.staff.models import Operator

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        vip = ClientCategory.objects.create(salon=salon, name="VIP")
        operator = Operator.objects.create(salon=salon, first_name="Sofia", last_name="Ricci")
        recent = Client.objects.create(salon=salon, first_name="Anna", phone="+393331112233")
        dormant = Client.objects.create(salon=salon, first_name="Bea", phone="+393331112244")
        recent.categories.add(vip)
        dormant.categories.add(vip)
        Appointment.objects.create(
            salon=salon, client=recent, operator=operator,
            start=timezone.now().replace(hour=10, minute=0), status="closed",
        )
        Appointment.objects.create(
            salon=salon, client=dormant, operator=operator,
            start=timezone.now() - timedelta(days=400), status="closed",
        )
        rows = kpis(salon, "month")["clients_by_category"]
        self.assertEqual(rows, [{"category": "VIP", "count": 1}])


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
class DepositIsNotCountedTwiceTests(TestCase):
    """La caparra entra in cassa il giorno in cui arriva, e al checkout il
    servizio viene fatturato per intero con l'anticipo detratto.

    Sommando le due vendite, un servizio da 100 con 30 di caparra risultava un
    fatturato di 130 e due scontrini invece di uno.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci"
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now(), status="closed",
            deposit_status="paid", deposit_amount=30,
        )

    def _deposit_sale(self):
        return Sale.objects.create(
            salon=self.salon, kind="pos", client=self.client_obj,
            deposit_appointment=self.appointment, total=30,
        )

    def _checkout_sale(self):
        return Sale.objects.create(
            salon=self.salon, kind="checkout", client=self.client_obj,
            appointment=self.appointment, total=100, deposit_deducted=30,
        )

    def test_the_same_hundred_euros_are_counted_once(self):
        self._deposit_sale()
        self._checkout_sale()
        today = timezone.localdate()
        result = kpis(self.salon, "month", today)
        self.assertEqual(result["revenue"], 100)          # non 130
        self.assertEqual(result["sales_count"], 1)        # un solo scontrino
        self.assertEqual(result["avg_ticket"], 100)
        self.assertEqual(result["deposit_cashed"], 30)
        self.assertEqual(result["deposit_used"], 30)
        self.assertEqual(result["cash_in"], 100)          # 30 + 70 entrati davvero

    def test_a_deposit_alone_is_money_in_but_not_yet_revenue(self):
        self._deposit_sale()
        result = kpis(self.salon, "month", timezone.localdate())
        self.assertEqual(result["revenue"], 0)
        self.assertEqual(result["sales_count"], 0)
        self.assertEqual(result["cash_in"], 30)

    def test_the_revenue_chart_leaves_the_deposit_sale_out(self):
        self._deposit_sale()
        self._checkout_sale()
        today = timezone.localdate()
        series = revenue_series(self.salon, "month", "day", today)
        of_today = [point for point in series if point["date"] == today]
        self.assertEqual(len(of_today), 1)
        self.assertEqual(of_today[0]["revenue"], 100)
