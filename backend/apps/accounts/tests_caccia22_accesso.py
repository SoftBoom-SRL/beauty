"""Caccia del 22/09: accesso di staff e clienti.

- 16-01 / 10-04: i tetti per salone di OTP e registrazione non si riempiono più
  con numeri inventati o tentativi respinti;
- 10-14 / 18-12: il doppio invio della registrazione è un 400, non un 500;
- 10-13: il cambio password ha un tetto sui tentativi;
- 10-11: i refresh senza `jti` non valgono più;
- 08-08: login con email doppie per maiuscole e con più saloni, scelta stabile;
- richiesta CLIENTI: la scheda archiviata che prova a entrare non resta un
  vicolo cieco muto, e il profilo modificato dall'app avvisa la dashboard;
- 06-17 / C12: il profilo dell'app porta il consenso marketing.
"""

import datetime as dt
import json
from unittest import mock

from django.test import TestCase

from apps.core.models import ActivityLog, Salon
from common import ratelimit
from common.auth import _encode, create_client_tokens

from .models import ClientOTP, Membership, Role, User


def post_json(client, url, data, **extra):
    return client.post(url, data=json.dumps(data), content_type="application/json", **extra)


def _client_model():
    from apps.clients.models import Client

    return Client


class OtpSalonCapTests(TestCase):
    """16-01: il tetto per salone si riempiva con numeri inventati."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sofia = _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567"
        )

    def _otp(self, phone, ip):
        return post_json(
            self.client,
            "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": phone},
            REMOTE_ADDR=ip,
        )

    def test_invented_numbers_from_a_few_addresses_do_not_lock_the_real_client_out(self):
        # Cento richieste su numeri inesistenti da cinque reti, venti ciascuna
        # (sotto il tetto per IP): nessun codice parte.
        for i in range(100):
            self.assertEqual(self._otp(f"+39333{i:07d}", f"203.0.113.{i % 5 + 1}").status_code, 200)
        # La cliente vera, da casa sua, riceve il codice.
        res = self._otp("+393331234567", "198.51.100.7")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(ClientOTP.objects.filter(client=self.sofia).count(), 1)

    def test_many_requests_are_still_reported(self):
        from .api import OTP_ALERT_PER_SALON

        with self.assertLogs("apps.accounts.api", level="WARNING") as logs:
            for i in range(OTP_ALERT_PER_SALON + 1):
                self._otp(f"+39333{i:07d}", f"203.0.113.{i % 5 + 1}")
        self.assertTrue(any("molte richieste" in line for line in logs.output), logs.output)

    def test_the_cap_on_issued_codes_answers_the_same_for_every_number(self):
        """Pieno di codici veri, il salone si ferma per tutti allo stesso modo."""
        with mock.patch("apps.accounts.api.OTP_MAX_ISSUED_PER_SALON", 1):
            self.assertEqual(self._otp("+393331234567", "198.51.100.7").status_code, 200)
            known = self._otp("+393331234567", "198.51.100.8")
            unknown = self._otp("+393339999999", "198.51.100.9")
        self.assertEqual(known.status_code, 429)
        self.assertEqual((known.status_code, known.content), (unknown.status_code, unknown.content))
        self.assertEqual(ClientOTP.objects.filter(client=self.sofia).count(), 1)

    def test_codes_withheld_by_the_client_cap_do_not_count(self):
        # Il sesto codice della stessa cliente non parte (tetto per cliente):
        # non deve consumare il budget del salone.
        for _ in range(6):
            self._otp("+393331234567", "198.51.100.7")
            ClientOTP.objects.filter(client=self.sofia).update(used=True)
        self.assertEqual(ratelimit.peek(f"otp-issued-salon:{self.salon.id}"), 5)


class RegisterSalonCapTests(TestCase):
    """10-04: il tetto per salone della registrazione contava anche i rifiuti."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567"
        )

    def _register(self, phone, ip):
        return post_json(
            self.client,
            "/api/auth/client/register",
            {"salon_slug": "the-parlour", "first_name": "Nuova", "last_name": "Cliente", "phone": phone},
            REMOTE_ADDR=ip,
        )

    def test_refused_attempts_do_not_fill_the_salon_cap(self):
        with mock.patch("apps.accounts.api.REGISTER_MAX_PER_SALON", 2):
            for n in range(4):
                self.assertEqual(self._register("+393331234567", f"203.0.113.{n + 1}").status_code, 400)
            res = self._register("+393335550001", "198.51.100.7")
        self.assertEqual(res.status_code, 200, res.content)

    def test_created_profiles_are_still_capped(self):
        with mock.patch("apps.accounts.api.REGISTER_MAX_PER_SALON", 2):
            statuses = [
                self._register(f"+39333555000{n}", f"203.0.113.{n + 1}").status_code for n in range(3)
            ]
        self.assertEqual(statuses, [200, 200, 429])
        self.assertEqual(_client_model().objects.filter(salon=self.salon).count(), 3)


class RegisterDoubleSubmitTests(TestCase):
    """10-14 + 18-12: doppio tocco su «Registrati»."""

    def test_the_second_request_of_a_double_tap_is_a_400(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        Client = _client_model()
        # La prima richiesta ha appena inserito la scheda; la seconda aveva già
        # superato il controllo sul numero quando la prima non era ancora visibile.
        Client.objects.create(salon=salon, first_name="Sofia", last_name="Ricci", phone="+393331234567")
        self.client.raise_request_exception = False
        with mock.patch("apps.accounts.api.find_client_by_phone", return_value=None):
            res = post_json(
                self.client,
                "/api/auth/client/register",
                {"salon_slug": "the-parlour", "first_name": "Sofia", "last_name": "Ricci",
                 "phone": "+393331234567"},
            )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Client.objects.filter(salon=salon).count(), 1)
        self.assertFalse(ClientOTP.objects.exists())


class PasswordChangeThrottleTests(TestCase):
    """10-13: la password attuale non si indovina a raffica con un access token rubato."""

    URL = "/api/auth/staff/password"

    def setUp(self):
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }

    def _change(self, current, new="Cartellina-2026"):
        return post_json(
            self.client, self.URL, {"current_password": current, "new_password": new}, **self.auth
        )

    def test_guessing_the_current_password_is_capped(self):
        from .api import PASSWORD_CHANGE_MAX_PER_USER

        for n in range(PASSWORD_CHANGE_MAX_PER_USER):
            self.assertEqual(self._change(f"tentativo-{n}").status_code, 400)
        # Anche la password giusta, ormai, aspetta la fine della finestra.
        self.assertEqual(self._change("segretissima").status_code, 429)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("segretissima"))

    def test_the_right_current_password_clears_the_count(self):
        from .api import PASSWORD_CHANGE_MAX_PER_USER

        for n in range(PASSWORD_CHANGE_MAX_PER_USER - 1):
            self.assertEqual(self._change(f"tentativo-{n}").status_code, 400)
        # Password attuale giusta ma nuova troppo corta: rifiutata dalle regole,
        # non dal tetto, e i tentativi ripartono da zero.
        self.assertEqual(self._change("segretissima", new="corta").status_code, 400)
        self.assertEqual(self._change("tentativo-x").status_code, 400)
        self.assertEqual(self._change("segretissima").status_code, 200)


class LegacyRefreshTests(TestCase):
    """10-11: un refresh senza `jti` non ha una riga da revocare."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _refresh(self, token):
        return post_json(self.client, "/api/auth/staff/refresh", {"refresh": token})

    def test_a_refresh_without_jti_is_refused(self):
        legacy = _encode(
            {"sub": str(self.user.id), "salon": self.salon.id, "tv": 0, "typ": "staff_refresh"},
            dt.timedelta(days=30),
        )
        res = self._refresh(legacy)
        self.assertEqual(res.status_code, 401, res.content)
        # E non torna buono al secondo tentativo, né dopo un'uscita.
        self.assertEqual(self._refresh(legacy).status_code, 401)

    def test_tracked_refreshes_still_work(self):
        login = post_json(
            self.client, "/api/auth/staff/login", {"email": "anna@parlour.it", "password": "segretissima"}
        ).json()
        self.assertEqual(self._refresh(login["refresh"]).status_code, 200)


class StaffLoginChoiceTests(TestCase):
    """08-08: email doppie per maiuscole e più membership, scelta deterministica."""

    def _login(self, email, password):
        return post_json(self.client, "/api/auth/staff/login", {"email": email, "password": password})

    def test_case_duplicates_log_into_the_account_whose_password_matches(self):
        first = Salon.objects.create(name="Primo", slug="primo")
        second = Salon.objects.create(name="Secondo", slug="secondo")
        lower = User.objects.create_user(email="anna@parlour.it", password="Password-Prima-1")
        upper = User.objects.create_user(email="Anna@parlour.it", password="Password-Seconda-2")
        Membership.objects.create(user=lower, salon=first, is_owner=True)
        Membership.objects.create(user=upper, salon=second, is_owner=True)

        res = self._login("anna@parlour.it", "Password-Seconda-2")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["salon"]["slug"], "secondo")
        res = self._login("ANNA@parlour.it", "Password-Prima-1")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["salon"]["slug"], "primo")
        self.assertEqual(self._login("anna@parlour.it", "sbagliata-del-tutto").status_code, 401)

    def test_the_salon_where_she_is_owner_wins_over_an_older_membership(self):
        old = Salon.objects.create(name="Vecchio", slug="vecchio")
        mine = Salon.objects.create(name="Mio", slug="mio")
        user = User.objects.create_user(email="giulia@parlour.it", password="Password-Giulia-1")
        Membership.objects.create(user=user, salon=old)  # ex collaboratrice, nessun ruolo
        Membership.objects.create(user=user, salon=mine, is_owner=True)
        res = self._login("giulia@parlour.it", "Password-Giulia-1")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["salon"]["slug"], "mio")

    def test_a_membership_with_a_role_wins_over_one_without(self):
        empty = Salon.objects.create(name="Senza ruolo", slug="senza-ruolo")
        working = Salon.objects.create(name="Con ruolo", slug="con-ruolo")
        user = User.objects.create_user(email="bea@parlour.it", password="Password-Bea-1")
        Membership.objects.create(user=user, salon=empty)
        role = Role.objects.create(salon=working, name="Operatrice", scopes=["agenda"])
        Membership.objects.create(user=user, salon=working, role=role)
        res = self._login("bea@parlour.it", "Password-Bea-1")
        self.assertEqual(res.json()["salon"]["slug"], "con-ruolo")

    def test_two_owner_memberships_keep_the_oldest(self):
        first = Salon.objects.create(name="Primo", slug="primo")
        second = Salon.objects.create(name="Secondo", slug="secondo")
        user = User.objects.create_user(email="cora@parlour.it", password="Password-Cora-1")
        Membership.objects.create(user=user, salon=first, is_owner=True)
        Membership.objects.create(user=user, salon=second, is_owner=True)
        for _ in range(2):
            res = self._login("cora@parlour.it", "Password-Cora-1")
            self.assertEqual(res.json()["salon"]["slug"], "primo")


class ArchivedClientAccessTests(TestCase):
    """Richiesta CLIENTI: la scheda archiviata che prova a entrare dall'app."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.archived = _client_model().objects.create(
            salon=self.salon, first_name="Xenia", last_name="Rossi", phone="+393331112233",
            is_active=False,
        )

    def _notices(self):
        return ActivityLog.objects.filter(salon=self.salon, type="client.reactivation_requested")

    def test_the_salon_is_told_and_the_answer_does_not_reveal_anything(self):
        archived = post_json(
            self.client, "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "333 111 2233"},
        )
        unknown = post_json(
            self.client, "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+393339998877"},
        )
        self.assertEqual((archived.status_code, archived.content), (unknown.status_code, unknown.content))
        # Nessun codice alla scheda archiviata, e la scheda resta archiviata…
        self.assertFalse(ClientOTP.objects.filter(client=self.archived).exists())
        self.archived.refresh_from_db()
        self.assertFalse(self.archived.is_active)
        # …ma il salone lo sa, con la scheda da aprire.
        notice = self._notices().get()
        self.assertEqual(notice.payload["client_id"], self.archived.id)

    def test_one_notice_a_day_per_profile(self):
        for _ in range(3):
            post_json(
                self.client, "/api/auth/client/request-otp",
                {"salon_slug": "the-parlour", "phone": "+393331112233"},
            )
        res = post_json(
            self.client, "/api/auth/client/register",
            {"salon_slug": "the-parlour", "first_name": "Xenia", "last_name": "Rossi",
             "phone": "+393331112233"},
        )
        # La registrazione risponde come per una scheda attiva: l'app mostra la
        # schermata «numero già registrato» con «Chiama il salone».
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(self._notices().count(), 1)

    def test_an_active_client_raises_no_notice(self):
        _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393334445566"
        )
        post_json(
            self.client, "/api/auth/client/request-otp",
            {"salon_slug": "the-parlour", "phone": "+393334445566"},
        )
        self.assertFalse(self._notices().exists())


class ClientProfileTests(TestCase):
    """C12 + 18-07 + richiesta CLIENTI: profilo della cliente nell'app."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sofia = _client_model().objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567",
            consents={"privacy": True, "marketing": True, "card_charge": False},
        )
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.sofia)['access']}"}

    def _put(self, body):
        return self.client.put(
            "/api/auth/client/me", data=json.dumps(body), content_type="application/json", **self.auth
        )

    def test_the_profile_carries_the_marketing_consent(self):
        res = self.client.get("/api/auth/client/me", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIs(res.json()["marketing_consent"], True)
        self.sofia.consents = {"privacy": True, "marketing": False}
        self.sofia.save(update_fields=["consents"])
        self.assertIs(self.client.get("/api/auth/client/me", **self.auth).json()["marketing_consent"], False)

    def test_saving_from_the_app_does_not_overwrite_what_the_salon_changed_meanwhile(self):
        """La scheda è letta all'autenticazione; il salone la modifica prima del salvataggio."""
        from common.auth import ClientAuth

        original = ClientAuth.authenticate

        def authenticate_then_salon_edits(auth, request, token):
            ctx = original(auth, request, token)
            type(ctx.client).objects.filter(pk=ctx.client.pk).update(
                first_name="Sofia Maria", consents={"privacy": True, "marketing": False}
            )
            return ctx

        with mock.patch.object(ClientAuth, "authenticate", authenticate_then_salon_edits):
            res = self._put({"lang": "en"})
        self.assertEqual(res.status_code, 200, res.content)
        self.sofia.refresh_from_db()
        self.assertEqual(self.sofia.lang, "en")
        self.assertEqual(self.sofia.first_name, "Sofia Maria")
        self.assertIs(self.sofia.consents["marketing"], False)

    def test_a_change_from_the_app_reaches_the_open_dashboard_card(self):
        self.assertEqual(self._put({"email": "sofia@example.com"}).status_code, 200)
        event = ActivityLog.objects.get(salon=self.salon, type="client.updated")
        self.assertEqual(event.payload["client_id"], self.sofia.id)
        # Rimandare gli stessi valori non è una modifica: nessun nuovo evento.
        self.assertEqual(self._put({"email": "sofia@example.com"}).status_code, 200)
        self.assertEqual(ActivityLog.objects.filter(type="client.updated").count(), 1)
