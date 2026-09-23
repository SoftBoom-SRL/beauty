"""Caccia del 22/09 — collegamento e accesso Yourang.

11-01/10-02: il codice del proxy va legato al flusso avviato da questa finestra
(state firmato + nonce) e un salone collegato non cambia org senza disconnettersi.
11-02/10-03: «Accedi con Yourang» collega da solo solo il salone di cui l'utente
è titolare, e solo se è uno. 11-14: cambio org → riferimenti remoti azzerati.
18-15: primo accesso atomico. 11-18/17-13 (C9): last_error esposto e scritto dal
cron. 11-12: la prima sync gira fuori dalla richiesta.

    python manage.py test apps.integrations.tests_caccia22_collegamento
"""

import json
from unittest import mock
from urllib.parse import parse_qs, urlparse

from django.core.management import call_command
from django.db import IntegrityError
from django.test import TestCase, override_settings

from apps.accounts.models import Membership, Role, User
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import sync
from apps.integrations.models import YourangConnection
from apps.integrations.sync import SyncReport
from common.auth import create_staff_tokens

EXCHANGE = "/api/integrations/yourang/oauth/exchange"
PROXY = dict(
    YOURANG_PROXY_URL="https://proxy.invalid",
    YOURANG_PROXY_API_KEY="k",
    FRONTEND_ORIGIN="https://beauty.example",
)


def _member(salon, email, *, owner=False, scopes=None):
    user = User.objects.create_user(email=email, password="Segretissima-2026")
    role = Role.objects.create(salon=salon, name=f"R-{email}", scopes=scopes) if scopes else None
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=owner)
    return user


def _bearer(user, salon):
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


def _state_of(authorize_url: str) -> tuple[str, str]:
    """(mode, state) dal return_to che il proxy rimanderà indietro."""
    return_to = parse_qs(urlparse(authorize_url).query)["return_to"][0]
    params = parse_qs(urlparse(return_to).query)
    return params["mode"][0], params["state"][0]


@override_settings(**PROXY)
class _FlowCase(TestCase):
    def start(self, mode, headers=None):
        url = "/api/integrations/yourang/oauth/" + ("login/start" if mode == "login" else "start")
        r = self.client.get(url, **(headers or {}))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        got_mode, state = _state_of(body["authorize_url"])
        self.assertEqual(got_mode, mode)
        return state, body["nonce"]

    def exchange(self, payload, headers=None):
        return self.client.post(
            EXCHANGE, data=json.dumps(payload), content_type="application/json", **(headers or {})
        )


class ConnectStateTests(_FlowCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = _member(self.salon, "owner@p.it", owner=True)
        self.auth = _bearer(self.owner, self.salon)

    def test_code_from_a_link_without_the_flow_is_refused_before_redeeming(self):
        """/oauth-popup/done?mode=connect&yr_link=<codice altrui>: niente state/nonce."""
        with mock.patch("apps.integrations.client.redeem_link_code") as redeem:
            r = self.exchange({"code": "codice-dell-attaccante", "mode": "connect"}, self.auth)
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()  # il codice non si consuma e l'identità non si vede
        self.assertFalse(YourangConnection.objects.filter(salon=self.salon).exists())

    def test_state_of_another_session_is_refused(self):
        """L'attaccante avvia il SUO flusso (state e nonce validi, ma suoi):
        riscattato con la sessione del titolare non passa."""
        other = Salon.objects.create(name="Altro", slug="altro")
        attacker = _member(other, "evil@x.it", owner=True)
        state, nonce = self.start("connect", _bearer(attacker, other))
        with mock.patch("apps.integrations.client.redeem_link_code") as redeem:
            r = self.exchange(
                {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
            )
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

    def test_state_without_its_nonce_is_refused(self):
        state, _ = self.start("connect", self.auth)
        with mock.patch("apps.integrations.client.redeem_link_code") as redeem:
            for nonce in ("", "un-altro-nonce"):
                r = self.exchange(
                    {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
                )
                self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

    def test_login_state_does_not_open_a_connect(self):
        state, nonce = self.start("login")
        with mock.patch("apps.integrations.client.redeem_link_code") as redeem:
            r = self.exchange(
                {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
            )
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

    def test_expired_state_is_refused(self):
        state, nonce = self.start("connect", self.auth)
        import time as real_time

        later = real_time.time() + 16 * 60
        with mock.patch("django.core.signing.time.time", return_value=later), \
                mock.patch("apps.integrations.client.redeem_link_code") as redeem:
            r = self.exchange(
                {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
            )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("scaduto", r.json()["detail"])
        redeem.assert_not_called()

    def test_the_flow_started_here_connects_and_syncs_outside_the_request(self):
        state, nonce = self.start("connect", self.auth)
        with mock.patch("apps.integrations.client.redeem_link_code",
                        return_value={"org_id": "org-legit"}), \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            r = self.exchange(
                {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
            )
        self.assertEqual(r.status_code, 200, r.content)
        conn = YourangConnection.objects.get(salon=self.salon)
        self.assertEqual((conn.yourang_org_id, conn.connected_by_id), ("org-legit", self.owner.id))
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
        with mock.patch("apps.integrations.client.redeem_link_code",
                        return_value={"org_id": org}), \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            r = self.exchange(
                {"code": "c", "mode": "connect", "state": state, "nonce": nonce}, self.auth
            )
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
        self.assertNotIn("last_sync_at", seen[0])


@override_settings(**PROXY)
class LoginAdoptionTests(_FlowCase):
    def _login(self, identity):
        from apps.integrations.login import login_with_link_code

        with mock.patch("apps.integrations.client.redeem_link_code", return_value=identity), \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            session = login_with_link_code("code")
        return session, background

    def test_login_exchange_needs_the_flow_of_this_window(self):
        with mock.patch("apps.integrations.client.redeem_link_code") as redeem:
            r = self.exchange({"code": "codice-altrui", "mode": "login"})
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

        state, nonce = self.start("login")
        identity = {"org_id": "org-nuova", "email": "nuova@p.it", "email_verified": True,
                    "name": "Nuova"}
        with mock.patch("apps.integrations.client.redeem_link_code", return_value=identity), \
                mock.patch("apps.integrations.sync._run_in_background"):
            r = self.exchange({"code": "c", "mode": "login", "state": state, "nonce": nonce})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["session"]["user"]["email"], "nuova@p.it")

    def test_staff_member_enters_but_does_not_link_the_salon_to_her_org(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        _member(salon, "owner@p.it", owner=True)
        op = _member(salon, "op@p.it", scopes=["agenda"])
        session, background = self._login(
            {"org_id": "org-op", "email": "op@p.it", "email_verified": True, "name": "Op"}
        )
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
        session, background = self._login(
            {"org_id": "org-mare", "email": "tit@p.it", "email_verified": True, "name": "T"}
        )
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
        session, background = self._login(
            {"org_id": "org-mare", "email": "tit@p.it", "email_verified": True, "name": "T"}
        )
        conn = YourangConnection.objects.get(yourang_org_id="org-mare")
        self.assertEqual((conn.salon_id, conn.connected_by_id), (salon.id, user.id))
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertTrue(session["is_owner"])
        background.assert_called_once_with(conn.pk)

    def test_colleague_login_on_a_mapped_org_leaves_the_connection_alone(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = _member(salon, "owner@p.it", owner=True)
        YourangConnection.objects.create(
            salon=salon, yourang_org_id="org-x", connected_by=owner,
            status=YourangConnection.Status.ERROR, last_error="502 di ieri",
        )
        session, background = self._login(
            {"org_id": "org-x", "email": "collega@p.it", "email_verified": True, "name": "C"}
        )
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertFalse(session["is_owner"])
        conn = YourangConnection.objects.get(salon=salon)
        self.assertEqual(conn.connected_by_id, owner.id)
        self.assertEqual((conn.status, conn.last_error), ("error", "502 di ieri"))
        background.assert_not_called()

    def test_new_identity_gets_a_new_linked_salon(self):
        session, background = self._login(
            {"org_id": "org-new", "email": "new@p.it", "email_verified": True, "name": "Nuovo"}
        )
        conn = YourangConnection.objects.get(yourang_org_id="org-new")
        self.assertEqual(session["salon"]["id"], conn.salon_id)
        self.assertTrue(session["is_owner"])
        background.assert_called_once_with(conn.pk)


@override_settings(**PROXY)
class ConcurrentFirstLoginTests(TestCase):
    """18-15: due primi accessi della stessa org corrono su slug, email e vincolo
    dell'org. Chi perde non esce con un 500 né lascia un salone a metà: il suo
    giro torna indietro per intero e la risoluzione si rifà una volta."""

    IDENTITY = {"org_id": "org-doppia", "email": "new@p.it", "email_verified": True,
                "name": "Nuovo"}

    def _login_with(self, racing_enter):
        from apps.integrations import login

        with mock.patch("apps.integrations.client.redeem_link_code", return_value=self.IDENTITY), \
                mock.patch.object(login, "_enter", side_effect=racing_enter), \
                mock.patch("apps.integrations.sync._run_in_background"):
            return login.login_with_link_code("code")

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

    def test_a_second_failure_is_not_retried_forever(self):
        racing_enter, calls = self._racing(IntegrityError("ancora"), times=2)
        with self.assertRaises(IntegrityError):
            self._login_with(racing_enter)
        self.assertEqual(calls["n"], 2)
        self.assertEqual(Salon.objects.count(), 0)


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
        conn.last_error = "proxy 502"
        conn.save()
        body = self._status()
        self.assertFalse(body["connected"])
        self.assertEqual((body["status"], body["last_error"]), ("error", "proxy 502"))


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
        with mock.patch("apps.integrations.sync.sync_clients", side_effect=RuntimeError("proxy giù")):
            sync.initial_sync(self.conn.pk)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.last_error, "proxy giù")
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
