"""Caccia del 22/09 — collegamento e accesso Yourang (flusso OAuth diretto).

11-01/10-02: il codice va legato alla finestra che ha avviato il flusso (nonce,
HMAC dello state) e un salone collegato non cambia org senza disconnettersi.
11-02/10-03: «Accedi con Yourang» collega da solo solo il salone di cui l'utente
è titolare, e solo se è uno; il collega che accede non ridefinisce una
connessione che funziona. 11-14: cambio org → riferimenti remoti azzerati.
18-15: primo accesso atomico. 11-18/17-13 (C9): last_error esposto e scritto dal
cron. 11-12: la prima sync gira fuori dalla richiesta.

Nati sul proxy, portati sul flusso diretto al merge con main (24/09), dove il
proxy è stato tolto (YR-502).

    python manage.py test apps.integrations.tests_caccia22_collegamento
"""

import json
from datetime import timedelta
from unittest import mock
from urllib.parse import parse_qs, urlparse

import jwt
from django.core.management import call_command
from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import crypto, sync
from apps.integrations.models import YourangConnection, YourangOAuthState
from apps.integrations.sync import SyncReport
from common.auth import create_staff_tokens

from .tests import TEST_KEY

EXCHANGE = "/api/integrations/yourang/oauth/exchange"
DIRECT = dict(
    YOURANG_ISSUER_URL="https://yourang.invalid",
    YOURANG_CLIENT_ID="beauty",
    YOURANG_CLIENT_SECRET="segreto-del-client",
    YOURANG_WEBHOOK_RECEIVER_URL="",
    FRONTEND_ORIGIN="https://beauty.example",
    ENCRYPTION_KEY=TEST_KEY,
)
DISCOVERY = {
    "authorization_endpoint": "https://app.yourang.invalid/oauth/authorize",
    "token_endpoint": "https://yourang.invalid/oauth/token",
}
RECEIVER = "https://api.beauty.example/api/integrations/yourang/webhook"
# Solo per firmare i JWT finti: il client ne legge i claim senza verificarli.
_JWT_KEY = "chiave-dei-test-per-i-jwt-finti-0123456789abcdef"


def _jwt(claims):
    return jwt.encode(claims, _JWT_KEY, algorithm="HS256")


def _token_resp(org, email="", *, verified=True, name=""):
    """Risposta del token endpoint: `org` nell'access token, l'identità nell'id_token."""
    return {
        "access_token": _jwt({"org": org, "sub": email or "u"}),
        "id_token": _jwt({"email": email, "email_verified": verified, "name": name}),
        "refresh_token": f"refresh-{org}",
        "expires_in": 3600,
        "scope": "openid contacts:read contacts:write events:read",
    }


def _member(salon, email, *, owner=False, scopes=None):
    user = User.objects.create_user(email=email, password="Segretissima-2026")
    role = Role.objects.create(salon=salon, name=f"R-{email}", scopes=scopes) if scopes else None
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=owner)
    return user


def _bearer(user, salon):
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


@override_settings(**DIRECT)
class _FlowCase(TestCase):
    def start(self, mode, headers=None):
        url = "/api/integrations/yourang/oauth/" + ("login/start" if mode == "login" else "start")
        with mock.patch("apps.integrations.client._discovery", return_value=DISCOVERY):
            r = self.client.get(url, **(headers or {}))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        query = parse_qs(urlparse(body["authorize_url"]).query)
        self.assertEqual(query["redirect_uri"], ["https://beauty.example/oauth-popup/done"])
        self.assertEqual(query["code_challenge_method"], ["S256"])
        state = query["state"][0]
        # Il modo sta nello state a database: con un salone è un collegamento.
        flow = YourangOAuthState.objects.get(state=state)
        self.assertEqual(flow.salon_id is None, mode == "login")
        return state, body["nonce"]

    def exchange(self, payload, headers=None):
        return self.client.post(
            EXCHANGE, data=json.dumps(payload), content_type="application/json", **(headers or {})
        )

    @staticmethod
    def redeem(token_resp=None):
        """Il token endpoint di Yourang: il codice vale `token_resp`."""
        return mock.patch("apps.integrations.client.exchange_code", return_value=token_resp)


class ConnectStateTests(_FlowCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = _member(self.salon, "owner@p.it", owner=True)
        self.auth = _bearer(self.owner, self.salon)

    def test_a_return_link_without_the_nonce_is_refused_before_redeeming(self):
        """/oauth-popup/done?code=…&state=… aperto in un'altra finestra: lo state
        è buono, ma il nonce sta solo nel sessionStorage di chi l'ha avviato."""
        state, _ = self.start("connect", self.auth)
        with self.redeem() as redeem:
            r = self.exchange({"code": "codice-altrui", "state": state}, self.auth)
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()  # il codice non si consuma
        # E nemmeno lo state: chi ha avviato il flusso può ancora completarlo.
        self.assertTrue(YourangOAuthState.objects.filter(state=state).exists())
        self.assertFalse(YourangConnection.objects.filter(salon=self.salon).exists())

    def test_a_nonce_opens_only_its_own_flow(self):
        state, _ = self.start("connect", self.auth)
        _, nonce_of_another_flow = self.start("connect", self.auth)
        with self.redeem() as redeem:
            for nonce in ("", "un-altro-nonce", nonce_of_another_flow):
                r = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
                self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

    def test_a_state_is_used_once(self):
        state, nonce = self.start("connect", self.auth)
        with self.redeem(_token_resp("org-legit")) as redeem, \
                mock.patch("apps.integrations.sync._run_in_background"):
            first = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
            again = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(again.status_code, 400, again.content)
        self.assertEqual(redeem.call_count, 1)

    def test_the_mode_comes_from_the_state_not_from_the_request(self):
        """Uno state di «Accedi» resta un accesso anche se arriva con la sessione
        del titolare e `mode: connect`: il salone di quella sessione non si tocca."""
        state, nonce = self.start("login")
        with self.redeem(_token_resp("org-sua", "altra@p.it", name="Altra")), \
                mock.patch("apps.integrations.sync._run_in_background"):
            r = self.exchange(
                {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["mode"], "login")
        self.assertEqual(r.json()["session"]["user"]["email"], "altra@p.it")
        self.assertFalse(YourangConnection.objects.filter(salon=self.salon).exists())

    def test_expired_state_is_refused(self):
        state, nonce = self.start("connect", self.auth)
        YourangOAuthState.objects.filter(state=state).update(
            created_at=timezone.now() - timedelta(minutes=11)
        )
        with self.redeem() as redeem:
            r = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("scaduto", r.json()["detail"])
        redeem.assert_not_called()

    def test_the_flow_started_here_connects_and_syncs_outside_the_request(self):
        state, nonce = self.start("connect", self.auth)
        with self.redeem(_token_resp("org-legit")), \
                override_settings(YOURANG_WEBHOOK_RECEIVER_URL=RECEIVER), \
                mock.patch("apps.integrations.client.YourangClient.register_webhook",
                           return_value="whsec-1") as register, \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            r = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["mode"], "connect")
        conn = YourangConnection.objects.get(salon=self.salon)
        self.assertEqual((conn.yourang_org_id, conn.connected_by_id), ("org-legit", self.owner.id))
        self.assertEqual(crypto.decrypt(conn.refresh_token_enc), "refresh-org-legit")
        register.assert_called_once_with(RECEIVER, ["contact.*", "event.*"])
        self.assertEqual(crypto.decrypt(conn.webhook_secret_enc), "whsec-1")
        background.assert_called_once_with(conn.pk)  # la sync non gira nella richiesta


class OrgChangeTests(_FlowCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = _member(self.salon, "owner@p.it", owner=True)
        self.auth = _bearer(self.owner, self.salon)
        self.linked = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567", yourang_contact_id="c-old"
        )
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.svc = Service.objects.create(
            salon=self.salon, category=cat, name_it="Piega", duration_min=30, price=20,
            yourang_item_id="i-old",
        )

    def _connect(self, org):
        state, nonce = self.start("connect", self.auth)
        with self.redeem(_token_resp(org)), \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            r = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
        return r, background

    def test_a_connected_salon_does_not_switch_org_without_disconnecting(self):
        YourangConnection.objects.create(
            salon=self.salon, yourang_org_id="org-legit", catalogue_id="cat-legit"
        )
        r, background = self._connect("org-altra")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("scollegalo", r.json()["detail"])
        conn = YourangConnection.objects.get(salon=self.salon)
        self.assertEqual((conn.yourang_org_id, conn.catalogue_id), ("org-legit", "cat-legit"))
        self.assertEqual(conn.access_token_enc, "")  # i token dell'altra org non ci finiscono
        self.linked.refresh_from_db()
        self.assertEqual(self.linked.yourang_contact_id, "c-old")
        background.assert_not_called()

    def test_reconnecting_the_same_org_keeps_the_links(self):
        YourangConnection.objects.create(
            salon=self.salon, yourang_org_id="org-legit", catalogue_id="cat-legit",
            status=YourangConnection.Status.ERROR, last_error="502 di ieri",
        )
        r, background = self._connect("org-legit")
        self.assertEqual(r.status_code, 200, r.content)
        conn = YourangConnection.objects.get(salon=self.salon)
        self.assertEqual(conn.status, YourangConnection.Status.CONNECTED)
        self.assertEqual((conn.last_error, conn.catalogue_id), ("", "cat-legit"))
        self.assertEqual(crypto.decrypt(conn.refresh_token_enc), "refresh-org-legit")
        self.linked.refresh_from_db()
        self.assertEqual(self.linked.yourang_contact_id, "c-old")
        background.assert_called_once_with(conn.pk)

    def test_new_org_on_a_freed_connection_drops_the_old_references(self):
        """11-14: riga senza org (liberata dalla 0004) ma con i riferimenti della
        vecchia: la nuova org non deve ereditarli."""
        YourangConnection.objects.create(
            salon=self.salon, yourang_org_id="", catalogue_id="cat-old",
            status=YourangConnection.Status.ERROR,
        )
        r, _ = self._connect("org-nuova")
        self.assertEqual(r.status_code, 200, r.content)
        conn = YourangConnection.objects.get(salon=self.salon)
        self.assertEqual((conn.yourang_org_id, conn.catalogue_id), ("org-nuova", ""))
        self.linked.refresh_from_db()
        self.svc.refresh_from_db()
        self.assertEqual((self.linked.yourang_contact_id, self.svc.yourang_item_id), ("", ""))

    def test_org_of_another_salon_is_still_refused(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        YourangConnection.objects.create(salon=other, yourang_org_id="org-presa")
        r, _ = self._connect("org-presa")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertFalse(YourangConnection.objects.filter(salon=self.salon).exists())

    def test_relink_writes_only_the_link_columns(self):
        """18-07: niente save() completo della copia letta (riscriveva
        catalogue_id / last_sync_at scritti nel frattempo dal cron)."""
        YourangConnection.objects.create(salon=self.salon, yourang_org_id="org-legit")
        real_save = YourangConnection.save
        seen = []

        def spy(instance, *args, **kwargs):
            seen.append(kwargs.get("update_fields"))
            return real_save(instance, *args, **kwargs)

        with mock.patch.object(YourangConnection, "save", spy):
            r, _ = self._connect("org-legit")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(seen)
        self.assertTrue(all(fields is not None for fields in seen), seen)
        self.assertTrue(all("last_sync_at" not in fields for fields in seen), seen)


class LoginAdoptionTests(_FlowCase):
    def _login(self, org, email, name=""):
        from apps.integrations.login import login_with_yourang

        with self.redeem(_token_resp(org, email, name=name)), \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            session = login_with_yourang("code", "verifier")
        return session, background

    def test_login_exchange_needs_the_flow_of_this_window(self):
        """Il link di ritorno dell'accesso di un altro, aperto qui: senza il nonce
        di questa finestra non entra nessuno (e lo state non si brucia)."""
        state, nonce = self.start("login")
        with self.redeem() as redeem:
            r = self.exchange({"code": "codice-altrui", "state": state})
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

        with self.redeem(_token_resp("org-nuova", "nuova@p.it", name="Nuova")), \
                mock.patch("apps.integrations.sync._run_in_background"):
            r = self.exchange({"code": "c", "state": state, "nonce": nonce})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["session"]["user"]["email"], "nuova@p.it")

    def test_staff_member_enters_but_does_not_link_the_salon_to_her_org(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        _member(salon, "owner@p.it", owner=True)
        op = _member(salon, "op@p.it", scopes=["agenda"])
        session, background = self._login("org-op", "op@p.it", "Op")
        self.assertEqual((session["salon"]["id"], session["user"]["id"]), (salon.id, op.id))
        self.assertFalse(session["is_owner"])
        self.assertFalse(YourangConnection.objects.filter(salon=salon).exists())
        self.assertFalse(YourangConnection.objects.filter(yourang_org_id="org-op").exists())
        background.assert_not_called()

    def test_owner_of_two_unlinked_salons_links_neither(self):
        s1 = Salon.objects.create(name="Salone Centro", slug="centro")
        s2 = Salon.objects.create(name="Salone Mare", slug="mare")
        user = User.objects.create_user(email="tit@p.it", password="x-Segretissima-1")
        Membership.objects.create(user=user, salon=s1, is_owner=True)
        Membership.objects.create(user=user, salon=s2, is_owner=True)
        session, background = self._login("org-mare", "tit@p.it", "T")
        self.assertIn(session["salon"]["id"], (s1.id, s2.id))
        self.assertFalse(YourangConnection.objects.exists())
        self.assertEqual(Salon.objects.count(), 2)  # nessun salone nuovo al posto di Mare
        background.assert_not_called()

    def test_owner_of_a_single_unlinked_salon_adopts_it(self):
        salon = Salon.objects.create(name="Salone Mare", slug="mare")
        linked = Salon.objects.create(name="Salone Centro", slug="centro")
        user = _member(salon, "tit@p.it", owner=True)
        Membership.objects.create(user=user, salon=linked, is_owner=True)
        YourangConnection.objects.create(salon=linked, yourang_org_id="org-centro")
        session, background = self._login("org-mare", "tit@p.it", "T")
        conn = YourangConnection.objects.get(yourang_org_id="org-mare")
        self.assertEqual((conn.salon_id, conn.connected_by_id), (salon.id, user.id))
        self.assertEqual(crypto.decrypt(conn.refresh_token_enc), "refresh-org-mare")
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertTrue(session["is_owner"])
        background.assert_called_once_with(conn.pk)

    def test_colleague_login_leaves_a_working_connection_alone(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = _member(salon, "owner@p.it", owner=True)
        YourangConnection.objects.create(
            salon=salon, yourang_org_id="org-x", connected_by=owner,
            access_token_enc=crypto.encrypt("tok-titolare"),
            refresh_token_enc=crypto.encrypt("ref-titolare"),
            expires_at=timezone.now() + timedelta(hours=1),
            last_error="Sincronizzazione parziale: x",
        )
        session, background = self._login("org-x", "collega@p.it", "C")
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertFalse(session["is_owner"])
        conn = YourangConnection.objects.get(salon=salon)
        self.assertEqual(conn.connected_by_id, owner.id)
        self.assertEqual(crypto.decrypt(conn.refresh_token_enc), "ref-titolare")
        self.assertEqual(conn.last_error, "Sincronizzazione parziale: x")
        background.assert_not_called()

    def test_a_login_of_the_org_repairs_a_connection_that_cannot_work(self):
        """Senza token (tutte, dopo la 0005 che riporta il flusso diretto) o in
        errore: il primo accesso con Yourang dell'org la rimette in piedi."""
        cases = {
            "senza token": {},
            "in errore": dict(
                access_token_enc="x", status=YourangConnection.Status.ERROR,
                last_error="502 di ieri",
            ),
        }
        for i, (label, extra) in enumerate(cases.items()):
            with self.subTest(label):
                salon = Salon.objects.create(name=f"Salone {i}", slug=f"salone-{i}")
                _member(salon, f"owner-{i}@p.it", owner=True)
                YourangConnection.objects.create(salon=salon, yourang_org_id=f"org-{i}", **extra)
                session, background = self._login(f"org-{i}", f"collega-{i}@p.it", "C")
                self.assertEqual(session["salon"]["id"], salon.id)
                conn = YourangConnection.objects.get(salon=salon)
                self.assertEqual(conn.status, YourangConnection.Status.CONNECTED)
                self.assertEqual(conn.last_error, "")
                self.assertEqual(crypto.decrypt(conn.refresh_token_enc), f"refresh-org-{i}")
                background.assert_called_once_with(conn.pk)

    def test_new_identity_gets_a_new_linked_salon(self):
        session, background = self._login("org-new", "new@p.it", "Nuovo")
        conn = YourangConnection.objects.get(yourang_org_id="org-new")
        self.assertEqual(session["salon"]["id"], conn.salon_id)
        self.assertTrue(session["is_owner"])
        self.assertTrue(conn.access_token_enc)
        background.assert_called_once_with(conn.pk)


class ConcurrentFirstLoginTests(_FlowCase):
    """18-15: due primi accessi della stessa org corrono su slug, email e vincolo
    dell'org. Chi perde non esce con un 500 né lascia un salone a metà: il suo
    giro torna indietro per intero e la risoluzione si rifà una volta."""

    TOKENS = _token_resp("org-doppia", "new@p.it", name="Nuovo")

    def _login_with(self, racing_enter):
        from apps.integrations import login

        with self.redeem(self.TOKENS), \
                mock.patch.object(login, "_enter", side_effect=racing_enter), \
                mock.patch("apps.integrations.sync._run_in_background"):
            return login.login_with_yourang("code", "verifier")

    def _racing(self, error, *, times=1):
        from apps.integrations import login

        real_enter = login._enter
        calls = {"n": 0}

        def racing_enter(*args, **kwargs):
            calls["n"] += 1
            result = real_enter(*args, **kwargs)
            if calls["n"] <= times:
                # Il vincitore ha committato fra la risoluzione e la scrittura:
                # qui lo simula l'errore che il database dà al perdente.
                raise error
            return result

        return racing_enter, calls

    def test_a_losing_first_login_retries_instead_of_failing(self):
        from apps.integrations.connection import ORG_TAKEN, OrgConflict

        for error in (IntegrityError("uniq_yourang_connection_org"), OrgConflict(ORG_TAKEN)):
            with self.subTest(error=type(error).__name__):
                YourangConnection.objects.all().delete()
                Membership.objects.all().delete()
                Salon.objects.all().delete()
                User.objects.all().delete()
                racing_enter, calls = self._racing(error)
                session = self._login_with(racing_enter)
                self.assertEqual(calls["n"], 2)
                # Il primo giro è stato annullato per intero: un salone, un utente.
                self.assertEqual(Salon.objects.count(), 1)
                self.assertEqual(User.objects.filter(email="new@p.it").count(), 1)
                conn = YourangConnection.objects.get(yourang_org_id="org-doppia")
                self.assertEqual(session["salon"]["id"], conn.salon_id)
                self.assertTrue(conn.access_token_enc)

    def test_a_second_failure_is_not_retried_forever(self):
        racing_enter, calls = self._racing(IntegrityError("ancora"), times=2)
        with self.assertRaises(IntegrityError):
            self._login_with(racing_enter)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(Salon.objects.count(), 0)

    def test_a_conflict_that_persists_is_a_409_not_a_500(self):
        from apps.integrations import login
        from apps.integrations.connection import ORG_TAKEN, OrgConflict

        state, nonce = self.start("login")
        with self.redeem(self.TOKENS), \
                mock.patch.object(login, "_enter", side_effect=OrgConflict(ORG_TAKEN)):
            r = self.exchange({"code": "c", "state": state, "nonce": nonce})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["detail"], ORG_TAKEN)


class StatusLastErrorTests(TestCase):
    """C9: GET /yourang/status espone last_error ("" se nessuno)."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.auth = _bearer(_member(self.salon, "owner@p.it", owner=True), self.salon)

    def _status(self):
        r = self.client.get("/api/integrations/yourang/status", **self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_last_error_is_exposed_in_every_state(self):
        self.assertEqual(self._status()["last_error"], "")
        conn = YourangConnection.objects.create(
            salon=self.salon, yourang_org_id="org-s", last_error="Sincronizzazione parziale: x"
        )
        body = self._status()
        self.assertTrue(body["connected"])
        self.assertEqual(body["last_error"], "Sincronizzazione parziale: x")
        conn.status = YourangConnection.Status.ERROR
        conn.last_error = "Yourang 502"
        conn.save()
        body = self._status()
        self.assertFalse(body["connected"])
        self.assertEqual((body["status"], body["last_error"]), ("error", "Yourang 502"))


class CronLastErrorTests(TestCase):
    def test_partial_errors_stay_written(self):
        salon = Salon.objects.create(name="Salone Cron", slug="salone-cron")
        conn = YourangConnection.objects.create(salon=salon, yourang_org_id="org-cron")
        partial = SyncReport(errors=["push +393331112223: 403 Forbidden"])
        with mock.patch("apps.integrations.management.commands.sync_yourang.sync_clients",
                        return_value=partial), \
                mock.patch("apps.integrations.management.commands.sync_yourang.sync_services",
                           return_value=SyncReport()):
            call_command("sync_yourang", verbosity=0, stdout=mock.Mock())
        conn.refresh_from_db()
        self.assertEqual(conn.status, YourangConnection.Status.CONNECTED)
        self.assertIn("403 Forbidden", conn.last_error)
        self.assertTrue(conn.last_error.startswith("Sincronizzazione parziale"))
        self.assertIsNotNone(conn.last_sync_at)

    def test_a_disconnect_during_the_run_is_not_resurrected(self):
        salon = Salon.objects.create(name="Salone Cron", slug="salone-cron")
        YourangConnection.objects.create(salon=salon, yourang_org_id="org-cron")

        def disconnect_meanwhile(conn):
            YourangConnection.objects.filter(pk=conn.pk).delete()
            return SyncReport()

        with mock.patch("apps.integrations.management.commands.sync_yourang.sync_clients",
                        side_effect=disconnect_meanwhile), \
                mock.patch("apps.integrations.management.commands.sync_yourang.sync_services",
                           return_value=SyncReport()):
            call_command("sync_yourang", verbosity=0, stdout=mock.Mock())
        self.assertFalse(YourangConnection.objects.exists())


class InitialSyncTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org-i")

    def test_outcome_is_written_on_the_connection(self):
        with mock.patch("apps.integrations.sync.sync_clients",
                        return_value=SyncReport(errors=["a", "b", "c", "d"])), \
                mock.patch("apps.integrations.sync.sync_services", return_value=SyncReport()):
            sync.initial_sync(self.conn.pk)
        self.conn.refresh_from_db()
        self.assertIsNotNone(self.conn.last_sync_at)
        self.assertEqual(self.conn.last_error, "Sincronizzazione parziale: a; b; c (+1 altri)")

    def test_a_crash_is_written_too(self):
        with mock.patch("apps.integrations.sync.sync_clients", side_effect=RuntimeError("Yourang giù")):
            sync.initial_sync(self.conn.pk)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_error, "Yourang giù")
        self.assertIsNone(self.conn.last_sync_at)

    def test_the_sync_stops_when_the_salon_is_disconnected_meanwhile(self):
        """Scollegato a sync in corso: niente contact-id dell'org vecchia sulle
        schede (la sync della nuova le salterebbe come già collegate)."""
        for i in range(3):
            Client.objects.create(salon=self.salon, first_name=f"C{i}", phone=f"+39333000000{i}")
        pushed = []

        def create_or_get(phone, payload):
            pushed.append(phone)
            if len(pushed) == 1:
                YourangConnection.objects.filter(pk=self.conn.pk).delete()
            return {"id": f"c-{len(pushed)}"}

        with mock.patch("apps.integrations.client.YourangClient.list_contacts", return_value=[]), \
                mock.patch("apps.integrations.client.YourangClient.create_or_get_contact",
                           side_effect=create_or_get):
            sync.initial_sync(self.conn.pk)
        self.assertEqual(len(pushed), 1)
        linked = Client.objects.filter(salon=self.salon).exclude(yourang_contact_id="")
        self.assertLessEqual(linked.count(), 1)
