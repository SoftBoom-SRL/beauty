"""Automazioni che inviano un modello WhatsApp approvato su Yourang (YR-1391).

«La bellezza è» aveva tre modelli approvati e nessun modo di farli partire:
la regola arrivava a Yourang, che non la eseguiva, e il costruttore mostrava
un testo di esempio. Qui: la scelta del modello (controllata su Yourang), il
giro che invia una volta sola, e chi NON deve ricevere il messaggio.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

import httpx
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon
from apps.integrations import client as yourang_client
from apps.integrations.models import YourangConnection
from apps.staff.models import Operator
from common.testing import bearer

from ..models import Automation, AutomationSend
from ..whatsapp import run

SEND = "apps.integrations.client.YourangClient.send_whatsapp_template"
LIST = "apps.integrations.client.YourangClient.list_whatsapp_templates"

REMINDER = {
    "name": "promemoria",
    "language": "it",
    "category": "UTILITY",
    "body": "Ciao {{1}}, ti aspettiamo il {{2}} alle {{3}}.",
    "parameters": [{"key": "body:1", "label": "nome"}, {"key": "body:2"}, {"key": "body:3"}],
    "api_sendable": True,
}


def _http_error(status: int, reason: str) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://api.test/whatsapp/messages/template")
    response = httpx.Response(
        status, request=request, json={"error": {"details": {"reason": reason}}}
    )
    return httpx.HTTPStatusError(reason, request=request, response=response)


@override_settings(YOURANG_WHATSAPP_SCOPES=True)
class WhatsAppAutomationTestBase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="La bellezza è", slug="la-bellezza")
        YourangConnection.objects.create(
            salon=self.salon, status=YourangConnection.Status.CONNECTED,
            scope="openid contacts:write whatsapp:read whatsapp:write",
        )
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="B")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Semipermanente", duration_min=60,
            price=Decimal("30.00"),
        )

    def automation(self, event="appointment_upcoming", **fields):
        values = {
            "name": "Promemoria", "event": event, "offset_direction": "before",
            "offset_value": 24, "offset_unit": "hours", "template_name": "promemoria",
            "template_language": "it", "template_category": "UTILITY",
            "template_parameters": ["first_name", "date", "time"],
        }
        values.update(fields)
        return Automation.objects.create(salon=self.salon, **values)

    def appointment(self, start, status=Appointment.Status.CONFIRMED):
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator, start=start,
            status=status,
        )
        AppointmentService.objects.create(
            appointment=appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal("30.00"),
        )
        return appointment


class RunTests(WhatsAppAutomationTestBase):
    def test_reminder_goes_once_with_the_appointment_values(self):
        self.automation()
        start = timezone.now() + dt.timedelta(hours=24, minutes=5)
        self.appointment(start)
        later = timezone.now() + dt.timedelta(minutes=10)

        with patch(SEND) as send:
            self.assertEqual(run(later)["sent"], 1)
            run(later + dt.timedelta(minutes=5))  # giro successivo: niente doppioni

        send.assert_called_once()
        to_phone, name, language, values = send.call_args.args
        local = timezone.localtime(start)
        self.assertEqual((to_phone, name, language), ("+393331112222", "promemoria", "it"))
        self.assertEqual(values, ["Sofia", f"{local:%d/%m/%Y}", f"{local:%H:%M}"])

    def test_not_yet_due_cancelled_and_moved_appointments(self):
        self.automation()
        now = timezone.now()
        self.appointment(now + dt.timedelta(hours=30))  # promemoria fra 6 ore
        self.appointment(now + dt.timedelta(hours=24, minutes=5), Appointment.Status.CANCELLED)
        moved = self.appointment(now + dt.timedelta(hours=24, minutes=5))
        with patch(SEND) as send:
            run(now + dt.timedelta(minutes=10))
            self.assertEqual(send.call_count, 1)
            # Spostato dopo il promemoria: il nuovo orario ne merita un altro.
            Appointment.objects.filter(pk=moved.pk).update(start=moved.start + dt.timedelta(hours=1))
            run(now + dt.timedelta(hours=1, minutes=10))
        self.assertEqual(send.call_count, 2)

    def test_no_message_for_appointments_from_before_the_automation(self):
        start = timezone.now() + dt.timedelta(hours=24, minutes=5)
        self.appointment(start)
        automation = self.automation()
        # Creata DOPO che era già l'ora del promemoria: non lo recupera.
        Automation.objects.filter(pk=automation.pk).update(
            created_at=timezone.now() + dt.timedelta(minutes=7)
        )
        with patch(SEND) as send:
            run(timezone.now() + dt.timedelta(minutes=10))
        send.assert_not_called()

    def test_new_appointment_and_after_the_visit(self):
        created = self.automation("appointment_created", offset_direction="after", offset_value=0)
        completed = self.automation("visit_completed", offset_direction="after", offset_value=2)
        self.appointment(timezone.now() + dt.timedelta(days=3))  # appena prenotato
        # Visita di 60 minuti finita 2 ore e mezza fa, chiusa: il grazie parte.
        self.appointment(timezone.now() - dt.timedelta(hours=3, minutes=30), Appointment.Status.CLOSED)
        # Stessa ora ma mai chiusa: niente.
        self.appointment(timezone.now() - dt.timedelta(hours=3, minutes=30))
        Automation.objects.update(created_at=timezone.now() - dt.timedelta(days=1))
        with patch(SEND) as send:
            counts = run(timezone.now() + dt.timedelta(minutes=1))
        # «Nuovo appuntamento» per tutti e tre (appena inseriti), «dopo la
        # visita» solo per quella chiusa.
        self.assertEqual(counts["sent"], 4)
        self.assertEqual(send.call_count, 4)
        self.assertEqual(created.sends.count(), 3)
        self.assertEqual(completed.sends.count(), 1)

    def test_client_who_turned_off_whatsapp_messages_is_skipped(self):
        self.automation()
        Client.objects.filter(pk=self.client_obj.pk).update(whatsapp_reminders=False)
        self.appointment(timezone.now() + dt.timedelta(hours=24, minutes=5))
        with patch(SEND) as send:
            counts = run(timezone.now() + dt.timedelta(minutes=10))
        send.assert_not_called()
        self.assertEqual(counts["skipped"], 1)
        self.assertEqual(AutomationSend.objects.get().error, "messaggi WhatsApp disattivati dalla cliente")

    def test_marketing_template_needs_marketing_consent(self):
        self.automation(template_category="MARKETING")
        self.appointment(timezone.now() + dt.timedelta(hours=24, minutes=5))
        with patch(SEND) as send:
            run(timezone.now() + dt.timedelta(minutes=10))
        send.assert_not_called()

    def test_server_error_is_retried_with_the_same_idempotency_key(self):
        self.automation()
        self.appointment(timezone.now() + dt.timedelta(hours=24, minutes=5))
        later = timezone.now() + dt.timedelta(minutes=10)
        with patch(SEND, side_effect=[_http_error(503, "internal_error"), {}]) as send:
            self.assertEqual(run(later)["failed"], 1)
            self.assertEqual(run(later + dt.timedelta(minutes=5))["sent"], 1)
        first, second = send.call_args_list
        self.assertEqual(first.kwargs["idempotency_key"], second.kwargs["idempotency_key"])

    def test_refused_template_is_not_retried_and_lands_in_the_activity_log(self):
        self.automation()
        self.appointment(timezone.now() + dt.timedelta(hours=24, minutes=5))
        later = timezone.now() + dt.timedelta(minutes=10)
        with patch(SEND, side_effect=_http_error(400, "template_parameters_mismatch")) as send:
            run(later)
            run(later + dt.timedelta(minutes=5))
        send.assert_called_once()
        self.assertEqual(AutomationSend.objects.get().error, "template_parameters_mismatch")
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="automation.send_failed").exists()
        )

    def test_connection_without_whatsapp_scope_sends_nothing(self):
        YourangConnection.objects.filter(salon=self.salon).update(scope="openid contacts:write")
        self.automation()
        self.appointment(timezone.now() + dt.timedelta(hours=24, minutes=5))
        with patch(SEND) as send:
            run(timezone.now() + dt.timedelta(minutes=10))
        send.assert_not_called()


class TemplateApiTests(WhatsAppAutomationTestBase):
    def setUp(self):
        super().setUp()
        user = User.objects.create_user(email="titolare@labellezza.test", password="pw12345!")
        role = Role.objects.create(salon=self.salon, name="Manager di prova", scopes=["marketing"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        self.auth = bearer(user, self.salon)

    def _create(self, **fields):
        payload = {
            "name": "Promemoria 24h", "event": "appointment_upcoming",
            "offset_direction": "before", "offset_value": 24, "offset_unit": "hours",
            "template_name": "promemoria", "template_language": "it",
            "template_parameters": ["first_name", "date", "time"],
        }
        payload.update(fields)
        return self.client.post(
            "/api/automations/", data=json.dumps(payload), content_type="application/json",
            **self.auth,
        )

    def test_lists_the_approved_templates(self):
        with patch(LIST, return_value=[REMINDER, {**REMINDER, "name": "x", "api_sendable": False}]):
            body = self.client.get("/api/automations/whatsapp-templates", **self.auth).json()
        self.assertEqual(body["state"], "ok")
        self.assertEqual([t["name"] for t in body["templates"]], ["promemoria"])
        self.assertIn("appointment_upcoming", body["events"])

    def test_tells_an_old_connection_to_reconnect(self):
        YourangConnection.objects.filter(salon=self.salon).update(scope="openid contacts:write")
        body = self.client.get("/api/automations/whatsapp-templates", **self.auth).json()
        self.assertEqual(body["state"], "needs_reconnect")

    def test_saving_a_template_checks_it_on_yourang_and_shows_its_text(self):
        with patch(LIST, return_value=[REMINDER]):
            resp = self._create()
        self.assertEqual(resp.status_code, 200, resp.content)
        automation = Automation.objects.get()
        self.assertEqual(automation.message_preview, REMINDER["body"])
        self.assertEqual(automation.template_category, "UTILITY")

    def test_refuses_unknown_template_wrong_values_and_events_that_cannot_send(self):
        with patch(LIST, return_value=[REMINDER]):
            unknown = self._create(template_name="non_esiste")
            short = self._create(template_parameters=["first_name"])
            bad_field = self._create(template_parameters=["first_name", "date", "password"])
            birthday = self._create(event="birthday")
        for resp in (unknown, short, bad_field, birthday):
            self.assertEqual(resp.status_code, 400, resp.content)
        self.assertFalse(Automation.objects.exists())

    def test_rule_without_template_still_saves_without_yourang(self):
        with patch(LIST, side_effect=AssertionError("Yourang non va chiamato")):
            resp = self._create(template_name="", template_parameters=[], event="birthday")
        self.assertEqual(resp.status_code, 200, resp.content)


class OAuthScopeTests(TestCase):
    def test_whatsapp_scopes_only_when_enabled(self):
        # Yourang rifiuta l'intero login per uno scope non ammesso: spenti di serie.
        with override_settings(YOURANG_WHATSAPP_SCOPES=False):
            self.assertNotIn("whatsapp", yourang_client.oauth_scopes())
        with override_settings(YOURANG_WHATSAPP_SCOPES=True):
            self.assertIn("whatsapp:write", yourang_client.oauth_scopes().split())
