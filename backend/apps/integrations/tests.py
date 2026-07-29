"""Self-check dell'integrazione Yourang: firma webhook, normalizzazione telefono,
round-trip cifratura, idempotenza import evento.

    python manage.py test apps.integrations
"""

import hashlib
import hmac
import time
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TestCase, override_settings

from apps.core.models import Salon

from . import crypto
from .models import YourangConnection
from .sync import import_event, normalize_phone

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


class PhoneTests(SimpleTestCase):
    def test_italian_default_cc(self):
        self.assertEqual(normalize_phone("333 1234567"), "+393331234567")

    def test_passthrough_e164(self):
        self.assertEqual(normalize_phone("+41 79 123 45 67"), "+41791234567")

    def test_double_zero_prefix(self):
        self.assertEqual(normalize_phone("0039 333 1234567"), "+393331234567")

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
        self.assertIn("/contacts/by-phone/", req.call_args.args[1])
        self.assertEqual(client.yourang_contact_id, "c-9")
        self.assertEqual(report.errors, [])


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


class GateTests(TestCase):
    """Gate a tre stati: active / no_credit / not_connected, e i codici che
    portano il motivo al frontend (412 non collegato, 402 credito esaurito)."""

    def setUp(self):
        self.salon = Salon.objects.create(name="Gate Salon", slug="gate-salon")

    def test_senza_connessione_e_not_connected(self):
        from .gate import NOT_CONNECTED, feature_state, yourang_available

        self.assertEqual(feature_state(self.salon), NOT_CONNECTED)
        self.assertFalse(yourang_available(self.salon))

    def test_connessione_attiva_e_active(self):
        from .gate import ACTIVE, feature_state, yourang_available

        YourangConnection.objects.create(
            salon=self.salon, status=YourangConnection.Status.CONNECTED
        )
        self.assertEqual(feature_state(self.salon), ACTIVE)
        self.assertTrue(yourang_available(self.salon))

    def test_credito_esaurito_e_no_credit_anche_se_connesso(self):
        from .gate import NO_CREDIT, feature_state

        YourangConnection.objects.create(
            salon=self.salon,
            status=YourangConnection.Status.CONNECTED,
            credit_exhausted=True,
        )
        self.assertEqual(feature_state(self.salon), NO_CREDIT)

    def test_connessione_in_errore_e_not_connected(self):
        from .gate import NOT_CONNECTED, feature_state

        YourangConnection.objects.create(
            salon=self.salon, status=YourangConnection.Status.ERROR
        )
        self.assertEqual(feature_state(self.salon), NOT_CONNECTED)

    def test_require_yourang_alza_412_se_non_collegato(self):
        from ninja.errors import HttpError

        from .gate import require_yourang

        with self.assertRaises(HttpError) as cm:
            require_yourang(self.salon)
        self.assertEqual(cm.exception.status_code, 412)

    def test_require_yourang_alza_402_se_senza_credito(self):
        from ninja.errors import HttpError

        from .gate import require_yourang

        YourangConnection.objects.create(
            salon=self.salon,
            status=YourangConnection.Status.CONNECTED,
            credit_exhausted=True,
        )
        with self.assertRaises(HttpError) as cm:
            require_yourang(self.salon)
        self.assertEqual(cm.exception.status_code, 402)

    def test_require_yourang_passa_se_attivo(self):
        from .gate import require_yourang

        YourangConnection.objects.create(
            salon=self.salon, status=YourangConnection.Status.CONNECTED
        )
        self.assertIsNotNone(require_yourang(self.salon))


class CreditDetectionTests(SimpleTestCase):
    """Riconoscimento della risposta "credito esaurito" (forma non ancora
    confermata da Yourang: la difesa è volutamente larga)."""

    def _resp(self, status, body=""):
        r = Mock()
        r.status_code = status
        r.text = body
        return r

    def test_402_e_credito_esaurito(self):
        from .client import is_credit_exhausted

        self.assertTrue(is_credit_exhausted(self._resp(402)))

    def test_403_con_marcatore_e_credito_esaurito(self):
        from .client import is_credit_exhausted

        self.assertTrue(
            is_credit_exhausted(self._resp(403, '{"code":"insufficient_credit"}'))
        )

    def test_400_con_messaggio_italiano(self):
        from .client import is_credit_exhausted

        self.assertTrue(
            is_credit_exhausted(self._resp(400, '{"detail":"Credito esaurito"}'))
        )

    def test_403_generico_non_e_credito(self):
        from .client import is_credit_exhausted

        self.assertFalse(is_credit_exhausted(self._resp(403, '{"code":"forbidden"}')))

    def test_404_non_e_mai_credito(self):
        from .client import is_credit_exhausted

        self.assertFalse(is_credit_exhausted(self._resp(404, "insufficient_credit")))


class CreditLatchTests(TestCase):
    """Il latch si accende sull'errore e si spegne alla prima chiamata riuscita."""

    def setUp(self):
        self.salon = Salon.objects.create(name="Latch Salon", slug="latch-salon")
        self.conn = YourangConnection.objects.create(
            salon=self.salon, status=YourangConnection.Status.CONNECTED
        )

    def test_chiamata_riuscita_spegne_il_latch(self):
        from .client import YourangClient

        self.conn.credit_exhausted = True
        self.conn.save(update_fields=["credit_exhausted"])
        client = YourangClient(self.conn)
        client._mark_credit(False)
        self.conn.refresh_from_db()
        self.assertFalse(self.conn.credit_exhausted)
        self.assertIsNone(self.conn.credit_exhausted_at)

    def test_errore_accende_il_latch_con_timestamp(self):
        from .client import YourangClient

        YourangClient(self.conn)._mark_credit(True)
        self.conn.refresh_from_db()
        self.assertTrue(self.conn.credit_exhausted)
        self.assertIsNotNone(self.conn.credit_exhausted_at)
        self.assertEqual(self.conn.feature_state, "no_credit")


class StripeConnectionTests(TestCase):
    """Connect Standard: `can_charge` è l'unico stato che autorizza un incasso."""

    def setUp(self):
        self.salon = Salon.objects.create(name="Stripe Salon", slug="stripe-salon")

    def _conn(self, **kw):
        from .models import StripeConnection

        defaults = {
            "salon": self.salon,
            "stripe_account_id": "acct_test123",
            "status": StripeConnection.Status.CONNECTED,
            "charges_enabled": True,
        }
        return StripeConnection.objects.create(**{**defaults, **kw})

    def test_collegato_e_abilitato_puo_incassare(self):
        self.assertTrue(self._conn().can_charge)

    def test_onboarding_incompleto_non_puo_incassare(self):
        # Collegato ma Stripe non ha ancora abilitato gli incassi.
        self.assertFalse(self._conn(charges_enabled=False).can_charge)

    def test_connessione_in_errore_non_puo_incassare(self):
        from .models import StripeConnection

        self.assertFalse(self._conn(status=StripeConnection.Status.ERROR).can_charge)

    def test_senza_account_id_non_puo_incassare(self):
        self.assertFalse(self._conn(stripe_account_id="").can_charge)

    def test_require_account_412_se_non_collegato(self):
        from ninja.errors import HttpError

        from .stripe_connect import require_account

        with self.assertRaises(HttpError) as cm:
            require_account(self.salon)
        self.assertEqual(cm.exception.status_code, 412)

    def test_require_account_412_se_incassi_non_abilitati(self):
        from ninja.errors import HttpError

        from .stripe_connect import require_account

        self._conn(charges_enabled=False)
        with self.assertRaises(HttpError) as cm:
            require_account(self.salon)
        self.assertEqual(cm.exception.status_code, 412)
        self.assertIn("verifica", str(cm.exception.message).lower())

    def test_require_account_restituisce_l_account(self):
        from .stripe_connect import require_account

        self._conn()
        self.assertEqual(require_account(self.salon), "acct_test123")

    def test_redirect_uri_dedicata_a_stripe(self):
        """Yourang e Stripe tornano entrambi con ?code&state: i percorsi vanno distinti."""
        from .stripe_connect import redirect_uri

        self.assertTrue(redirect_uri().endswith("/oauth-popup/stripe-done"))
