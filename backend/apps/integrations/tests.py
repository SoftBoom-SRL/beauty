"""Self-check dell'integrazione Yourang: firma webhook, normalizzazione telefono,
round-trip cifratura, idempotenza import evento.

    python manage.py test apps.integrations
"""

import hashlib
import hmac
import time
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings

from . import crypto
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
