"""Probe temporaneo del revisore 16 (app cliente). Da cancellare a fine lavoro."""

import json

from django.test import TestCase

from apps.core.models import Salon


class Probe16OtpLockout(TestCase):
    def setUp(self):
        from apps.clients.models import Client

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567"
        )

    def _otp(self, phone, ip):
        return self.client.post(
            "/api/auth/client/request-otp",
            data=json.dumps({"salon_slug": "the-parlour", "phone": phone}),
            content_type="application/json",
            REMOTE_ADDR=ip,
        )

    def test_numeri_inventati_da_tre_indirizzi_non_chiudono_fuori_la_cliente(self):
        # 60 richieste su numeri che NON esistono, da tre indirizzi pubblici
        # (20 ciascuno, sotto il tetto per IP): nessun SMS parte.
        for i in range(60):
            ip = f"203.0.113.{i % 3 + 1}"
            self.assertEqual(self._otp(f"+39333{i:07d}", ip).status_code, 200)
        # la cliente vera, da un altro indirizzo, chiede il suo codice
        res = self._otp("+393331234567", "198.51.100.7")
        print(f"\n[probe16 lockout] richiesta della cliente vera → {res.status_code} {res.content!r}")
        self.assertEqual(res.status_code, 200)
