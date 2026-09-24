"""Basi comuni ai test dello staff.

- `StaffApiTestCase`: un membro col permesso «team» (o gli `scopes` della
  classe) e un token staff vero, per i test che passano dall'HTTP;
- `_StaffSetup`: salone con due servizi, Anna e Bea (col costo orario) e una
  cliente; `_member` crea un membro coi permessi dati, `_visit` una visita
  con più servizi e operatrici.
"""

from decimal import Decimal

from django.test import TestCase

from apps.accounts.models import Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..models import Operator


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


def bearer(user, salon):
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


class _StaffSetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.color = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Colore", duration_min=60, price=Decimal("60")
        )
        self.cut = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Taglio", duration_min=30, price=Decimal("30")
        )
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="A")
        self.bea = Operator.objects.create(
            salon=self.salon, first_name="Bea", last_name="B", hourly_cost=Decimal("18.50")
        )
        self.xenia = Client.objects.create(salon=self.salon, first_name="Xenia", phone="+393331112233")

    def _member(self, email, scopes=None, owner=False):
        user = User.objects.create_user(email=email, password="x-Segreta-1")
        role = None
        if scopes is not None:
            role = Role.objects.create(salon=self.salon, name=email, scopes=scopes)
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=owner)
        return bearer(user, self.salon)

    def _visit(self, start, items):
        """Visita con i servizi dati come [(servizio, operatrice), …]; la principale è la prima."""
        appt = Appointment.objects.create(
            salon=self.salon, client=self.xenia, operator=items[0][1], start=start
        )
        for order, (service, operator) in enumerate(items):
            AppointmentService.objects.create(
                appointment=appt, service=service, operator=operator,
                duration_min=service.duration_min, price=service.price, order=order,
            )
        return appt
