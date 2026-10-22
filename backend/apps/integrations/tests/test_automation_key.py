"""Chiave per n8n/Make/Zapier: lo strumento esterno legge gli appuntamenti in arrivo."""

import datetime as dt
from urllib.parse import urlencode

from apps.agenda.models import Appointment
from apps.agenda.tests.base import RealShiftsTestBase
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import automation_key
from common.testing import aware

URL = "/api/integrations/automation/appointments"


class AutomationKeyTest(RealShiftsTestBase):
    def setUp(self):
        self.key = automation_key.rotate_key(self.salon, None)

    def fetch(self, start, end, key=None):
        query = urlencode({"start": start.isoformat(), "end": end.isoformat()})
        return self.client.get(f"{URL}?{query}", HTTP_AUTHORIZATION=f"Bearer {key or self.key}")

    def test_lists_appointments_in_window_with_services_and_phone(self):
        inside = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.book(self.bea, self.giulia, aware(self.day, 11), [(self.man60, 60, 0)])  # fuori: end escluso

        response = self.fetch(aware(self.day, 10), aware(self.day, 11))

        self.assertEqual(response.status_code, 200)
        [row] = response.json()
        self.assertEqual(row["appointment_id"], inside.id)
        self.assertEqual(row["phone"], "+393330000001")
        self.assertEqual(row["services"][0]["name"], "Taglio")
        self.assertEqual(row["services"][0]["id"], self.cut30.id)

    def test_cancelled_and_no_show_are_left_out(self):
        for hour, status in ((10, Appointment.Status.CANCELLED), (11, Appointment.Status.NO_SHOW)):
            appointment = self.book(self.anna, self.giulia, aware(self.day, hour), [(self.cut30, 30, 0)])
            Appointment.objects.filter(pk=appointment.pk).update(status=status)

        self.assertEqual(self.fetch(aware(self.day, 9), aware(self.day, 12)).json(), [])

    def test_a_key_sees_only_its_own_salon(self):
        # La chiave di un altro salone non deve leggere l'agenda di questo.
        other = Salon.objects.create(name="Altro", slug="altro-automation")
        Client.objects.create(salon=other, first_name="X", last_name="Y", phone="+393330000009")
        other_key = automation_key.rotate_key(other, None)
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])

        self.assertEqual(self.fetch(aware(self.day, 9), aware(self.day, 12), key=other_key).json(), [])

    def test_wrong_rotated_or_revoked_key_is_refused(self):
        start, end = aware(self.day, 9), aware(self.day, 12)
        self.assertEqual(self.fetch(start, end, key="yta_sbagliata").status_code, 401)

        old = self.key
        self.key = automation_key.rotate_key(self.salon, None)
        self.assertEqual(self.fetch(start, end, key=old).status_code, 401)
        self.assertEqual(self.fetch(start, end).status_code, 200)

        automation_key.revoke_key(self.salon, None)
        self.assertEqual(self.fetch(start, end).status_code, 401)

    def test_window_over_seven_days_or_malformed_is_rejected(self):
        start = aware(self.day, 9)
        self.assertEqual(self.fetch(start, start - dt.timedelta(hours=1)).status_code, 400)
        self.assertEqual(self.fetch(start, start + dt.timedelta(days=8)).status_code, 400)
        response = self.client.get(f"{URL}?start=ieri&end=oggi", HTTP_AUTHORIZATION=f"Bearer {self.key}")
        self.assertEqual(response.status_code, 400)

    def test_managing_the_key_needs_the_integrations_permission(self):
        desk = self.staff_auth(("agenda",))
        self.assertEqual(self.client.post("/api/integrations/automation/key", **desk).status_code, 403)

        tech = self.staff_auth(("integrations",), email="tech@caccia22.it")
        response = self.client.post("/api/integrations/automation/key", **tech)
        self.assertEqual(response.status_code, 200)
        new_key = response.json()["key"]
        self.assertTrue(new_key.startswith("yta_"))
        # La chiave si vede solo alla generazione.
        self.assertIsNone(self.client.get("/api/integrations/automation/key", **tech).json()["key"])
        self.assertEqual(self.fetch(aware(self.day, 9), aware(self.day, 12), key=new_key).status_code, 200)
