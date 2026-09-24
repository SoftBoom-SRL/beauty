"""Sincronizzazione con Yourang: contatti, listino, prima sync e cron.

PooledClientTests, CatalogueRaceTests, InitialSyncTests e CronLastErrorTests
vengono dalla caccia del 22/09 (11-12: le richieste restano veloci; 11-18/17-13:
last_error scritto e visibile): nati sul proxy, portati sul flusso diretto al
merge con main (24/09).
"""

from unittest import mock
from unittest.mock import Mock, patch

from django.core.management import call_command
from django.test import TestCase, override_settings

from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import sync
from apps.integrations.models import YourangConnection
from apps.integrations.sync import SyncReport

from .base import API_SETTINGS, FakeHttp, _all_calls, _connection


class ContactPushTests(TestCase):
    """Il push usa POST /contacts: l'external API non ha un upsert by-phone."""

    def setUp(self):
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        self.salon = Salon.objects.create(name="Test Salon", slug="test-salon-push")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org2")

    def _push(self, request_mock):
        from apps.clients.models import Client
        from apps.integrations.sync import sync_clients

        Client.objects.create(
            salon=self.salon, first_name="Mario", last_name="Rossi", phone="+393331234567"
        )
        with patch("apps.integrations.client.YourangClient.list_contacts", return_value=[]), \
             patch("apps.integrations.client.YourangClient._request", request_mock):
            report = sync_clients(self.conn)
        return report, Client.objects.get(phone="+393331234567")

    def test_pushes_with_post(self):
        resp = Mock()
        resp.json.return_value = {"ok": True, "data": {"id": "c-1"}}
        req = Mock(return_value=resp)
        report, client = self._push(req)

        method, path = req.call_args.args
        self.assertEqual((method, path), ("POST", "/contacts"))
        self.assertEqual(req.call_args.kwargs["json"]["phone_number"], "+393331234567")
        self.assertEqual(report.pushed, 1)
        self.assertEqual(client.yourang_contact_id, "c-1")

    def test_duplicate_phone_falls_back_to_lookup(self):
        import httpx

        ok = Mock()
        ok.json.return_value = {"ok": True, "data": {"id": "c-9"}}
        conflict = httpx.HTTPStatusError(
            "400", request=Mock(), response=Mock(status_code=400)
        )
        req = Mock(side_effect=[conflict, ok])
        report, client = self._push(req)

        self.assertEqual(req.call_args.args[0], "GET")
        # Il '+' DEVE viaggiare percent-encodato: nel path un '+' non codificato
        # viene letto come spazio e il by-phone non trova mai il contatto.
        self.assertEqual(req.call_args.args[1], "/contacts/by-phone/%2B393331234567")
        self.assertEqual(client.yourang_contact_id, "c-9")
        self.assertEqual(report.errors, [])

    def test_two_spellings_of_the_same_phone_do_not_break_the_sync(self):
        """Due contatti remoti che normalizzano sullo stesso numero ricevono lo
        stesso contact-id: la seconda riga violava uniq_client_salon_yourang_contact
        e l'eccezione, deterministica, bloccava l'integrazione per sempre."""
        from apps.clients.models import Client
        from apps.integrations.sync import sync_clients

        remote = [
            {"id": "c-1", "phone_number": "333 1234567", "first_name": "Maria",
             "last_name": "Bianchi"},
            {"id": "c-1", "phone_number": "+39 333 1234567", "first_name": "Maria",
             "last_name": "Bianchi", "email": "maria@x.it"},
            {"id": "c-2", "phone_number": "0039 333 1234567", "first_name": "Maria",
             "last_name": "Bianchi"},
        ]
        with patch("apps.integrations.client.YourangClient.list_contacts",
                   side_effect=[remote, []]), \
             patch("apps.integrations.client.YourangClient.create_or_get_contact",
                   return_value={}):
            report = sync_clients(self.conn)

        clients = Client.objects.filter(salon=self.salon)
        self.assertEqual(clients.count(), 1, "una sola scheda per lo stesso numero")
        self.assertEqual(report.errors, [])
        self.assertEqual(clients.first().yourang_contact_id, "c-1")

    def test_a_single_failing_contact_does_not_stop_the_others(self):
        """Un salvataggio che fallisce deve fermare QUEL contatto, non la sync:
        l'errore era deterministico e l'integrazione restava bloccata per sempre."""
        from apps.clients.models import Client
        from apps.integrations.sync import sync_clients

        twin = Client.objects.create(
            salon=self.salon, first_name="Gemella", phone="+393339999999"
        )
        original_save = Client.save

        def flaky_save(instance, *args, **kwargs):
            if instance.phone == "+393331111111":
                # Violazione VERA del vincolo (salon, phone): sporca la
                # transazione, ed è il motivo per cui serve un savepoint e non
                # un semplice try/except.
                Client(salon=self.salon, first_name="Doppia", phone=twin.phone).save_base(
                    force_insert=True
                )
            return original_save(instance, *args, **kwargs)

        remote = [
            {"id": "c-bad", "phone_number": "333 1111111", "first_name": "Ada"},
            {"id": "c-ok", "phone_number": "333 2222222", "first_name": "Luisa"},
        ]
        with patch.object(Client, "save", flaky_save), \
             patch("apps.integrations.client.YourangClient.list_contacts",
                   side_effect=[remote, []]), \
             patch("apps.integrations.client.YourangClient.create_or_get_contact",
                   return_value={}):
            report = sync_clients(self.conn)

        self.assertTrue(Client.objects.filter(salon=self.salon, phone="+393332222222").exists())
        self.assertFalse(Client.objects.filter(salon=self.salon, phone="+393331111111").exists())
        self.assertEqual(len(report.errors), 1)

    def test_pagination_stops_when_the_proxy_ignores_offset(self):
        """Un proxy che rimanda sempre la stessa pagina non deve far girare la
        sync all'infinito (gira dentro il webhook)."""
        from apps.integrations.sync import sync_clients

        page = [
            {"id": f"c-{i}", "phone_number": f"33300{i:05d}", "first_name": "A"}
            for i in range(100)
        ]
        with patch("apps.integrations.client.YourangClient.list_contacts",
                   return_value=page) as listed, \
             patch("apps.integrations.client.YourangClient.create_or_get_contact",
                   return_value={}):
            report = sync_clients(self.conn)

        self.assertEqual(listed.call_count, 2)  # la seconda pagina è già vista → stop
        self.assertTrue(any("pagina già vista" in e for e in report.errors))


@override_settings(**API_SETTINGS)
class PooledClientTests(TestCase):
    """11-12: un giro di sync riusa un solo client httpx."""

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


@override_settings(**API_SETTINGS)
class CatalogueRaceTests(TestCase):
    """11-12: due sync che partono insieme non creano due cataloghi."""

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


class InitialSyncTests(TestCase):
    """11-12: la prima sync gira fuori dalla richiesta (initial_sync, in
    background). Ne scrive l'esito sulla connessione (11-18/17-13) e si ferma se
    il salone viene scollegato nel frattempo."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org-i")

    def test_outcome_is_written_on_the_connection(self):
        with mock.patch("apps.integrations.sync.sync_clients",
                        return_value=SyncReport(errors=["a", "b", "c", "d"])), \
                mock.patch("apps.integrations.sync.sync_services", return_value=SyncReport()):
            sync.initial_sync(self.conn.pk)
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_sync_at)
        self.assertEqual(self.conn.last_error, "Sincronizzazione parziale: a; b; c (+1 altri)")

    def test_a_crash_is_written_too(self):
        with mock.patch("apps.integrations.sync.sync_clients", side_effect=RuntimeError("Yourang giù")):
            sync.initial_sync(self.conn.pk)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_error, "Yourang giù")
        self.assertIsNone(self.conn.last_sync_at)

    def test_the_sync_stops_when_the_salon_is_disconnected_meanwhile(self):
        """Scollegato a sync in corso: niente contact-id dell'org vecchia sulle
        schede (la sync della nuova le salterebbe come già collegate)."""
        for i in range(3):
            Client.objects.create(salon=self.salon, first_name=f"C{i}", phone=f"+39333000000{i}")
        pushed = []

        def create_or_get(phone, payload):
            pushed.append(phone)
            if len(pushed) == 1:
                YourangConnection.objects.filter(pk=self.conn.pk).delete()
            return {"id": f"c-{len(pushed)}"}

        with mock.patch("apps.integrations.client.YourangClient.list_contacts", return_value=[]), \
                mock.patch("apps.integrations.client.YourangClient.create_or_get_contact",
                           side_effect=create_or_get):
            sync.initial_sync(self.conn.pk)
        self.assertEqual(len(pushed), 1)
        linked = Client.objects.filter(salon=self.salon).exclude(yourang_contact_id="")
        self.assertLessEqual(linked.count(), 1)


class CronRecoveryTests(TestCase):
    """Un errore passeggero non deve escludere il salone dal cron per sempre."""

    def test_error_connection_is_retried_and_restored(self):
        from django.core.management import call_command

        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection
        from apps.integrations.sync import SyncReport

        salon = Salon.objects.create(name="Salone Cron", slug="salone-cron")
        conn = YourangConnection.objects.create(
            salon=salon, yourang_org_id="org-cron",
            status=YourangConnection.Status.ERROR, last_error="502 di ieri",
        )
        with patch("apps.integrations.management.commands.sync_yourang.sync_clients",
                   return_value=SyncReport()), \
             patch("apps.integrations.management.commands.sync_yourang.sync_services",
                   return_value=SyncReport()):
            call_command("sync_yourang", verbosity=0)

        conn.refresh_from_db()
        self.assertEqual(conn.status, YourangConnection.Status.CONNECTED)
        self.assertEqual(conn.last_error, "")
        self.assertIsNotNone(conn.last_sync_at)

    def test_disconnected_connection_stays_out(self):
        from django.core.management import call_command

        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        salon = Salon.objects.create(name="Salone Off", slug="salone-off")
        conn = YourangConnection.objects.create(
            salon=salon, yourang_org_id="org-off",
            status=YourangConnection.Status.DISCONNECTED,
        )
        with patch("apps.integrations.management.commands.sync_yourang.sync_clients") as synced:
            call_command("sync_yourang", verbosity=0)
        synced.assert_not_called()
        conn.refresh_from_db()
        self.assertEqual(conn.status, YourangConnection.Status.DISCONNECTED)


class CronLastErrorTests(TestCase):
    """11-18/17-13 (C9): il cron scrive last_error anche per una sync parziale, e
    non resuscita una connessione tolta durante il giro."""

    def test_partial_errors_stay_written(self):
        salon = Salon.objects.create(name="Salone Cron", slug="salone-cron")
        conn = YourangConnection.objects.create(salon=salon, yourang_org_id="org-cron")
        partial = SyncReport(errors=["push +393331112223: 403 Forbidden"])
        with mock.patch("apps.integrations.management.commands.sync_yourang.sync_clients",
                        return_value=partial), \
                mock.patch("apps.integrations.management.commands.sync_yourang.sync_services",
                           return_value=SyncReport()):
            call_command("sync_yourang", verbosity=0, stdout=mock.Mock())
        conn.refresh_from_db()
        self.assertEqual(conn.status, YourangConnection.Status.CONNECTED)
        self.assertIn("403 Forbidden", conn.last_error)
        self.assertTrue(conn.last_error.startswith("Sincronizzazione parziale"))
        self.assertIsNotNone(conn.last_sync_at)

    def test_a_disconnect_during_the_run_is_not_resurrected(self):
        salon = Salon.objects.create(name="Salone Cron", slug="salone-cron")
        YourangConnection.objects.create(salon=salon, yourang_org_id="org-cron")

        def disconnect_meanwhile(conn):
            YourangConnection.objects.filter(pk=conn.pk).delete()
            return SyncReport()

        with mock.patch("apps.integrations.management.commands.sync_yourang.sync_clients",
                        side_effect=disconnect_meanwhile), \
                mock.patch("apps.integrations.management.commands.sync_yourang.sync_services",
                           return_value=SyncReport()):
            call_command("sync_yourang", verbosity=0, stdout=mock.Mock())
        self.assertFalse(YourangConnection.objects.exists())
