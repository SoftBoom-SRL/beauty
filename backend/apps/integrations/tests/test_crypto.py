"""Firma dei webhook Yourang (crypto.py)."""

import time

from django.test import SimpleTestCase

from apps.integrations import crypto

from .base import sign_webhook


class SignatureTests(SimpleTestCase):
    secret = "s3cret"

    def _sign(self, body: bytes, ts: str) -> str:
        return sign_webhook(body, ts, self.secret)

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
