"""Assistente vocale: l'agente Yourang legge servizi e orari e prenota al telefono."""

from apps.agenda.models import Appointment
from apps.agenda.tests.base import RealShiftsTestBase
from apps.clients.models import Client
from apps.core.models import OutboxEvent
from apps.integrations import voice
from common.testing import aware, post_json


class VoiceTestBase(RealShiftsTestBase):
    def setUp(self):
        self.key = voice.rotate_key(self.salon, None)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {self.key}"}

    def services(self):
        return self.client.get("/api/integrations/voice/services", **self.auth)

    def availability(self, services, day=None):
        day = (day or self.day).isoformat()
        return self.client.get(
            f"/api/integrations/voice/availability?date={day}&services={services}", **self.auth
        )

    def book_call(self, **fields):
        body = {
            "date": self.day.isoformat(),
            "time": "10:00",
            "services": f"{self.cut30.id}",
            "customer_name": "Carla Neri",
            "customer_phone": "+39 345 111 2233",
            **fields,
        }
        res = post_json(self.client, "/api/integrations/voice/appointments", body, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()


class VoiceAuthTests(VoiceTestBase):
    def test_without_a_valid_key_the_agent_gets_401(self):
        self.assertEqual(self.client.get("/api/integrations/voice/services").status_code, 401)
        wrong = {"HTTP_AUTHORIZATION": "Bearer yrb_sbagliata"}
        self.assertEqual(self.client.get("/api/integrations/voice/services", **wrong).status_code, 401)

    def test_a_new_key_retires_the_old_one_and_revoking_switches_off(self):
        new_key = voice.rotate_key(self.salon, None)
        self.assertEqual(self.services().status_code, 401)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {new_key}"}
        self.assertEqual(self.services().status_code, 200)
        voice.revoke_key(self.salon, None)
        self.assertEqual(self.services().status_code, 401)

    def test_only_the_owner_manages_the_key(self):
        desk = self.staff_auth(("agenda", "settings"))
        self.assertEqual(self.client.post("/api/integrations/voice/key", **desk).status_code, 403)
        owner = self.staff_auth(email="titolare@caccia22.it", owner=True)
        res = self.client.post("/api/integrations/voice/key", **owner)
        self.assertEqual(res.status_code, 200, res.content)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {res.json()['key']}"}
        self.assertEqual(self.services().status_code, 200)
        status = self.client.get("/api/integrations/voice/key", **owner).json()
        self.assertTrue(status["active"])
        self.assertEqual(self.client.delete("/api/integrations/voice/key", **owner).status_code, 200)
        self.assertFalse(self.client.get("/api/integrations/voice/key", **owner).json()["active"])


class VoiceAvailabilityTests(VoiceTestBase):
    def test_services_are_the_public_price_list(self):
        names = {row["name"] for row in self.services().json()}
        self.assertEqual(names, {"Taglio", "Colore", "Manicure"})

    def test_times_skip_the_slot_where_both_operators_are_busy(self):
        for op, client in ((self.giulia, self.anna), (self.marta, self.bea)):
            self.book(client, op, aware(self.day, 10), [(self.cut30, 30, 0)])
        data = self.availability(self.cut30.id).json()
        self.assertTrue(data["success"])
        self.assertTrue(data["times"])
        self.assertNotIn("10:00", data["times"])
        self.assertEqual(data["date_label"], voice.date_label(self.day))

    def test_a_bad_date_or_service_is_answered_200_for_the_agent(self):
        res = self.client.get(
            "/api/integrations/voice/availability?date=domani&services=1", **self.auth
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["error"], "invalid_request")
        self.assertEqual(self.availability("taglio").json()["error"], "invalid_request")
        self.assertEqual(self.availability(999999).json()["error"], "invalid_request")


class VoiceBookingTests(VoiceTestBase):
    def test_books_a_new_client_through_the_normal_path(self):
        data = self.book_call(notes="Prima volta")
        self.assertTrue(data["success"], data)
        self.assertEqual((data["time"], data["services"]), ("10:00", ["Taglio"]))
        appointment = Appointment.objects.get(id=data["appointment_id"])
        self.assertEqual(appointment.created_via, Appointment.CreatedVia.YOURANG)
        self.assertEqual(appointment.start, aware(self.day, 10))
        self.assertIn("Prima volta", appointment.note)
        self.assertEqual(appointment.client.phone, "+393451112233")
        self.assertEqual((appointment.client.first_name, appointment.client.last_name), ("Carla", "Neri"))
        self.assertTrue(OutboxEvent.objects.filter(event_type="appointment.created").exists())

    def test_finds_an_existing_client_by_phone_written_differently(self):
        data = self.book_call(customer_phone="333 000 0001", customer_name="Anna Rossi")
        self.assertEqual(Appointment.objects.get(id=data["appointment_id"]).client, self.anna)
        self.assertFalse(Client.objects.filter(first_name="Carla").exists())

    def test_a_retry_returns_the_same_appointment(self):
        first = self.book_call()
        again = self.book_call()
        self.assertEqual(first["appointment_id"], again["appointment_id"])
        self.assertEqual(Appointment.objects.filter(salon=self.salon).count(), 1)

    def test_another_time_for_the_same_client_is_a_new_booking(self):
        first = self.book_call()
        second = self.book_call(time="15:00")
        self.assertNotEqual(first["appointment_id"], second["appointment_id"])

    def test_a_taken_time_offers_alternatives_and_leaves_no_client_behind(self):
        for op, client in ((self.giulia, self.anna), (self.marta, self.bea)):
            self.book(client, op, aware(self.day, 10), [(self.cut30, 30, 0)])
        data = self.book_call()
        self.assertEqual(data["error"], "unavailable")
        self.assertTrue(data["alternatives"])
        self.assertNotIn("10:00", data["alternatives"])
        self.assertFalse(Client.objects.filter(first_name="Carla").exists())

    def test_bad_data_is_answered_200_with_the_reason(self):
        self.assertEqual(self.book_call(time="mattina")["error"], "invalid_request")
        self.assertEqual(self.book_call(customer_phone="")["error"], "invalid_request")
        self.assertEqual(self.book_call(customer_name=" ")["error"], "invalid_request")
        self.assertEqual(self.book_call(date="2026-02-30")["error"], "invalid_request")
        # Tipi «sbagliati» che un agente manda davvero: si accettano.
        data = self.book_call(services=[self.cut30.id], customer_phone=393451112233, time="9.30")
        self.assertTrue(data["success"], data)
        self.assertEqual(data["time"], "09:30")
