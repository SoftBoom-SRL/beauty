"""Firma dei webhook e cifratura dei segreti Yourang (crypto.py)."""

import hashlib
import hmac
import time

from django.test import SimpleTestCase, override_settings

from apps.integrations import crypto

from .base import TEST_KEY


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


@override_settings(ENCRYPTION_KEY=TEST_KEY)
class CryptoRoundTripTests(SimpleTestCase):
    def test_round_trip(self):
        self.assertEqual(crypto.decrypt(crypto.encrypt("token-abc")), "token-abc")

    def test_empty(self):
        self.assertEqual(crypto.encrypt(""), "")
        self.assertEqual(crypto.decrypt(""), "")
