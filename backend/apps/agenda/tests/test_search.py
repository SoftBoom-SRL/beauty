"""Ricerca degli appuntamenti per nome o telefono della cliente (barra in alto)."""

import datetime as dt

from django.utils import timezone

from apps.clients.models import Client
from common.testing import aware

from ..models import Appointment
from ..services.appointments import create_appointment
from ..services.search import search_appointments
from .base import WIDE, AgendaTestBase


class AppointmentSearchTests(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="cerca@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Reception di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        from common.auth import create_staff_tokens

        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.other = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Neri", phone="+393331234567"
        )

    def _book(self, client, day, hour, items=None):
        with self._windows({self.op1.id: WIDE}):
            return create_appointment(
                self.salon, client,
                items or [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                aware(day, hour), via="dashboard", force=True,
            )

    def test_prima_le_prossime_poi_le_passate(self):
        today = timezone.localdate()
        past = self._book(self.client_obj, today - dt.timedelta(days=10), 10)
        older = self._book(self.client_obj, today - dt.timedelta(days=20), 10)
        later = self._book(self.client_obj, today + dt.timedelta(days=9), 10)
        soon = self._book(self.client_obj, today + dt.timedelta(days=2), 10)
        self._book(self.other, today + dt.timedelta(days=2), 15)

        found = search_appointments(self.salon, "sofia ricci")
        self.assertEqual([a.id for a in found], [soon.id, later.id, past.id, older.id])

    def test_per_telefono_scritto_con_spazi(self):
        appt = self._book(self.other, timezone.localdate() + dt.timedelta(days=3), 11)
        self._book(self.client_obj, timezone.localdate() + dt.timedelta(days=3), 9)
        found = search_appointments(self.salon, "333 123 4567")
        self.assertEqual([a.id for a in found], [appt.id])

    def test_escluse_annullate_e_tolte_dall_agenda(self):
        day = timezone.localdate() + dt.timedelta(days=4)
        kept = self._book(self.client_obj, day, 9)
        cancelled = self._book(self.client_obj, day, 11)
        removed = self._book(self.client_obj, day, 14)
        Appointment.objects.filter(id=cancelled.id).update(status=Appointment.Status.CANCELLED)
        Appointment.objects.filter(id=removed.id).update(removed_from_agenda_at=timezone.now())
        self.assertEqual([a.id for a in search_appointments(self.salon, "Ricci")], [kept.id])

    def test_ricerca_troppo_corta_non_cerca(self):
        self._book(self.client_obj, timezone.localdate() + dt.timedelta(days=1), 9)
        self.assertEqual(search_appointments(self.salon, "s"), [])

    def test_endpoint_con_servizi_e_operatrice(self):
        appt = self._book(
            self.client_obj, timezone.localdate() + dt.timedelta(days=5), 10,
            items=[
                {"service_id": self.svc60.id, "operator_id": self.op1.id},
                {"service_id": self.svc30.id, "operator_id": self.op1.id},
            ],
        )
        res = self.client.get("/api/agenda/appointments/search", {"q": "Sofia"}, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["id"], appt.id)
        self.assertEqual(body[0]["services"], ["Manicure completa", "Copertura gel"])
        self.assertEqual(body[0]["operator_name"], "Giulia Bianchi")
        self.assertEqual(body[0]["client"]["full_name"], "Sofia Ricci")

    def test_endpoint_solo_del_salone_e_col_permesso(self):
        from apps.accounts.models import Membership, Role, User
        from apps.core.models import Salon
        from common.auth import create_staff_tokens

        self._book(self.client_obj, timezone.localdate() + dt.timedelta(days=5), 10)
        altro = Salon.objects.create(name="Altro", slug="altro-salone")
        user = User.objects.create_user(email="altro@salone.it", password="x" * 10)
        Membership.objects.create(user=user, salon=altro, role=Role.objects.create(salon=altro, name="R", scopes=["agenda"]))
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, altro)['access']}"}
        res = self.client.get("/api/agenda/appointments/search", {"q": "Sofia"}, **auth)
        self.assertEqual(res.json(), [])

        user2 = User.objects.create_user(email="magazzino@theparlour.it", password="x" * 10)
        Membership.objects.create(user=user2, salon=self.salon, role=Role.objects.create(salon=self.salon, name="Mag", scopes=["inventory"]))
        auth2 = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user2, self.salon)['access']}"}
        res = self.client.get("/api/agenda/appointments/search", {"q": "Sofia"}, **auth2)
        self.assertEqual(res.status_code, 403)
