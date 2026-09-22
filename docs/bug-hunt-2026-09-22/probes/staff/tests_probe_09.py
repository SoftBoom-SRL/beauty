"""PROBE TEMPORANEO revisore 09 — da cancellare."""

import datetime as dt
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Location, Salon
from apps.sales.models import Sale, SaleLine
from common.auth import create_client_tokens, create_staff_tokens

from .models import Operator, WeeklyShift
from .services import served_clients, today_clients_by_operator


class ProbeStaffExposure(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.svc = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Piega", duration_min=30, price=Decimal("30")
        )
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="A")
        self.bea = Operator.objects.create(
            salon=self.salon, first_name="Bea", last_name="B", hourly_cost=Decimal("18.50")
        )
        self.client_x = Client.objects.create(salon=self.salon, first_name="Xenia", phone="+393331112233")
        past = timezone.now() - dt.timedelta(days=1)
        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_x, operator=self.bea, start=past
        )
        AppointmentService.objects.create(
            appointment=appt, service=self.svc, operator=self.bea, duration_min=30, price=Decimal("30")
        )
        sale = Sale.objects.create(salon=self.salon, kind="pos", client=self.client_x, total=Decimal("250"))
        SaleLine.objects.create(
            sale=sale, operator=self.bea, line_type="service", qty=1,
            unit_price=Decimal("250"), amount=Decimal("250"),
        )
        user = User.objects.create_user(email="junior@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Operatrice", scopes=["agenda", "clients"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def test_junior_reads_cash_data(self):
        listing = self.client.get("/api/staff/", **self.auth)
        self.assertEqual(listing.status_code, 200, listing.content)
        bea = next(o for o in listing.json() if o["id"] == self.bea.id)
        print("\n[probe] /api/staff/ Bea:", bea["month_revenue"], bea["hourly_cost"])

        perf = self.client.get(f"/api/staff/{self.bea.id}/performance?months=36", **self.auth)
        self.assertEqual(perf.status_code, 200, perf.content)
        print("[probe] performance mesi:", len(perf.json()), "ultimo:", perf.json()[-1])

        served = self.client.get(f"/api/staff/{self.bea.id}/clients", **self.auth)
        self.assertEqual(served.status_code, 200, served.content)
        print("[probe] served:", served.json())

        detail = self.client.get(f"/api/clients/{self.client_x.id}", **self.auth)
        self.assertEqual(detail.status_code, 200, detail.content)
        print("[probe] scheda cliente:", detail.json().get("total_spent"), detail.json().get("stats_hidden"))

        sales = self.client.get(f"/api/sales/?operator_id={self.bea.id}", **self.auth)
        print("[probe] /api/sales/?operator_id:", sales.status_code)
        self.assertEqual(sales.status_code, 403)
        # I dati negati da sales e dalla scheda cliente passano da /api/staff:
        self.assertEqual(Decimal(bea["month_revenue"]), Decimal("250"))
        self.assertEqual(Decimal(served.json()[0]["total_spent"]), Decimal("250"))
        self.assertEqual(Decimal(detail.json()["total_spent"]), Decimal("0"))


class ProbeSecondaryOperator(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.color = Service.objects.create(
            salon=self.salon, category=cat, name_it="Colore", duration_min=60, price=Decimal("60")
        )
        self.cut = Service.objects.create(
            salon=self.salon, category=cat, name_it="Taglio", duration_min=30, price=Decimal("30")
        )
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="A")
        self.bea = Operator.objects.create(salon=self.salon, first_name="Bea", last_name="B")
        self.x = Client.objects.create(salon=self.salon, first_name="Xenia", phone="+393331112233")

    def _visit(self, start):
        appt = Appointment.objects.create(salon=self.salon, client=self.x, operator=self.anna, start=start)
        AppointmentService.objects.create(
            appointment=appt, service=self.color, operator=self.anna, duration_min=60,
            price=Decimal("60"), order=0,
        )
        AppointmentService.objects.create(
            appointment=appt, service=self.cut, operator=self.bea, duration_min=30,
            price=Decimal("30"), order=1,
        )
        return appt

    def test_bea_does_the_cut_but_is_not_counted(self):
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon)
        counts = today_clients_by_operator([self.anna, self.bea], today)
        print("\n[probe] clienti oggi:", counts)
        self._visit(timezone.now() - dt.timedelta(days=3))
        sale = Sale.objects.create(salon=self.salon, kind="checkout", client=self.x, total=Decimal("90"))
        SaleLine.objects.create(sale=sale, operator=self.bea, line_type="service", qty=1,
                                unit_price=Decimal("30"), amount=Decimal("30"))
        print("[probe] clienti serviti da Bea:", served_clients(self.bea))
        self.assertEqual(counts.get(self.bea.id, 0), 0)
        self.assertEqual(served_clients(self.bea), [])


class ProbePublicOperatorOtherLocation(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.main = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        self.second = Location.objects.create(salon=self.salon, name="Mare")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.svc = Service.objects.create(
            salon=self.salon, category=cat, name_it="Piega", duration_min=30, price=Decimal("30")
        )
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="A",
                                            location=self.main)
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="G",
                                              location=self.second)
        for op in (self.anna, self.giulia):
            op.services.add(self.svc)
            for wd in range(7):
                WeeklyShift.objects.create(operator=op, week_index=0, weekday=wd, start_min=540, end_min=1080)
        self.x = Client.objects.create(salon=self.salon, first_name="Xenia", phone="+393331112233")
        self.cauth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.x)['access']}"}

    def test_client_picks_giulia(self):
        ops = self.client.get(f"/api/staff/public/operators?salon={self.salon.slug}").json()
        print("\n[probe] public operators:", [(o["first_name"], o["service_ids"]) for o in ops])
        day = timezone.localdate() + dt.timedelta(days=7)
        import json
        items = json.dumps([{"service_id": self.svc.id, "operator_id": self.giulia.id}])
        slots = self.client.get(
            "/api/agenda/client/availability", {"date": day.isoformat(), "items": items}, **self.cauth
        )
        self.assertEqual(slots.status_code, 200, slots.content)
        first = slots.json()[0]
        print("[probe] primo slot:", first["start"], first.get("assignment"))
        booked = self.client.post(
            "/api/agenda/client/appointments",
            data={"items": [{"service_id": self.svc.id, "operator_id": self.giulia.id}],
                  "start": first["start"]},
            content_type="application/json",
            **self.cauth,
        )
        print("[probe] prenotazione:", booked.status_code, booked.content[:200])
        self.assertIn(self.giulia.id, [o["id"] for o in ops])
        self.assertEqual(booked.status_code, 400)
