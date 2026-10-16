"""Assistente vocale: l'agente Yourang legge servizi e orari e prenota al telefono."""

from decimal import Decimal
from unittest.mock import Mock, patch

import httpx
from django.test import override_settings

from apps.agenda.models import Appointment
from apps.agenda.tests.base import RealShiftsTestBase
from apps.catalog.models import Service
from apps.clients.models import Client
from apps.core.models import OutboxEvent
from apps.integrations import sync, voice
from apps.integrations.models import YourangConnection
from apps.integrations.sync import SyncReport
from common.testing import aware, post_json

from .base import API_SETTINGS, _connection


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

    def test_only_the_owner_manages_the_assistant(self):
        desk = self.staff_auth(("agenda", "settings"))
        self.assertEqual(self.client.post("/api/integrations/voice/assistant", **desk).status_code, 403)
        self.assertEqual(self.client.get("/api/integrations/voice/assistant", **desk).status_code, 403)


@override_settings(**API_SETTINGS, PUBLIC_API_URL="https://beautyapi.test")
class VoiceInstallTests(VoiceTestBase):
    """Il titolare non importa più file né copia chiavi: il backend installa da sé."""

    def setUp(self):
        super().setUp()
        self.conn = _connection(
            self.salon, "org-voce", status=YourangConnection.Status.CONNECTED,
            scope="openid contacts:write agents:read agents:write",
        )
        self.owner = self.staff_auth(email="titolare@voce.it", owner=True)

    def yourang(self, fail_on=None):
        """`_request` finto: risponde come l'external API, o fallisce su un metodo."""
        def answer(method, path, **kwargs):
            if method == fail_on:
                raise httpx.HTTPStatusError("x", request=Mock(), response=Mock(status_code=500))
            resp = Mock()
            resp.json.return_value = {"ok": True, "data": [{"id": "ag-1"}, {"id": "ag-2"}] if method == "GET" else {}}
            return resp
        return patch("apps.integrations.client.YourangClient._request", side_effect=answer)

    def test_activating_installs_the_tools_and_switches_off_the_builtin_booking(self):
        with self.yourang() as req:
            res = self.client.post("/api/integrations/voice/assistant", **self.owner)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["active"])

        puts = [c for c in req.call_args_list if c.args[0] == "PUT"]
        self.assertEqual([c.args[1] for c in puts], [f"/external-tools/{n}" for n in voice.TOOL_NAMES])
        tool = puts[1].kwargs["json"]
        self.assertEqual(tool["webhook_url"], "https://beautyapi.test/api/integrations/voice/availability")
        self.assertEqual(tool["parameter_routing"], {"date": {"location": "query"}, "services": {"location": "query"}})
        self.assertEqual(
            [c.args[1] for c in req.call_args_list if c.args[0] == "PATCH"],
            ["/agents/ag-1/tools/make-reservation", "/agents/ag-2/tools/make-reservation"],
        )
        # La chiave installata su Yourang è quella che il backend accetta; la vecchia non più.
        self.assertEqual(self.services().status_code, 401)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tool['auth_config']['token']}"}
        self.assertEqual(self.services().status_code, 200)

    def test_a_failed_upload_keeps_the_key_the_agent_already_has(self):
        with self.yourang(fail_on="PUT"):
            res = self.client.post("/api/integrations/voice/assistant", **self.owner)
        self.assertEqual(res.status_code, 409)
        self.assertIn("riprova", res.json()["detail"])
        self.assertEqual(self.services().status_code, 200)

    def test_a_connection_from_before_the_agents_scope_asks_to_reconnect(self):
        YourangConnection.objects.filter(pk=self.conn.pk).update(scope="openid contacts:write")
        self.assertTrue(self.client.get("/api/integrations/voice/assistant", **self.owner).json()["needs_reconnect"])
        with self.yourang() as req:
            res = self.client.post("/api/integrations/voice/assistant", **self.owner)
        self.assertEqual((res.status_code, res.json()["detail"]), (409, voice.RECONNECT))
        req.assert_not_called()

    def test_switching_off_revokes_the_key_and_removes_the_tools(self):
        with self.yourang() as req:
            res = self.client.delete("/api/integrations/voice/assistant", **self.owner)
        self.assertFalse(res.json()["active"])
        self.assertEqual(
            [c.args[:2] for c in req.call_args_list],
            [("DELETE", f"/external-tools/{n}") for n in voice.TOOL_NAMES],
        )
        self.assertEqual(self.services().status_code, 401)

    def test_connecting_installs_it_without_the_owner_doing_anything(self):
        with patch("apps.integrations.voice.auto_install") as auto, \
             patch("apps.integrations.sync.sync_clients", return_value=SyncReport()), \
             patch("apps.integrations.sync.sync_services", return_value=SyncReport()):
            sync.initial_sync(self.conn.pk)
        auto.assert_called_once_with(self.conn.pk)


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


class VoiceAddonTests(VoiceTestBase):
    """15/10: un aggiuntivo (nail art) si fa durante un altro servizio: l'agente
    lo sa dal listino, e da solo non lo prenota."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.nail_art = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Nail art", duration_min=15,
            price=Decimal("10.00"), is_addon=True,
        )
        cls.giulia.services.add(cls.nail_art)
        cls.marta.services.add(cls.nail_art)

    def test_the_agent_knows_which_services_are_addons(self):
        flags = {row["name"]: row["addon"] for row in self.services().json()}
        self.assertEqual(flags, {"Taglio": False, "Colore": False, "Manicure": False, "Nail art": True})

    def test_an_addon_alone_is_answered_with_the_reason(self):
        data = self.availability(self.nail_art.id).json()
        self.assertEqual(data["error"], "invalid_request")
        self.assertIn("aggiuntivo", data["message"])
        data = self.book_call(services=f"{self.nail_art.id}")
        self.assertEqual(data["error"], "invalid_request")
        self.assertFalse(Client.objects.filter(first_name="Carla").exists())

    def test_an_addon_after_its_service_takes_no_time(self):
        data = self.book_call(services=f"{self.man60.id},{self.nail_art.id}", time="18:00")
        self.assertTrue(data["success"], data)
        appointment = Appointment.objects.get(id=data["appointment_id"])
        self.assertEqual([row.duration_min for row in appointment.items.all()], [60, 0])
        self.assertEqual(appointment.end, aware(self.day, 19))
