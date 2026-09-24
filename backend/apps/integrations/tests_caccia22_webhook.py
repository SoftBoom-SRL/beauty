"""Caccia del 22/09 — 11-12: le richieste restano veloci.

Un webhook contact.* riconcilia solo quel contatto (niente sync completa né
push di ogni scheda), un giro di sync riusa un solo client httpx, e due sync
che partono insieme non creano due cataloghi.

Nati sul proxy, portati sul flusso diretto al merge con main (24/09): token
del salone sulla connessione, segreto del webhook per salone.

    python manage.py test apps.integrations.tests_caccia22_webhook
"""

import hashlib
import hmac
import json
import time
from datetime import timedelta
from unittest import mock

import httpx
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import crypto, sync
from apps.integrations.models import YourangConnection

from .tests import TEST_KEY

SECRET = "s3cret-22"
API = "/api/external/v1"
DIRECT = dict(YOURANG_ISSUER_URL="https://yourang.invalid", ENCRYPTION_KEY=TEST_KEY)


def _connection(salon, org, **extra):
    """Connessione del flusso diretto, con un token ancora valido (niente refresh)."""
    return YourangConnection.objects.create(
        salon=salon,
        yourang_org_id=org,
        access_token_enc=crypto.encrypt("tok"),
        refresh_token_enc=crypto.encrypt("ref"),
        expires_at=timezone.now() + timedelta(hours=1),
        **extra,
    )


class FakeHttp:
    """httpx.Client finto: registra (metodo, path) e risponde come l'external API."""

    instances: list["FakeHttp"] = []
    contacts: dict = {}
    missing_route = False

    def __init__(self, *args, **kwargs):
        self.calls = []
        self.closed = False
        FakeHttp.instances.append(self)

    def request(self, method, url, headers=None, timeout=None, **kwargs):
        path = url.split(API, 1)[1]
        self.calls.append((method, path))
        status, data = 200, {}
        if method == "GET" and path.startswith("/contacts?"):
            data = list(FakeHttp.contacts.values())
        elif method == "GET" and path.startswith("/contacts/"):
            rid = path.rsplit("/", 1)[1]
            if FakeHttp.missing_route or rid not in FakeHttp.contacts:
                status = 404
            else:
                data = FakeHttp.contacts[rid]
        elif method == "POST" and path == "/contacts":
            status = 403  # scope contacts:write mancante
        elif method == "POST" and path == "/catalogues":
            data = {"id": "cat-new"}
        else:
            data = {"id": f"x-{len(self.calls)}"}
        resp = mock.Mock(status_code=status)
        resp.json.return_value = {"ok": status == 200, "data": data}
        if status >= 400:
            resp.raise_for_status.side_effect = httpx.HTTPStatusError(
                str(status), request=mock.Mock(), response=resp
            )
        return resp

    def close(self):
        self.closed = True


def _all_calls():
    return [call for http in FakeHttp.instances for call in http.calls]


@override_settings(**DIRECT)
class ContactWebhookTests(TestCase):
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
        sig = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.".encode() + body,
                                   hashlib.sha256).hexdigest()
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


@override_settings(**DIRECT)
class PooledClientTests(TestCase):
    def setUp(self):
        FakeHttp.instances = []
        FakeHttp.contacts = {}
        FakeHttp.missing_route = False
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.conn = _connection(self.salon, "org-p")

    def test_a_sync_run_reuses_one_http_client(self):
        for i in range(3):
            Client.objects.create(salon=self.salon, first_name=f"C{i}", phone=f"+39333000000{i}")
        with mock.patch("apps.integrations.client.httpx.Client", FakeHttp), \
                mock.patch("apps.integrations.client.httpx.request") as one_shot:
            report = sync.sync_clients(self.conn)
        one_shot.assert_not_called()
        self.assertEqual(len(FakeHttp.instances), 1)
        http = FakeHttp.instances[0]
        self.assertEqual([m for m, _ in http.calls], ["GET", "POST", "POST", "POST"])
        self.assertTrue(http.closed)
        self.assertEqual(len(report.errors), 3)  # i 403 restano nel resoconto


@override_settings(**DIRECT)
class CatalogueRaceTests(TestCase):
    def test_a_catalogue_created_meanwhile_is_reused(self):
        FakeHttp.instances = []
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        conn = _connection(salon, "org-k")
        cat = ServiceCategory.objects.create(salon=salon, name_it="Capelli")
        Service.objects.create(salon=salon, category=cat, name_it="Piega", duration_min=30, price=20)
        # l'altra sync (cron o prima sync in background) l'ha appena creato
        YourangConnection.objects.filter(pk=conn.pk).update(catalogue_id="cat-1")
        with mock.patch("apps.integrations.client.httpx.Client", FakeHttp):
            sync.sync_services(conn)
        calls = _all_calls()
        self.assertNotIn(("POST", "/catalogues"), calls)
        self.assertIn(("POST", "/catalogues/items"), calls)  # la voce va nel catalogo trovato
        self.assertEqual(conn.catalogue_id, "cat-1")
        conn.refresh_from_db()
        self.assertEqual(conn.catalogue_id, "cat-1")
