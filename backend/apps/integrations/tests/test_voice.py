"""Assistente vocale: l'agente Yourang legge servizi e orari e prenota al telefono."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import Mock, patch

import httpx
from django.test import override_settings
from django.utils import timezone

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

    def test_without_the_integrations_permission_the_assistant_is_off_limits(self):
        desk = self.staff_auth(("agenda", "settings"))
        self.assertEqual(self.client.post("/api/integrations/voice/assistant", **desk).status_code, 403)
        self.assertEqual(self.client.get("/api/integrations/voice/assistant", **desk).status_code, 403)
        self.assertEqual(self.client.delete("/api/integrations/voice/assistant", **desk).status_code, 403)
        self.assertEqual(self.client.get("/api/integrations/yourang/oauth/start", **desk).status_code, 403)

    def test_the_technician_with_the_permission_reaches_the_assistant_not_the_disconnect(self):
        # Il tecnico che aiuta la titolare: vede e ricollega, ma non scollega il salone.
        tech = self.staff_auth(("integrations",))
        self.assertEqual(self.client.get("/api/integrations/voice/assistant", **tech).status_code, 200)
        self.assertEqual(self.client.delete("/api/integrations/yourang/connection", **tech).status_code, 403)


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
        self.assertEqual(
            tool["parameter_routing"],
            {"date": {"location": "query"}, "services": {"location": "query"}, "appointment_id": {"location": "query"}},
        )
        self.assertEqual(
            [c.args[1] for c in req.call_args_list if c.args[0] == "PATCH"],
            ["/agents/ag-1/tools/make-reservation", "/agents/ag-2/tools/make-reservation"],
        )
        # La chiave installata su Yourang è quella che il backend accetta; la vecchia non più.
        self.assertEqual(self.services().status_code, 401)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tool['auth_config']['token']}"}
        self.assertEqual(self.services().status_code, 200)

    def test_choosing_what_the_agent_may_do_reinstalls_only_those_tools(self):
        with self.yourang():
            self.client.post("/api/integrations/voice/assistant", **self.owner)
        with self.yourang() as req:
            res = self.client.put(
                "/api/integrations/voice/assistant/tools", data='{"tools": ["cancel_appointment"]}',
                content_type="application/json", **self.owner,
            )
        self.assertEqual(res.status_code, 200, res.content)
        # Annullare porta con sé la lettura degli appuntamenti, senza la quale non saprebbe quale.
        self.assertEqual(res.json()["tools"], ["find_appointments", "cancel_appointment"])
        calls = [(c.args[0], c.args[1].rsplit("/", 1)[1]) for c in req.call_args_list if "external-tools" in c.args[1]]
        self.assertEqual([n for m, n in calls if m == "PUT"], ["find_appointments", "cancel_appointment"])
        self.assertEqual(
            [n for m, n in calls if m == "DELETE"],
            ["list_services", "check_availability", "create_appointment", "reschedule_appointment"],
        )

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


class VoiceRescheduleCancelTests(VoiceTestBase):
    """Al telefono o in chat la cliente sposta e annulla, con le regole dell'app."""

    def setUp(self):
        super().setUp()
        self.appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.phone = "333 000 0001"  # Anna, scritto come lo detta lei

    def find(self, phone=None):
        res = self.client.get(
            f"/api/integrations/voice/appointments?customer_phone={phone or self.phone}", **self.auth
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def call(self, action, **fields):
        body = {"appointment_id": str(self.appt.id), "customer_phone": self.phone, **fields}
        res = post_json(self.client, f"/api/integrations/voice/appointments/{action}", body, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_finds_the_callers_upcoming_appointments_only(self):
        self.book(self.bea, self.marta, aware(self.day, 11), [(self.cut30, 30, 0)])
        data = self.find()
        self.assertEqual([a["appointment_id"] for a in data["appointments"]], [self.appt.id])
        self.assertEqual((data["appointments"][0]["time"], data["appointments"][0]["services"]), ("10:00", ["Taglio"]))
        self.assertEqual(self.find("+39 345 999 9999")["appointments"], [])

    def test_a_daughter_booked_with_her_mothers_number_is_found_too(self):
        daughter = Client.objects.create(salon=self.salon, first_name="Lia", last_name="R", contact_client=self.anna)
        self.book(daughter, self.marta, aware(self.day, 12), [(self.cut30, 30, 0)])
        self.assertEqual([a["client_name"] for a in self.find()["appointments"]], ["Anna", "Lia"])

    def test_moving_checks_the_visits_own_times_and_moves_it(self):
        times = self.client.get(
            f"/api/integrations/voice/availability?date={self.day.isoformat()}&appointment_id={self.appt.id}", **self.auth
        ).json()["times"]
        self.assertIn("10:00", times)  # la visita stessa non occupa il suo orario
        data = self.call("reschedule", date=self.day.isoformat(), time="15:00")
        self.assertTrue(data["success"], data)
        self.appt.refresh_from_db()
        self.assertEqual(self.appt.start, aware(self.day, 15))
        self.assertTrue(OutboxEvent.objects.filter(event_type="appointment.moved").exists())
        self.assertTrue(self.call("reschedule", date=self.day.isoformat(), time="15:00")["success"])  # ritentativo

    def test_a_taken_time_offers_alternatives(self):
        for op, client in ((self.giulia, self.bea), (self.marta, self.bea)):
            self.book(client, op, aware(self.day, 15), [(self.cut30, 30, 0)])
        data = self.call("reschedule", date=self.day.isoformat(), time="15:00")
        self.assertEqual(data["error"], "unavailable")
        self.assertTrue(data["alternatives"])
        self.assertNotIn("15:00", data["alternatives"])
        self.appt.refresh_from_db()
        self.assertEqual(self.appt.start, aware(self.day, 10))

    def test_cancelling_frees_the_slot_and_counts_as_the_clients_cancellation(self):
        data = self.call("cancel")
        self.assertTrue(data["success"], data)
        self.appt.refresh_from_db()
        self.assertEqual(self.appt.status, Appointment.Status.CANCELLED)
        self.assertTrue(OutboxEvent.objects.filter(event_type="appointment.cancelled").exists())
        self.assertTrue(self.call("cancel")["success"])  # ritentativo
        self.assertEqual(self.find()["appointments"], [])

    def test_someone_elses_appointment_is_not_touched(self):
        for action, extra in (("cancel", {}), ("reschedule", {"date": self.day.isoformat(), "time": "15:00"})):
            data = self.call(action, customer_phone="+39 333 000 0002", **extra)  # Bea
            self.assertEqual(data["error"], "invalid_request")
        self.appt.refresh_from_db()
        self.assertEqual((self.appt.status, self.appt.start), (Appointment.Status.CONFIRMED, aware(self.day, 10)))

    def test_too_close_to_the_visit_the_salon_decides(self):
        soon = self.book(self.anna, self.marta, timezone.now() + dt.timedelta(hours=3), [(self.cut30, 30, 0)])
        for action, extra in (("cancel", {}), ("reschedule", {"date": self.day.isoformat(), "time": "15:00"})):
            data = self.call(action, appointment_id=soon.id, **extra)
            self.assertEqual(data["error"], "too_late", data)
        soon.refresh_from_db()
        self.assertEqual(soon.status, Appointment.Status.CONFIRMED)

    def test_bad_ids_and_phones_are_answered_200(self):
        self.assertEqual(self.call("cancel", appointment_id="domani")["error"], "invalid_request")
        self.assertEqual(self.call("cancel", customer_phone="")["error"], "invalid_request")
        self.assertEqual(self.find("abc")["error"], "invalid_request")


class VoiceToolPermissionTests(VoiceTestBase):
    """Il salone decide cosa l'agente legge e fa; le rotte lo rispettano anche se Yourang non è aggiornato."""

    def set_tools(self, tools, auth=None):
        with patch.object(voice, "install"):  # l'installazione su Yourang la prova VoiceInstallTests
            return self._put(tools, auth)

    def _put(self, tools, auth):
        return self.client.put(
            "/api/integrations/voice/assistant/tools", data=json.dumps({"tools": tools}),
            content_type="application/json", **(auth or self.staff_auth(("integrations",))),
        )

    def test_everything_is_allowed_by_default(self):
        self.assertEqual(voice.enabled_tools(self.salon), list(voice.TOOL_NAMES))

    def test_a_tool_switched_off_answers_not_allowed(self):
        res = self.set_tools(["list_services", "check_availability"])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["tools"], ["list_services", "check_availability"])
        self.assertEqual(self.services().status_code, 200)
        self.assertIsInstance(self.services().json(), list)
        self.assertEqual(self.book_call()["error"], "not_allowed")
        self.assertFalse(Appointment.objects.exists())
        found = self.client.get("/api/integrations/voice/appointments?customer_phone=3330000001", **self.auth)
        self.assertEqual(found.json()["error"], "not_allowed")

    def test_writing_brings_the_reads_it_needs(self):
        self.set_tools(["create_appointment"])
        self.salon.refresh_from_db()
        self.assertEqual(
            voice.enabled_tools(self.salon), ["list_services", "check_availability", "create_appointment"]
        )
        self.salon.voice_disabled_tools = ["list_services"]  # salvato a mano: prenotare resta spento
        self.assertNotIn("create_appointment", voice.enabled_tools(self.salon))

    def test_only_who_manages_integrations_decides(self):
        self.assertEqual(self.set_tools([], self.staff_auth(("agenda",), email="desk2@x.it")).status_code, 403)
        self.salon.refresh_from_db()
        self.assertEqual(voice.enabled_tools(self.salon), list(voice.TOOL_NAMES))
