"""Accesso dello staff: login, refresh e sessioni, cambio password.

Nota: i test HTTP passano dalla NinjaAPI montata in config/api.py, quindi
richiedono che tutte le app di dominio siano presenti (post-integrazione).

Caccia del 22/09:
- 10-13: il cambio password ha un tetto sui tentativi;
- 10-11: i refresh senza `jti` non valgono più;
- 08-08: login con email doppie per maiuscole e con più saloni, scelta stabile.
"""

import datetime as dt
import json

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from common.auth import _encode

from ..models import Membership, Role, StaffRefreshToken, User


def post_json(client, url, data, **extra):
    return client.post(url, data=json.dumps(data), content_type="application/json", **extra)


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
        from ..api import LOGIN_MAX_PER_ACCOUNT

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
        from ..api import LOGIN_MAX_PER_IP

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


class StaffSessionTests(TestCase):
    """T14 + S3 + S7: cambiare la password caccia fuori davvero, e il refresh
    non è una sessione scorrevole infinita.

    I JWT sono stateless: finché non scadono valgono. Se il cambio password non
    li invalida, l'account compromesso resta compromesso per trenta giorni, ed
    è esattamente la situazione in cui la password si cambia."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)

    def _login(self, password="segretissima"):
        return post_json(
            self.client,
            "/api/auth/staff/login",
            {"email": "anna@parlour.it", "password": password},
        ).json()

    def _me(self, access):
        return self.client.get("/api/auth/me", HTTP_AUTHORIZATION=f"Bearer {access}")

    def _refresh(self, refresh):
        return post_json(self.client, "/api/auth/staff/refresh", {"refresh": refresh})

    def test_changing_the_password_kills_every_open_session(self):
        vecchia = self._login()
        self.assertEqual(self._me(vecchia["access"]).status_code, 200)

        cambio = post_json(
            self.client,
            "/api/auth/staff/password",
            {"current_password": "segretissima", "new_password": "Cartellina-2026"},
            HTTP_AUTHORIZATION=f"Bearer {vecchia['access']}",
        )
        self.assertEqual(cambio.status_code, 200, cambio.content)

        # L'access token di prima non apre più niente...
        self.assertEqual(self._me(vecchia["access"]).status_code, 401)
        # ...e il refresh non permette di rifarsene uno (era la strada con cui
        # un attaccante restava dentro a tempo indeterminato).
        self.assertEqual(self._refresh(vecchia["refresh"]).status_code, 401)
        # Chi ha cambiato la password resta operativo con i token nuovi.
        self.assertEqual(self._me(cambio.json()["access"]).status_code, 200)

    def test_a_password_set_outside_the_endpoint_kills_the_sessions_too(self):
        """S3: dall'admin Django, da `changepassword` o da uno script."""
        vecchia = self._login()
        self.user.set_password("Cartellina-2026")  # quello che fa il form dell'admin
        self.user.save()

        self.assertEqual(self._me(vecchia["access"]).status_code, 401)
        self.assertEqual(self._refresh(vecchia["refresh"]).status_code, 401)
        self.assertEqual(self.user.token_version, 1)

    def test_creating_a_user_does_not_burn_a_version(self):
        """Il primo set_password non è un cambio: nessuno da sloggare."""
        nuovo = User.objects.create_user(email="giulia@parlour.it", password="Cartellina-2026")
        self.assertEqual(nuovo.token_version, 0)

    def test_rehashing_the_same_password_does_not_log_anyone_out(self):
        """Django riscrive l'hash quando cambiano i parametri dell'hasher.

        Passa dalla stessa strada (set_password) ma con la STESSA password: se
        contasse come cambio, un aggiornamento di Django sloggherebbe l'intero
        salone al primo accesso di ciascuno."""
        prima = self.user.token_version
        self.user.set_password("segretissima")
        self.assertEqual(self.user.token_version, prima)

    def test_the_refresh_rotates_and_the_spent_one_stops_working(self):
        sessione = self._login()
        rinnovo = self._refresh(sessione["refresh"])
        self.assertEqual(rinnovo.status_code, 200)
        nuovo = rinnovo.json()["refresh"]
        self.assertNotEqual(nuovo, sessione["refresh"])
        # Quello nuovo funziona.
        self.assertEqual(self._refresh(nuovo).status_code, 200)

        # Il token speso resta buono per i pochi secondi di tolleranza (le
        # schede multiple della dashboard rinnovano insieme)...
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 200)
        # ...ma non oltre: la copia esfiltrata muore al primo rinnovo fatto dal
        # proprietario. Si sposta l'orologio sulle revoche già registrate.
        StaffRefreshToken.objects.filter(revoked_at__isnull=False).update(
            revoked_at=timezone.now() - dt.timedelta(minutes=5)
        )
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 401)

    def test_logout_revokes_the_session_server_side(self):
        """Il POST è nudo: nessun corpo da mandare, nessun 400 da gestire."""
        sessione = self._login()
        uscita = self.client.post(
            "/api/auth/staff/logout", HTTP_AUTHORIZATION=f"Bearer {sessione['access']}"
        )
        self.assertEqual(uscita.status_code, 200, uscita.content)
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 401)

    def test_logout_closes_every_device(self):
        """Il titolare che ha perso il telefono non ha in mano quel refresh."""
        telefono = self._login()
        computer = self._login()
        uscita = self.client.post(
            "/api/auth/staff/logout", HTTP_AUTHORIZATION=f"Bearer {computer['access']}"
        )
        self.assertEqual(uscita.status_code, 200, uscita.content)
        self.assertEqual(self._refresh(telefono["refresh"]).status_code, 401)
        self.assertEqual(self._refresh(computer["refresh"]).status_code, 401)

    def test_logout_closes_the_grace_window_too(self):
        """Chi esce è fuori subito, anche dal token appena ruotato.

        La tolleranza serve alle schede multiple che rinnovano insieme, non a
        far sopravvivere una sessione che qualcuno ha chiuso apposta."""
        sessione = self._login()
        rinnovo = self._refresh(sessione["refresh"]).json()
        uscita = self.client.post(
            "/api/auth/staff/logout", HTTP_AUTHORIZATION=f"Bearer {rinnovo['access']}"
        )
        self.assertEqual(uscita.status_code, 200, uscita.content)
        self.assertEqual(self._refresh(rinnovo["refresh"]).status_code, 401)
        self.assertEqual(self._refresh(sessione["refresh"]).status_code, 401)

    def test_a_login_leaves_exactly_one_live_session(self):
        self._login()
        self.assertEqual(
            StaffRefreshToken.objects.filter(user=self.user, revoked_at__isnull=True).count(), 1
        )


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
        from ..api import PASSWORD_CHANGE_MAX_PER_USER

        for n in range(PASSWORD_CHANGE_MAX_PER_USER):
            self.assertEqual(self._change(f"tentativo-{n}").status_code, 400)
        # Anche la password giusta, ormai, aspetta la fine della finestra.
        self.assertEqual(self._change("segretissima").status_code, 429)
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password("segretissima"))

    def test_the_right_current_password_clears_the_count(self):
        from ..api import PASSWORD_CHANGE_MAX_PER_USER

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
