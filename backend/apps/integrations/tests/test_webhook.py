"""Il webhook di Yourang: la rotta pubblica e i webhook dei contatti.

ContactWebhookTests viene dalla caccia del 22/09 (11-12: le richieste restano
veloci; gli altri casi di 11-12 stanno in test_sync). Nato sul proxy, portato sul
flusso diretto al merge con main (24/09): token del salone sulla connessione,
segreto del webhook per salone.

    python manage.py test apps.integrations.tests.test_webhook
"""

import json
import time
from unittest import mock
from unittest.mock import patch

from django.test import Client as HttpClient
from django.test import TestCase, override_settings

from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import crypto

from .base import API_SETTINGS, TEST_KEY, FakeHttp, _all_calls, _connection, sign_webhook

# Due classi, due connessioni, due segreti: ciascuna firma con quello della sua
# connessione (WEBHOOK_SECRET per WebhookRouteTests, SECRET per ContactWebhookTests).
WEBHOOK_SECRET = "s3cret"
SECRET = "s3cret-22"


# La chiave vale per i test che cifrano token e segreti: senza, giravano solo
# con una ENCRYPTION_KEY nell'ambiente di chi li lanciava.
@override_settings(ENCRYPTION_KEY=TEST_KEY)
class WebhookRouteTests(TestCase):
    """La rotta, non solo la firma: è pubblica e ci passa tutto ciò che il
    proxy consegna, compreso un payload storto."""

    URL = "/api/integrations/yourang/webhook"

    def setUp(self):
        from apps.clients.models import Client
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection
        from apps.staff.models import Operator

        self.http = HttpClient()
        self.salon = Salon.objects.create(name="Salone Hook", slug="salone-hook")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org-hook")
        self.conn.webhook_secret_enc = crypto.encrypt(WEBHOOK_SECRET)
        self.conn.save(update_fields=["webhook_secret_enc"])
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Ada", phone="+393331110000"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Anna")

    def _post(self, payload, *, ts=None, signature=None, raw=None):
        body = raw if raw is not None else json.dumps(payload).encode()
        ts = ts or str(int(time.time()))
        return self.http.post(
            self.URL,
            data=body,
            content_type="application/json",
            headers={
                "x-yourang-signature": signature or sign_webhook(body, ts, WEBHOOK_SECRET),
                "x-yourang-timestamp": ts,
            },
        )

    def _appointment(self, yourang_event_id=""):
        from datetime import timedelta

        from django.utils import timezone as dj_timezone

        from apps.agenda.models import Appointment

        return Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=self.operator,
            start=dj_timezone.now() + timedelta(days=1),
            yourang_event_id=yourang_event_id,
        )

    def test_unsigned_request_is_rejected(self):
        body = json.dumps({"type": "event.updated", "organization_id": "org-hook"}).encode()
        resp = self.http.post(self.URL, data=body, content_type="application/json")
        self.assertEqual(resp.status_code, 401)

    def test_unknown_org_is_ignored(self):
        resp = self._post({"type": "event.updated", "organization_id": "org-ignota",
                           "resource_id": "e-1"})
        self.assertEqual(resp.status_code, 200)

    def test_deleted_without_resource_id_touches_nothing(self):
        """Il guasto peggiore dell'integrazione: senza resource_id il filtro
        cadeva sul default "" di TUTTI gli appuntamenti nativi e una sola
        UPDATE annullava l'intera agenda del salone."""
        from apps.agenda.models import Appointment

        native = self._appointment()
        imported = self._appointment(yourang_event_id="evt-99")

        resp = self._post({"type": "event.deleted", "organization_id": "org-hook"})

        self.assertEqual(resp.status_code, 200)
        native.refresh_from_db()
        imported.refresh_from_db()
        self.assertEqual(native.status, Appointment.Status.CONFIRMED)
        self.assertEqual(imported.status, Appointment.Status.CONFIRMED)
        self.assertEqual(
            Appointment.objects.filter(status=Appointment.Status.CANCELLED).count(), 0
        )

    def test_deleted_with_resource_id_cancels_only_that_one(self):
        from apps.agenda.models import Appointment

        native = self._appointment()
        imported = self._appointment(yourang_event_id="evt-99")

        resp = self._post({"type": "event.deleted", "organization_id": "org-hook",
                           "resource_id": "evt-99"})

        self.assertEqual(resp.status_code, 200)
        native.refresh_from_db()
        imported.refresh_from_db()
        self.assertEqual(native.status, Appointment.Status.CONFIRMED)
        self.assertEqual(imported.status, Appointment.Status.CANCELLED)

    def test_json_that_is_not_an_object_is_a_bad_request(self):
        resp = self._post(None, raw=b"[]")
        self.assertEqual(resp.status_code, 400)

    def test_broken_json_is_a_bad_request(self):
        resp = self._post(None, raw=b"{nope")
        self.assertEqual(resp.status_code, 400)

    def test_non_ascii_signature_is_unauthorized_not_a_crash(self):
        resp = self._post({"type": "event.updated", "organization_id": "org-hook"},
                          signature="sha256=dëadbeef")
        self.assertEqual(resp.status_code, 401)

    def test_processing_failure_asks_for_a_retry(self):
        with patch("apps.integrations.sync.import_event", side_effect=RuntimeError("boom")):
            resp = self._post({"type": "event.updated", "organization_id": "org-hook",
                               "resource_id": "evt-1"})
        self.assertEqual(resp.status_code, 503)


@override_settings(**API_SETTINGS)
class ContactWebhookTests(TestCase):
    """11-12: un webhook contact.* riconcilia solo quel contatto, senza sync
    completa né push di ogni scheda."""

    def setUp(self):
        FakeHttp.instances = []
        FakeHttp.contacts = {
            "c-1": {"id": "c-1", "first_name": "Rita", "last_name": "Blu",
                    "phone_number": "+393471112223", "email": "rita@example.it"},
        }
        FakeHttp.missing_route = False
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.conn = _connection(
            self.salon, "org-c", webhook_secret_enc=crypto.encrypt(SECRET)
        )
        for i in range(120):
            Client.objects.create(salon=self.salon, first_name=f"C{i}", phone=f"+3933310{i:05d}")

    def _hook(self, event_type, resource_id="c-1"):
        payload = {"type": event_type, "organization_id": "org-c"}
        if resource_id:
            payload["resource_id"] = resource_id
        body = json.dumps(payload).encode()
        ts = str(int(time.time()))
        sig = sign_webhook(body, ts, SECRET)
        with mock.patch("apps.integrations.client.httpx.Client", FakeHttp), \
                mock.patch("apps.integrations.client.httpx.request") as one_shot:
            r = self.client.post("/api/integrations/yourang/webhook", data=body,
                                 content_type="application/json",
                                 headers={"x-yourang-signature": sig, "x-yourang-timestamp": ts})
        one_shot.assert_not_called()
        return r

    def test_a_contact_webhook_reconciles_only_that_contact(self):
        for _ in range(3):
            self.assertEqual(self._hook("contact.updated").status_code, 200)
        self.assertEqual(_all_calls(), [("GET", "/contacts/c-1")] * 3)  # niente POST
        rita = Client.objects.get(salon=self.salon, yourang_contact_id="c-1")
        self.assertEqual((rita.first_name, rita.email), ("Rita", "rita@example.it"))
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 121)

    def test_an_existing_card_is_linked_by_phone(self):
        mine = Client.objects.create(salon=self.salon, first_name="Rita", phone="347 111 2223")
        self._hook("contact.created")
        mine.refresh_from_db()
        self.assertEqual(mine.yourang_contact_id, "c-1")
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 121)

    def test_a_deleted_contact_costs_nothing(self):
        self.assertEqual(self._hook("contact.deleted").status_code, 200)
        self.assertEqual(_all_calls(), [])

    def test_without_resource_id_the_full_reconciliation_does_not_push(self):
        self.assertEqual(self._hook("contact.updated", resource_id="").status_code, 200)
        calls = _all_calls()
        self.assertTrue(calls and all(method == "GET" for method, _ in calls), calls)
        self.assertTrue(Client.objects.filter(yourang_contact_id="c-1").exists())

    def test_a_contact_the_api_does_not_return_falls_back_without_push(self):
        FakeHttp.missing_route = True
        self.assertEqual(self._hook("contact.updated").status_code, 200)
        calls = _all_calls()
        self.assertEqual(calls[0], ("GET", "/contacts/c-1"))
        self.assertTrue(all(method == "GET" for method, _ in calls), calls)
        self.assertTrue(Client.objects.filter(yourang_contact_id="c-1").exists())

    def test_a_contact_that_cannot_be_saved_is_not_retried_forever(self):
        with mock.patch("apps.integrations.sync._reconcile_contact",
                        side_effect=RuntimeError("telefono doppio")):
            r = self._hook("contact.updated")
        self.assertEqual(r.status_code, 200)  # un 503 farebbe ritentare Yourang all'infinito
