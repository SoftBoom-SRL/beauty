"""Test essenziali accounts: login staff, refresh, flusso OTP completo, ruoli default.

Nota: i test HTTP passano dalla NinjaAPI montata in config/api.py, quindi
richiedono che tutte le app di dominio siano presenti (post-integrazione).
"""

import json
from unittest import mock

from django.test import TestCase, override_settings

from apps.core.models import OutboxEvent, Salon

from .models import ClientOTP, Membership, Role, User
from .services import _send_otp_sms, ensure_default_roles, issue_otp


def post_json(client, url, data, **extra):
    return client.post(url, data=json.dumps(data), content_type="application/json", **extra)


class DefaultRolesTests(TestCase):
    def test_ensure_default_roles_idempotente(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ensure_default_roles(salon)
        ensure_default_roles(salon)  # seconda chiamata: nessun duplicato
        roles = Role.objects.filter(salon=salon, is_system=True)
        self.assertEqual(roles.count(), 3)
        self.assertEqual(
            roles.get(name="Manager").scopes,
            ["agenda", "clients", "sales", "inventory", "pricing", "marketing"],
        )
        self.assertEqual(roles.get(name="Front desk").scopes, ["agenda", "clients", "sales"])
        self.assertEqual(roles.get(name="Operatrice").scopes, ["agenda", "clients"])


class StaffAuthTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(
            email="anna@parlour.it",
            password="segretissima",
            first_name="Anna",
            last_name="Bianchi",
        )
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _login(self):
        return post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": "segretissima"},
        )

    def test_login_ok(self):
        response = self._login()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("access", data)
        self.assertIn("refresh", data)
        self.assertTrue(data["is_owner"])
        self.assertEqual(data["user"]["email"], "anna@parlour.it")
        self.assertEqual(data["salon"]["slug"], "the-parlour")

    def test_login_credenziali_errate(self):
        response = post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": "sbagliata"},
        )
        self.assertEqual(response.status_code, 401)

    def test_refresh(self):
        tokens = self._login().json()
        response = post_json(self.client, "/api/auth/staff/refresh", {"refresh": tokens["refresh"]})
        self.assertEqual(response.status_code, 200)
        self.assertIn("access", response.json())
        # un access token non è un refresh token valido
        response = post_json(self.client, "/api/auth/staff/refresh", {"refresh": tokens["access"]})
        self.assertEqual(response.status_code, 401)

    def test_me(self):
        access = self._login().json()["access"]
        response = self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {access}")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["user"]["email"], "anna@parlour.it")
        self.assertTrue(data["is_owner"])


class ClientOTPFlowTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _make_client(self, phone="+393331234567"):
        from apps.clients.models import Client

        return Client.objects.create(
            salon=self.salon,
            first_name="Sofia",
            last_name="Ricci",
            phone=phone,
            lang="it",
        )

    def test_flusso_otp_completo(self):
        # 1. registrazione dalla web app → cliente + client.created + primo OTP
        response = post_json(
            self.client,
            "/api/auth/client/register",
            {
                "salon_slug": "the-parlour",
                "first_name": "Sofia",
                "last_name": "Ricci",
                "phone": "+393331234567",
                "lang": "it",
            },
        )
        self.assertEqual(response.status_code, 200)
        from apps.clients.models import Client

        client_obj = Client.objects.get(salon=self.salon, phone="+393331234567")
        self.assertTrue(
            OutboxEvent.objects.filter(salon=self.salon, event_type="client.created").exists()
        )

        # telefono duplicato → 400
        response = post_json(
            self.client,
            "/api/auth/client/register",
            {
                "salon_slug": "the-parlour",
                "first_name": "Sofia",
                "last_name": "Ricci",
                "phone": "+393331234567",
            },
        )
        self.assertEqual(response.status_code, 400)

        # 2. richiesta OTP → nuovo codice + evento client.otp con il codice
        response = post_json(
            self.client,
            "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567"},
        )
        self.assertEqual(response.status_code, 200)
        otp = ClientOTP.objects.filter(client=client_obj).latest("created_at")
        event = OutboxEvent.objects.filter(event_type="client.otp").latest("created_at")
        self.assertEqual(event.payload["code"], otp.code)
        self.assertEqual(event.payload["phone"], "+393331234567")

        # telefono sconosciuto → 404
        response = post_json(
            self.client,
            "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+390000000000"},
        )
        self.assertEqual(response.status_code, 404)

        # 3. verifica con codice sbagliato → 400
        wrong = "000000" if otp.code != "000000" else "111111"
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": wrong},
        )
        self.assertEqual(response.status_code, 400)

        # 4. verifica corretta → access token + profilo breve
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": otp.code},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        access = data["access"]
        self.assertEqual(data["client"]["first_name"], "Sofia")

        # il codice è monouso
        response = post_json(
            self.client,
            "/api/auth/client/verify-otp",
            {"salon_slug": "the-parlour", "phone": "+393331234567", "code": otp.code},
        )
        self.assertEqual(response.status_code, 400)

        # 5. profilo autenticato
        response = self.client.get(
            "/api/auth/client/me", HTTP_AUTHORIZATION=f"Bearer {access}"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["phone"], "+393331234567")

        # 6. aggiornamento profilo
        response = self.client.put(
            "/api/auth/client/me",
            data=json.dumps({"lang": "en", "email": "sofia@example.com"}),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {access}",
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["lang"], "en")
        self.assertEqual(data["email"], "sofia@example.com")

    def test_limite_otp_attivi(self):
        self._make_client()
        payload = {"salon_slug": "the-parlour", "phone": "+393331234567"}
        for _ in range(3):
            response = post_json(self.client, "/api/auth/client/request-otp", payload)
            self.assertEqual(response.status_code, 200)
        response = post_json(self.client, "/api/auth/client/request-otp", payload)
        self.assertEqual(response.status_code, 429)


class OtpSmsDeliveryTests(TestCase):
    """Consegna OTP via SMS (Twilio) con fallback sicuro se non configurato."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _client(self, phone="+393330000001", lang="it"):
        from apps.clients.models import Client

        return Client.objects.create(
            salon=self.salon, first_name="Test", last_name="Utente", phone=phone, lang=lang
        )

    def test_send_sms_senza_credenziali_ritorna_false(self):
        # default settings: nessuna credenziale Twilio → nessun invio
        self.assertFalse(_send_otp_sms("+393330000001", "123456", "it"))

    def test_issue_otp_crea_codice_anche_senza_twilio(self):
        otp = issue_otp(self._client())
        self.assertEqual(len(otp.code), 6)
        self.assertTrue(otp.code.isdigit())

    def test_issue_otp_invoca_il_sender_sms(self):
        c = self._client(phone="+393330000002")
        with mock.patch(
            "apps.accounts.services._send_otp_sms", return_value=True
        ) as m:
            otp = issue_otp(c)
        m.assert_called_once_with(c.phone, otp.code, c.lang)

    @override_settings(
        TWILIO_ACCOUNT_SID="AC_test",
        TWILIO_AUTH_TOKEN="tok_test",
        TWILIO_SMS_FROM="+390000000000",
    )
    def test_send_sms_usa_twilio_quando_configurato(self):
        import sys

        fake_client = mock.MagicMock()
        fake_rest = mock.MagicMock()
        fake_rest.Client = mock.MagicMock(return_value=fake_client)
        with mock.patch.dict(
            sys.modules, {"twilio": mock.MagicMock(), "twilio.rest": fake_rest}
        ):
            ok = _send_otp_sms("+393330000003", "654321", "it")
        self.assertTrue(ok)
        fake_client.messages.create.assert_called_once()
        _, kwargs = fake_client.messages.create.call_args
        self.assertEqual(kwargs.get("to"), "+393330000003")
        self.assertIn("654321", kwargs.get("body", ""))
