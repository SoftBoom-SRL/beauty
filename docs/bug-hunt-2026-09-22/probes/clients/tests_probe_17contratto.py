"""PROBE temporaneo del revisore 17 (contratto frontend/backend). DA CANCELLARE."""

import datetime as dt
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from common.auth import create_staff_tokens


class Probe17HistoryWithoutSales(TestCase):
    def test_closed_visit_seen_by_operatrice(self):
        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.sales.models import Sale
        from apps.staff.models import Operator

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="op17@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=salon, name="Operatrice", scopes=["agenda", "clients"])
        Membership.objects.create(user=user, salon=salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}
        client = Client.objects.create(salon=salon, first_name="Sofia", last_name="Ricci", phone="+393331112222")
        cat = ServiceCategory.objects.create(salon=salon, name_it="Capelli")
        svc = Service.objects.create(salon=salon, category=cat, name_it="Piega", duration_min=60, price=Decimal("50.00"))
        op = Operator.objects.create(salon=salon, first_name="Giulia", last_name="B")
        appt = Appointment.objects.create(
            salon=salon, client=client, operator=op, start=timezone.now() - dt.timedelta(days=3), status="closed",
        )
        AppointmentService.objects.create(appointment=appt, service=svc, operator=op, duration_min=60, price=Decimal("50.00"))
        Sale.objects.create(salon=salon, kind="checkout", appointment=appt, client=client, total=Decimal("50.00"))
        res = self.client.get(f"/api/clients/{client.id}/history", **auth)
        data = res.json()
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        print("\n[probe17] storico visto da Operatrice:", res.status_code, "status:", visit["appointment"]["status"],
              "sale:", visit["sale"], "chiavi top:", sorted(data.keys()))
        self.assertIsNone(visit["sale"])
