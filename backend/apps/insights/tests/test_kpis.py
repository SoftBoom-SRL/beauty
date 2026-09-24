"""KPI degli insight: fatturato e scontrini (caparre comprese), clienti nuovi
e di ritorno, riaggancio, tassi di no-show e disdetta, clienti per categoria,
il permesso «Analisi dati».

Caccia del 22/09:
- 08-04: il riaggancio di un periodo passato era ~0 % per costruzione;
- 08-05: import e sync timbravano `since` a oggi e tutti diventavano «nuovi»;
- 08-06: i futuri del periodo non possono ancora essere no-show;
- 15-17 + 17-11 (contratto C11): «Analisi dati» apre gli insight.
"""

from datetime import date, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.sales.models import Sale, SaleLine
from apps.staff.models import Operator
from common.auth import create_staff_tokens

from ..services import kpis, occupancy_by_weekday, revenue_by_category, revenue_series
from .base import _Base, _aware


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
        # senza turni nessun giorno ha capacità: null, non 0 % (contratto C10)
        self.assertTrue(all(row["occupancy_pct"] is None for row in result))

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
        # Il «cliente dal» di una cliente storica vince sulla sua prima visita in
        # youty; una scheda senza visite né acquisti non è una cliente acquisita,
        # qualunque data porti (l'import la timbrava a oggi: 08-05).
        from apps.staff.models import Operator

        operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")
        visit = timezone.make_aware(
            timezone.datetime.combine(self.today, timezone.datetime.min.time())
        ).replace(hour=10)
        dora = self._client("Dora", since=self.today)
        elsa = self._client("Elsa", since=self.today.replace(year=self.today.year - 3, day=1))
        self._client("Fede", since=self.today)  # in rubrica da oggi, mai venuta
        for client in (dora, elsa):
            Appointment.objects.create(
                salon=self.salon, client=client, operator=operator, start=visit, status="closed"
            )
        result = kpis(self.salon, "month", self.today)
        self.assertEqual(result["new_clients"], 1)
        self.assertEqual(result["returning_clients"], 1)


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
