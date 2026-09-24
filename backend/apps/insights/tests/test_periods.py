"""Insight: riaggancio, nuovi clienti, tassi, giorni chiusi, permesso, date.

Caccia ai bug del 22/09: 08-04, 08-05, 08-06, 08-16, 15-14 (contratto C10),
15-17 + 17-11 (contratto C11).
"""

from datetime import date, datetime, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.sales.models import Sale
from apps.staff.models import Operator, WeeklyShift
from common.auth import create_staff_tokens

from ..services import custom_range, kpis, occupancy_by_weekday, period_range


def _aware(y, m, d, h=10, mi=0):
    return timezone.make_aware(datetime(y, m, d, h, mi))


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.op = Operator.objects.create(salon=self.salon, first_name="Op", last_name="X")
        self._n = 0

    def _client(self, name="Anna", **kwargs):
        self._n += 1
        return Client.objects.create(
            salon=self.salon, first_name=name, phone=f"+39333111{self._n:04d}", **kwargs
        )

    def _appt(self, client, start, status="closed", booked_at=None):
        appt = Appointment.objects.create(
            salon=self.salon, client=client, operator=self.op, start=start, status=status
        )
        if booked_at is not None:
            Appointment.objects.filter(pk=appt.pk).update(created_at=booked_at)
        return appt


class RebookingOfPastPeriodsTests(_Base):
    """08-04: il riaggancio di un periodo passato era ~0 % per costruzione."""

    def test_a_return_visit_booked_within_the_period_counts_even_once_closed(self):
        anna = self._client()
        self._appt(anna, _aware(2025, 8, 20))
        # prenotata alla visita di agosto, fatta e chiusa il 10/9
        self._appt(anna, _aware(2025, 9, 10), booked_at=_aware(2025, 8, 20, 11))
        self.assertEqual(kpis(self.salon, "month", date(2025, 8, 15))["rebooking_rate"], 1.0)

    def test_a_visit_booked_after_the_period_does_not_count(self):
        # come per il periodo in corso, che non può contare prenotazioni non
        # ancora fatte: altrimenti il passato risulta sempre migliore
        anna = self._client()
        self._appt(anna, _aware(2025, 8, 20))
        self._appt(anna, _aware(2025, 9, 20), booked_at=_aware(2025, 9, 5))
        self.assertEqual(kpis(self.salon, "month", date(2025, 8, 15))["rebooking_rate"], 0)

    def test_a_cancelled_or_missed_return_visit_does_not_count(self):
        anna, bea = self._client("Anna"), self._client("Bea")
        for client, status in ((anna, "cancelled"), (bea, "no_show")):
            self._appt(client, _aware(2025, 8, 20))
            self._appt(client, _aware(2025, 9, 10), status=status, booked_at=_aware(2025, 8, 20, 11))
        self.assertEqual(kpis(self.salon, "month", date(2025, 8, 15))["rebooking_rate"], 0)


class NewClientsAreRealNewCustomersTests(_Base):
    """08-05: import e sync timbravano `since` a oggi e tutti diventavano «nuovi»."""

    def test_an_imported_address_book_is_not_new_and_the_old_client_is_returning(self):
        today = timezone.localdate()
        imported = [self._client(f"C{i}", since=today) for i in range(50)]
        old = imported[0]
        self._appt(old, timezone.now() - timedelta(days=365))
        self._appt(old, timezone.now().replace(hour=9, minute=0))
        result = kpis(self.salon, "month", today)
        self.assertEqual(result["new_clients"], 0)
        self.assertEqual(result["returning_clients"], 1)

    def test_a_client_is_new_in_the_month_of_her_first_visit_not_of_her_signup(self):
        # iscritta dall'app il 25/7, prima visita il 10/8
        anna = self._client(since=date(2025, 7, 25))
        self._appt(anna, _aware(2025, 8, 10))
        self.assertEqual(kpis(self.salon, "month", date(2025, 7, 1))["new_clients"], 0)
        august = kpis(self.salon, "month", date(2025, 8, 1))
        self.assertEqual(august["new_clients"], 1)
        self.assertEqual(august["returning_clients"], 0)

    def test_a_declared_historic_since_keeps_the_client_returning(self):
        # scheda di carta ricopiata: «cliente dal 2019», prima visita in youty ad agosto
        carla = self._client("Carla", since=date(2019, 3, 1))
        self._appt(carla, _aware(2025, 8, 10))
        august = kpis(self.salon, "month", date(2025, 8, 1))
        self.assertEqual(august["new_clients"], 0)
        self.assertEqual(august["returning_clients"], 1)

    def test_cancelled_and_missed_bookings_are_not_a_first_visit(self):
        anna, bea = self._client("Anna"), self._client("Bea")
        self._appt(anna, _aware(2025, 7, 10), status="cancelled")
        self._appt(bea, _aware(2025, 7, 12), status="no_show")
        for client in (anna, bea):
            self._appt(client, _aware(2025, 8, 10))
        self.assertEqual(kpis(self.salon, "month", date(2025, 7, 1))["new_clients"], 0)
        self.assertEqual(kpis(self.salon, "month", date(2025, 8, 1))["new_clients"], 2)

    def test_a_deposit_paid_ahead_is_not_a_first_purchase(self):
        anna = self._client()
        visit = self._appt(anna, _aware(2025, 8, 10))
        deposit = Sale.objects.create(
            salon=self.salon, kind="pos", client=anna, deposit_appointment=visit, total=Decimal("30")
        )
        Sale.objects.filter(pk=deposit.pk).update(created_at=_aware(2025, 7, 28))
        self.assertEqual(kpis(self.salon, "month", date(2025, 7, 1))["new_clients"], 0)
        self.assertEqual(kpis(self.salon, "month", date(2025, 8, 1))["new_clients"], 1)


class RatesOnElapsedAppointmentsTests(_Base):
    """08-06: i futuri del periodo non possono ancora essere no-show."""

    def test_future_appointments_do_not_dilute_the_rates(self):
        anna = self._client()
        now = timezone.now()
        for i in range(4):
            self._appt(anna, now - timedelta(hours=10 + i), status="closed")
        for i in range(4):
            self._appt(anna, now - timedelta(hours=20 + i), status="no_show")
        for i in range(2):
            self._appt(anna, now - timedelta(hours=30 + i), status="cancelled")
        for i in range(10):
            self._appt(anna, now + timedelta(minutes=30 + i), status="confirmed")
        self._appt(anna, now + timedelta(minutes=45), status="cancelled")
        result = kpis(self.salon, "year", timezone.localdate())
        self.assertEqual(result["noshow_rate"], 0.4)
        self.assertEqual(result["cancel_rate"], 0.2)

    def test_a_past_period_keeps_all_its_appointments(self):
        anna = self._client()
        self._appt(anna, _aware(2025, 8, 5), status="no_show")
        self._appt(anna, _aware(2025, 8, 6), status="closed")
        self.assertEqual(kpis(self.salon, "month", date(2025, 8, 1))["noshow_rate"], 0.5)


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


class InsightsScopeTests(TestCase):
    """15-17 + 17-11 / contratto C11: «Analisi dati» apre gli insight."""

    URLS = (
        "/api/insights/kpis",
        "/api/insights/revenue-series",
        "/api/insights/revenue-by-category",
        "/api/insights/occupancy-by-weekday",
    )

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="S", slug="s")

        def member(email, scopes=None, owner=False):
            user = User.objects.create_user(email=email, password="pw-lunga-123")
            role = Role.objects.create(salon=self.salon, name=email, scopes=scopes) if scopes is not None else None
            Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=owner)
            return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

        self.owner = member("own@x.it", owner=True)
        self.manager = member("manager@x.it", ["insights"])
        self.front_desk = member("desk@x.it", ["agenda", "clients", "sales"])

    def test_the_insights_scope_opens_every_endpoint(self):
        for auth in (self.owner, self.manager):
            for url in self.URLS:
                with self.subTest(url=url):
                    self.assertEqual(self.client.get(url, **auth).status_code, 200)
            ask = self.client.post(
                "/api/insights/ask", data={"question": "?"}, content_type="application/json", **auth
            )
            self.assertEqual(ask.status_code, 501)

    def test_without_the_scope_they_stay_closed(self):
        for url in self.URLS:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url, **self.front_desk).status_code, 403)
        ask = self.client.post(
            "/api/insights/ask", data={"question": "?"}, content_type="application/json", **self.front_desk
        )
        self.assertEqual(ask.status_code, 403)


class ImpossibleDatesTests(TestCase):
    """08-16: date inesistenti o fuori scala → 400, non 500."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="S", slug="s")
        user = User.objects.create_user(email="own@x.it", password="pw-lunga-123")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.client.raise_request_exception = False

    def test_the_endpoints_answer_400(self):
        queries = (
            "date=2026-02-30",
            "date_from=2026-02-30&date_to=2026-03-02",
            "date_from=0001-01-01&date_to=0001-01-05",
            "period=year&date=9999-06-01",
            "period=month&date=9999-12-01",
            "date_from=9999-12-30&date_to=9999-12-31",
        )
        for url in (
            "/api/insights/kpis",
            "/api/insights/revenue-series",
            "/api/insights/revenue-by-category",
            "/api/insights/occupancy-by-weekday",
        ):
            for query in queries:
                with self.subTest(url=url, query=query):
                    self.assertEqual(self.client.get(f"{url}?{query}", **self.auth).status_code, 400)

    def test_the_services_refuse_out_of_range_dates(self):
        for call in (
            lambda: period_range("year", date(9999, 6, 1)),
            lambda: period_range("month", date(1, 1, 1)),
            lambda: custom_range(date(1, 1, 1), date(1, 1, 5)),
        ):
            with self.assertRaises(HttpError):
                call()
        # le date plausibili restano valide
        period_range("year", date(2999, 6, 1))
        custom_range(date(1900, 1, 1), date(1900, 1, 5))
