"""Test essenziali accounts: login staff, refresh, flusso OTP completo, ruoli default.

Nota: i test HTTP passano dalla NinjaAPI montata in config/api.py, quindi
richiedono che tutte le app di dominio siano presenti (post-integrazione).
"""

import json

from django.test import TestCase

from apps.core.models import OutboxEvent, Salon

from .models import ClientOTP, Membership, Role, User
from .services import ensure_default_roles


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


class ClientOTPSecurityTests(TestCase):
    """Login OTP: limite ai tentativi errati, limite alle richieste, numero
    riconosciuto comunque sia scritto, codice mai nei log."""

    URL_REQUEST = "/api/auth/client/request-otp"
    URL_VERIFY = "/api/auth/client/verify-otp"

    def setUp(self):
        from django.core.cache import cache

        from apps.clients.models import Client

        cache.clear()  # il limite alle richieste vive in cache
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+39 333 1234567", lang="it"
        )

    def _request_otp(self, phone):
        return post_json(self.client, self.URL_REQUEST, {"salon_slug": "the-parlour", "phone": phone})

    def _verify(self, phone, code):
        return post_json(
            self.client, self.URL_VERIFY, {"salon_slug": "the-parlour", "phone": phone, "code": code}
        )

    def test_phone_spelling_variants_reach_the_same_client(self):
        for phone in ("3331234567", "+393331234567", "0039 333 1234567"):
            self.assertEqual(self._request_otp(phone).status_code, 200, phone)
        self.assertEqual(ClientOTP.objects.filter(client=self.client_obj).count(), 3)

    def test_wrong_codes_burn_the_otp_after_five_attempts(self):
        self.assertEqual(self._request_otp("+393331234567").status_code, 200)
        otp = ClientOTP.objects.get(client=self.client_obj)
        wrong = "000000" if otp.code != "000000" else "111111"
        statuses = [self._verify("3331234567", wrong).status_code for _ in range(5)]
        self.assertEqual(statuses, [400, 400, 400, 400, 429])
        # il codice giusto ormai non vale più: serve richiederne uno nuovo
        self.assertEqual(self._verify("3331234567", otp.code).status_code, 400)
        otp.refresh_from_db()
        self.assertTrue(otp.used)

    def test_otp_requests_are_rate_limited_per_client(self):
        # I codici vengono consumati a ogni giro per isolare il limite per finestra
        # da quello sui codici attivi contemporanei (MAX_ACTIVE_OTP).
        for _ in range(5):
            self.assertEqual(self._request_otp("+393331234567").status_code, 200)
            ClientOTP.objects.filter(client=self.client_obj).update(used=True)
        self.assertEqual(self._request_otp("+393331234567").status_code, 429)

    def test_outbox_log_never_contains_the_code(self):
        with self.assertLogs("youty.events", level="INFO") as logs:
            self.assertEqual(self._request_otp("+393331234567").status_code, 200)
        otp = ClientOTP.objects.get(client=self.client_obj)
        self.assertFalse(any(otp.code in line for line in logs.output), logs.output)


class ClientRegisterRateLimitTests(TestCase):
    """La registrazione è pubblica e ogni successo accoda un messaggio a spese
    del salone: senza tetto uno script crea schede e manda codici a raffica."""

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _register(self, phone, ip="203.0.113.7"):
        return post_json(
            self.client,
            "/api/auth/client/register",
            {
                "salon_slug": "the-parlour",
                "first_name": "Sofia",
                "last_name": "Ricci",
                "phone": phone,
            },
            REMOTE_ADDR=ip,
        )

    def test_the_sixth_registration_from_one_address_is_refused(self):
        statuses = [self._register(f"+39333111{n:04d}").status_code for n in range(6)]
        self.assertEqual(statuses, [200, 200, 200, 200, 200, 429])
        # nessuna scheda creata per la richiesta rifiutata
        from apps.clients.models import Client

        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 5)

    def test_a_different_address_is_counted_separately(self):
        for n in range(5):
            self.assertEqual(self._register(f"+39333222{n:04d}").status_code, 200)
        self.assertEqual(self._register("+393339999999", ip="198.51.100.4").status_code, 200)

    def test_the_last_proxy_hop_is_what_counts(self):
        """X-Forwarded-For è scrivibile dal client: se contasse il primo elemento
        basterebbe cambiare un header a ogni richiesta per aggirare il tetto."""
        for n in range(5):
            res = self.client.post(
                "/api/auth/client/register",
                data=json.dumps({
                    "salon_slug": "the-parlour", "first_name": "Sofia",
                    "last_name": "Ricci", "phone": f"+39333333{n:04d}",
                }),
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"10.0.0.{n}, 203.0.113.9",
            )
            self.assertEqual(res.status_code, 200, res.content)
        res = self.client.post(
            "/api/auth/client/register",
            data=json.dumps({
                "salon_slug": "the-parlour", "first_name": "Sofia",
                "last_name": "Ricci", "phone": "+393334440000",
            }),
            content_type="application/json",
            HTTP_X_FORWARDED_FOR="10.0.0.99, 203.0.113.9",
        )
        self.assertEqual(res.status_code, 429)


class InvitationPasswordTests(TestCase):
    """Un invito non deve poter creare un account senza password vera.

    Accettando l'invito con password vuota l'account nasceva comunque, e poi il
    login con quella stessa password vuota funzionava.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.role = Role.objects.create(salon=self.salon, name="Front Desk", scopes=["agenda"])

    def _accept(self, invitation, password):
        return post_json(
            self.client,
            "/api/auth/invitations/accept",
            {
                "token": str(invitation.token),
                "password": password,
                "first_name": "Giulia",
                "last_name": "Verdi",
            },
        )

    def test_empty_password_is_refused_and_the_invitation_stays_usable(self):
        from .models import Invitation

        invitation = Invitation.objects.create(
            salon=self.salon, email="giulia@parlour.it", role=self.role
        )
        refused = self._accept(invitation, "")
        self.assertEqual(refused.status_code, 400)
        self.assertFalse(User.objects.filter(email="giulia@parlour.it").exists())
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, Invitation.Status.PENDING)

        # Un rifiuto non brucia l'invito: con una password valida si entra.
        accepted = self._accept(invitation, "Cartellina-2026")
        self.assertEqual(accepted.status_code, 200, accepted.content)
        invitation.refresh_from_db()
        self.assertEqual(invitation.status, Invitation.Status.ACCEPTED)

    def test_short_and_common_passwords_are_refused(self):
        from .models import Invitation

        for password in ("abc", "password"):
            invitation = Invitation.objects.create(
                salon=self.salon, email=f"{password}@parlour.it", role=self.role
            )
            response = self._accept(invitation, password)
            self.assertEqual(response.status_code, 400, password)


class StaffLoginThrottleTests(TestCase):
    """Le credenziali staff non devono essere provabili all'infinito."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _login(self, password, ip="203.0.113.5"):
        return post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": password},
            REMOTE_ADDR=ip,
        )

    def test_repeated_wrong_passwords_get_throttled(self):
        from .api import LOGIN_MAX_PER_ACCOUNT

        statuses = [self._login("sbagliata").status_code for _ in range(LOGIN_MAX_PER_ACCOUNT)]
        self.assertEqual(set(statuses), {401})
        # Superato il tetto non si prova più, nemmeno con la password giusta.
        self.assertEqual(self._login("sbagliata").status_code, 429)
        self.assertEqual(self._login("segretissima").status_code, 429)

    def test_a_good_login_clears_the_counter(self):
        for _ in range(3):
            self._login("sbagliata")
        self.assertEqual(self._login("segretissima").status_code, 200)
        # Il contatore riparte: la collega che sbaglia tre volte e poi entra
        # non si trova bloccata al tentativo successivo.
        statuses = [self._login("sbagliata").status_code for _ in range(4)]
        self.assertEqual(set(statuses), {401})

    def test_the_cap_per_address_covers_many_accounts(self):
        from .api import LOGIN_MAX_PER_IP

        for n in range(LOGIN_MAX_PER_IP):
            post_json(
                self.client,
                "/api/auth/staff/login",
                {"email": f"tizia{n}@parlour.it", "password": "tentativo"},
                REMOTE_ADDR="203.0.113.6",
            )
        blocked = post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "altra@parlour.it", "password": "tentativo"},
            REMOTE_ADDR="203.0.113.6",
        )
        self.assertEqual(blocked.status_code, 429)
        # Un altro indirizzo non paga per quello bloccato.
        self.assertEqual(self._login("segretissima", ip="203.0.113.7").status_code, 200)
