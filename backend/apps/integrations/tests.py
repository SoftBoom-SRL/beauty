"""Self-check dell'integrazione Yourang: firma webhook, normalizzazione telefono,
round-trip cifratura, idempotenza import evento.

    python manage.py test apps.integrations
"""

import hashlib
import hmac
import json
import time
from datetime import timedelta
from unittest.mock import Mock, patch

from django.test import Client as HttpClient
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone

from . import crypto
from .sync import cancel_event, import_event, normalize_phone

# 32-byte hex key (openssl rand -hex 32) — stesso formato di food/real_estate.
TEST_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"


class SignatureTests(SimpleTestCase):
    secret = "s3cret"

    def _sign(self, body: bytes, ts: str) -> str:
        signed = f"{ts}.".encode() + body
        return "sha256=" + hmac.new(self.secret.encode(), signed, hashlib.sha256).hexdigest()

    def test_valid_signature(self):
        body, ts = b'{"a":1}', str(int(time.time()))
        self.assertTrue(crypto.verify_signature(body, self._sign(body, ts), ts, self.secret))

    def test_wrong_signature_rejected(self):
        body, ts = b'{"a":1}', str(int(time.time()))
        self.assertFalse(crypto.verify_signature(body, "sha256=deadbeef", ts, self.secret))

    def test_stale_timestamp_rejected(self):
        body = b'{"a":1}'
        ts = str(int(time.time()) - 10_000)
        self.assertFalse(crypto.verify_signature(body, self._sign(body, ts), ts, self.secret))

    def test_non_ascii_signature_is_rejected_not_crashed(self):
        # hmac.compare_digest alza TypeError sulle stringhe non-ASCII: una firma
        # con un byte ≥ 0x80 deve valere "non valida", non un 500 su rotta pubblica.
        body, ts = b'{"a":1}', str(int(time.time()))
        self.assertFalse(
            crypto.verify_signature(body, "sha256=dëadbeef", ts, self.secret)
        )


class PhoneTests(SimpleTestCase):
    def test_italian_default_cc(self):
        self.assertEqual(normalize_phone("333 1234567"), "+393331234567")

    def test_passthrough_e164(self):
        self.assertEqual(normalize_phone("+41 79 123 45 67"), "+41791234567")

    def test_double_zero_prefix(self):
        self.assertEqual(normalize_phone("0039 333 1234567"), "+393331234567")

    def test_italian_landline_keeps_the_area_zero(self):
        # In Italia lo 0 di distretto fa parte del numero: +39 02 …, non +39 2 …
        self.assertEqual(normalize_phone("02 1234567"), "+39021234567")
        self.assertEqual(normalize_phone("0577 12345"), "+39057712345")

    def test_italian_landline_spellings_converge(self):
        # Il fallimento vero: due modi di scrivere lo stesso fisso non devono
        # dare due chiavi diverse, o diventano due contatti Yourang.
        self.assertEqual(normalize_phone("011 1234567"), normalize_phone("+39 011 1234567"))
        self.assertEqual(normalize_phone("011 1234567"), normalize_phone("0039 011 1234567"))

    def test_foreign_trunk_zero_dropped(self):
        # Fuori dall'Italia lo 0 iniziale è prefisso interurbano e va tolto.
        self.assertEqual(normalize_phone("0161 4960000", default_cc="44"), "+441614960000")

    def test_foreign_landline_spellings_converge(self):
        # L'altra faccia dello stesso errore: lo 0 va tolto anche quando il
        # numero arriva già con il suo prefisso internazionale.
        self.assertEqual(normalize_phone("+44 020 7946 0958"), "+442079460958")
        self.assertEqual(normalize_phone("+44 020 7946 0958"), normalize_phone("+44 20 7946 0958"))
        self.assertEqual(normalize_phone("0049 030 12345678"), normalize_phone("+49 30 12345678"))

    def test_unknown_country_code_left_untouched(self):
        # CC fuori tabella: intatto è meglio che accorciato a caso.
        self.assertEqual(normalize_phone("+675 0123456"), "+6750123456")

    def test_garbage_returns_none(self):
        self.assertIsNone(normalize_phone("n/a"))


@override_settings(ENCRYPTION_KEY=TEST_KEY)
class CryptoRoundTripTests(SimpleTestCase):
    def test_round_trip(self):
        self.assertEqual(crypto.decrypt(crypto.encrypt("token-abc")), "token-abc")

    def test_empty(self):
        self.assertEqual(crypto.encrypt(""), "")
        self.assertEqual(crypto.decrypt(""), "")


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


class LoginIdentityTests(TestCase):
    """Un'org già collegata dà il SALONE, mai l'utente titolare: chi accede
    entra con la propria identità Yourang."""

    def test_mapped_org_does_not_return_the_owner(self):
        from apps.accounts.models import Membership, User
        from apps.core.models import Salon
        from apps.integrations.login import _resolve_salon
        from apps.integrations.models import YourangConnection

        salon = Salon.objects.create(name="Salone", slug="salone-org")
        owner = User.objects.create_user(email="titolare@x.it", password=None)
        Membership.objects.create(user=owner, salon=salon, is_owner=True)
        YourangConnection.objects.create(salon=salon, yourang_org_id="org3")

        self.assertEqual(
            _resolve_salon("org3", "collega@x.it", True), (salon, None)
        )

    def test_unverified_email_cannot_take_over_an_existing_account(self):
        """Guardia anti account-takeover: un'identità Yourang con la stessa
        email ma NON verificata non entra in un account beauty già esistente."""
        from apps.accounts.models import User
        from apps.integrations.login import _get_or_create_user

        User.objects.create_user(email="titolare@salone.it", password=None)
        with self.assertRaises(ValueError):
            _get_or_create_user("Titolare@Salone.it", "Mario Rossi", email_verified=False)
        # Verificata: si adotta l'account esistente, non se ne crea un secondo.
        adopted = _get_or_create_user("Titolare@Salone.it", "Mario Rossi", email_verified=True)
        self.assertEqual(adopted.email, "titolare@salone.it")
        self.assertEqual(User.objects.filter(email__iexact="titolare@salone.it").count(), 1)

    def test_identity_without_org_is_refused(self):
        """Senza organizzazione il connect rifiuta: il login faceva passare, e
        ogni accesso provisionava un salone nuovo e vuoto."""
        from apps.core.models import Salon
        from apps.integrations.login import login_with_yourang

        before = Salon.objects.count()
        identity = {"email": "nuovo@x.it", "email_verified": True, "name": "Nuovo"}
        with patch("apps.integrations.login.yc.exchange_code",
                   return_value={"access_token": "tok", "id_token": "idt"}), \
             patch("apps.integrations.login.yc.org_id_from_access_token", return_value=""), \
             patch("apps.integrations.login.yc.claims_from_token", return_value=identity):
            with self.assertRaises(ValueError):
                login_with_yourang("code-1", "verifier-1")
        self.assertEqual(Salon.objects.count(), before)


class ImportEventIdempotencyTests(TestCase):
    def setUp(self):
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="Test Salon", slug="test-salon")
        Operator.objects.create(salon=self.salon, first_name="Anna", last_name="B")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org1")

    def test_same_event_upserts_once(self):
        from apps.agenda.models import Appointment

        event = {
            "id": "evt-1",
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-1")
            import_event(self.conn, "evt-1")

        self.assertEqual(Appointment.objects.filter(yourang_event_id="evt-1").count(), 1)

    def test_redelivery_keeps_what_the_salon_decided(self):
        """Contare le righe non basta: la ri-consegna riscriveva operatrice,
        stato e nota decisi in salone (check-in annullato, nota sparita,
        appuntamento riportato sull'operatrice di default)."""
        from apps.agenda.models import Appointment
        from apps.staff.models import Operator

        giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", order=9)
        event = {
            "id": "evt-3",
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-3")

        appt = Appointment.objects.get(yourang_event_id="evt-3")
        appt.operator = giulia
        appt.status = Appointment.Status.CHECKED_IN
        appt.note = "Allergica alla tinta"
        appt.save()

        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-3")

        appt.refresh_from_db()
        self.assertEqual(appt.operator_id, giulia.id)
        self.assertEqual(appt.status, Appointment.Status.CHECKED_IN)
        self.assertEqual(appt.note, "Allergica alla tinta")

    def test_redelivery_does_not_reopen_a_closed_appointment(self):
        from apps.agenda.models import Appointment

        event = {
            "id": "evt-4",
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-4")
        appt = Appointment.objects.get(yourang_event_id="evt-4")
        appt.status = Appointment.Status.CLOSED
        appt.save(update_fields=["status"])

        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-4")
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CLOSED)

    def test_remote_cancellation_still_wins(self):
        """Non riportare indietro lo stato non deve diventare "ignorare Yourang":
        una disdetta remota su un appuntamento confermato passa."""
        from apps.agenda.models import Appointment

        event = {
            "id": "evt-5",
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-5")
        with patch("apps.integrations.sync.YourangClient.get_event",
                   return_value={**event, "status": "cancelled"}):
            import_event(self.conn, "evt-5")

        self.assertEqual(
            Appointment.objects.get(yourang_event_id="evt-5").status,
            Appointment.Status.CANCELLED,
        )

    def test_client_is_deduplicated_on_the_phone_key(self):
        """La scheda si ritrova sulla chiave normalizzata: "348 221 0094" e
        "+39 348 2210094" sono la stessa cliente, non due."""
        from apps.clients.models import Client

        existing = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="348 221 0094"
        )
        event = {
            "id": "evt-6",
            "client_full_name": "Anna Verdi",
            "client_phone_number": "+39 348 2210094",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            appt = import_event(self.conn, "evt-6")

        self.assertEqual(appt.client_id, existing.id)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)

    def test_new_client_gets_since(self):
        from apps.clients.models import Client

        event = {
            "id": "evt-7",
            "client_full_name": "Nuova Cliente",
            "client_phone_number": "3480000001",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-7")
        self.assertIsNotNone(Client.objects.get(salon=self.salon, phone="+393480000001").since)

    def test_placeholder_service_is_not_public(self):
        """Il segnaposto non deve comparire nel listino pubblico né essere
        rispinto su Yourang a 0 €."""
        from apps.catalog.models import Service

        event = {
            "id": "evt-8",
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=event):
            import_event(self.conn, "evt-8")
        svc = Service.objects.get(salon=self.salon, name_it="Prenotazione Yourang")
        self.assertFalse(svc.active)

    def test_changed_duration_updates_the_local_item(self):
        from apps.agenda.models import Appointment

        base = {
            "id": "evt-2",
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": "2026-08-01T10:00:00+02:00",
            "ending_date": "2026-08-01T11:00:00+02:00",
            "status": "confirmed",
        }
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=base):
            import_event(self.conn, "evt-2")
        appt = Appointment.objects.get(yourang_event_id="evt-2")
        self.assertEqual(appt.total_duration_min, 60)

        longer = {**base, "ending_date": "2026-08-01T12:00:00+02:00"}
        with patch("apps.integrations.sync.YourangClient.get_event", return_value=longer):
            import_event(self.conn, "evt-2")
        appt.refresh_from_db()
        self.assertEqual(appt.items.count(), 1)
        self.assertEqual(appt.total_duration_min, 120)


WEBHOOK_SECRET = "s3cret"


def _sign_webhook(body: bytes, ts: str, secret: str = WEBHOOK_SECRET) -> str:
    return "sha256=" + hmac.new(
        secret.encode(), f"{ts}.".encode() + body, hashlib.sha256
    ).hexdigest()


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
                "x-yourang-signature": signature or _sign_webhook(body, ts),
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


class CancelEventGuardTests(TestCase):
    """Stessa guardia, un gradino più in basso: chi chiama cancel_event
    direttamente (sync, comandi futuri) non deve poter svuotare l'agenda."""

    def setUp(self):
        from apps.clients.models import Client
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="Salone Cancel", slug="salone-cancel")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org-cancel")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Ada", phone="+393331110001"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Anna")

    def test_empty_event_id_cancels_nothing(self):
        from datetime import timedelta

        from django.utils import timezone as dj_timezone

        from apps.agenda.models import Appointment

        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=dj_timezone.now() + timedelta(days=1),
        )
        for empty in ("", None, "   "):
            cancel_event(self.conn, empty)
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CONFIRMED)


@override_settings(YOURANG_ISSUER_URL="https://api.example")
class ClientRequestTests(TestCase):
    """_request è mockato in tutti gli altri test: qui gira per davvero (con
    httpx finto) perché URL e header di autorizzazione non sono mai stati
    verificati da nessuno."""

    def setUp(self):
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        self.salon = Salon.objects.create(name="Salone HTTP", slug="salone-http")
        self.conn = YourangConnection.objects.create(
            salon=self.salon,
            yourang_org_id="org-http",
            access_token_enc=crypto.encrypt("tok-abc"),
            refresh_token_enc=crypto.encrypt("ref-abc"),
            expires_at=timezone.now() + timedelta(hours=1),
        )

    def _response(self, data):
        resp = Mock()
        resp.json.return_value = {"ok": True, "data": data}
        return resp

    def test_url_and_headers(self):
        from apps.integrations.client import YourangClient

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response([{"id": "c-1"}])) as req:
            out = YourangClient(self.conn).list_contacts(limit=50, offset=100)

        method, url = req.call_args.args
        self.assertEqual(method, "GET")
        self.assertEqual(
            url, "https://api.example/api/external/v1/contacts?limit=50&offset=100"
        )
        headers = req.call_args.kwargs["headers"]
        self.assertEqual(headers["Authorization"], "Bearer tok-abc")
        # Il flusso diretto parla per UN salone col token di quel salone: nessun
        # selettore di organizzazione da mandare (era un header del proxy).
        self.assertNotIn("X-Yourang-Org", headers)
        self.assertEqual(out, [{"id": "c-1"}])

    def test_remote_ids_are_percent_encoded(self):
        """httpx normalizza i dot-segment: un id ostile cambierebbe rotta alla
        chiamata (.../events/1/../../contacts diventa .../contacts)."""
        from apps.integrations.client import YourangClient

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response({})) as req:
            YourangClient(self.conn).get_event("1/../../contacts")
        self.assertEqual(
            req.call_args.args[1],
            "https://api.example/api/external/v1/events/1%2F..%2F..%2Fcontacts",
        )

        with patch("apps.integrations.client.httpx.request",
                   return_value=self._response({})) as req:
            YourangClient(self.conn).upsert_catalogue_item("a/../b", {"name": "x"})
        self.assertEqual(
            req.call_args.args[1],
            "https://api.example/api/external/v1/catalogues/items/a%2F..%2Fb",
        )

    def test_connection_without_tokens_never_calls_the_api(self):
        """Senza refresh token non c'è modo di autenticarsi: deve alzare prima
        di uscire in rete, non mandare una richiesta senza credenziali."""
        from apps.core.models import Salon
        from apps.integrations.client import YourangClient
        from apps.integrations.models import YourangConnection

        orphan = YourangConnection.objects.create(
            salon=Salon.objects.create(name="Orfano", slug="orfano"), yourang_org_id=""
        )
        with patch("apps.integrations.client.httpx.request") as req:
            with self.assertRaises(RuntimeError):
                YourangClient(orphan).list_contacts()
        req.assert_not_called()


class DisconnectTests(TestCase):
    """Alla disconnessione i riferimenti remoti devono sparire, o dopo una
    riconnessione clienti e listino non si sincronizzano mai più."""

    def test_disconnect_clears_remote_ids(self):
        from apps.catalog.models import Package, Service, ServiceCategory
        from apps.clients.models import Client
        from apps.core.models import Salon
        from apps.integrations.api import disconnect
        from apps.integrations.models import YourangConnection

        salon = Salon.objects.create(name="Salone Disc", slug="salone-disc")
        YourangConnection.objects.create(salon=salon, yourang_org_id="org-disc")
        client_obj = Client.objects.create(
            salon=salon, first_name="Ada", phone="+393331110002", yourang_contact_id="c-1"
        )
        cat = ServiceCategory.objects.create(salon=salon, name_it="Capelli")
        svc = Service.objects.create(
            salon=salon, category=cat, name_it="Piega", duration_min=30, price=20,
            yourang_item_id="i-1",
        )
        pkg = Package.objects.create(salon=salon, name="Pacchetto", price=100,
                                     yourang_item_id="i-2")

        ctx = Mock(salon=salon, is_owner=True)
        disconnect(Mock(auth=ctx))

        client_obj.refresh_from_db()
        svc.refresh_from_db()
        pkg.refresh_from_db()
        self.assertEqual(client_obj.yourang_contact_id, "")
        self.assertEqual(svc.yourang_item_id, "")
        self.assertEqual(pkg.yourang_item_id, "")
        self.assertFalse(YourangConnection.objects.filter(salon=salon).exists())


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


class OrgUniquenessTests(TestCase):
    """Il guard applicativo non basta: due exchange simultanee lo superano e gli
    eventi finiscono nel salone sbagliato (il webhook risolve il salone dall'org)."""

    def test_the_database_refuses_a_second_salon_on_the_same_org(self):
        from django.db import IntegrityError, transaction

        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        first = Salon.objects.create(name="Primo", slug="primo-org")
        second = Salon.objects.create(name="Secondo", slug="secondo-org")
        YourangConnection.objects.create(salon=first, yourang_org_id="org-unica")

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                YourangConnection.objects.create(salon=second, yourang_org_id="org-unica")

    def test_many_connections_can_stay_unlinked(self):
        """Il vincolo è parziale: "" significa "non ancora collegata"."""
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        for i in range(3):
            salon = Salon.objects.create(name=f"Vuoto {i}", slug=f"vuoto-{i}")
            YourangConnection.objects.create(salon=salon, yourang_org_id="")
        self.assertEqual(YourangConnection.objects.filter(yourang_org_id="").count(), 3)
