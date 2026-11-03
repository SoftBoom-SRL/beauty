"""Collegamento e accesso Yourang (flusso OAuth diretto).

Dalla caccia del 22/09:
11-01/10-02: il codice va legato alla finestra che ha avviato il flusso (nonce,
HMAC dello state) e un salone collegato non cambia org senza disconnettersi.
11-02/10-03: «Accedi con Yourang» collega da solo solo il salone di cui l'utente
è titolare, e solo se è uno; il collega che accede non ridefinisce una
connessione che funziona. 11-14: cambio org → riferimenti remoti azzerati.
18-15: primo accesso atomico. 11-18/17-13 (C9): last_error esposto (lo scrivono
prima sync e cron: test_sync). 11-12: la prima sync gira fuori dalla richiesta.

Nati sul proxy, portati sul flusso diretto al merge con main (24/09) e
riportati sul proxy (YR-502): il codice di ritorno è il link code del proxy
(?yr_link=), che il backend riscatta con l'API key. In coda i test più vecchi
dell'accesso: identità Yourang, unicità dell'org, disconnessione.

    python manage.py test apps.integrations.tests.test_oauth
"""

from datetime import timedelta
from unittest import mock
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

from django.db import IntegrityError
from django.test import TestCase, override_settings
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations.models import YourangConnection, YourangOAuthState
from common.testing import bearer, post_json

from .base import API_SETTINGS

EXCHANGE = "/api/integrations/yourang/oauth/exchange"
# Il proxy davanti a Yourang e l'origin del frontend per il return_to.
OAUTH_SETTINGS = dict(API_SETTINGS, FRONTEND_ORIGIN="https://beauty.example")


def _identity(org, email="", *, verified=True, name="", org_role=None, org_name=None):
    """Ciò che il proxy restituisce riscattando il link code (POST /auth/link).

    `org_role`/`org_name` il proxy oggi non li passa: i test che li mettono
    provano che il login li usa quando ci sono.
    """
    out = {"sub": email or "u", "org_id": org, "email": email, "email_verified": verified, "name": name}
    if org_role:
        out["org_role"] = org_role
    if org_name:
        out["org_name"] = org_name
    return out


def _member(salon, email, *, owner=False, scopes=None):
    user = User.objects.create_user(email=email, password="Segretissima-2026")
    role = Role.objects.create(salon=salon, name=f"R-{email}", scopes=scopes) if scopes else None
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=owner)
    return user


@override_settings(**OAUTH_SETTINGS)
class _FlowCase(TestCase):
    def start(self, mode, headers=None):
        url = "/api/integrations/yourang/oauth/" + ("login/start" if mode == "login" else "start")
        r = self.client.get(url, **(headers or {}))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        login = urlparse(body["authorize_url"])
        self.assertEqual(
            (login.netloc, login.path), ("connect.yourang.invalid", "/v/beauty/auth/login")
        )
        # Il proxy torna sul popup del portale con il NOSTRO state nel return_to.
        return_to = urlparse(parse_qs(login.query)["return_to"][0])
        self.assertEqual(
            f"{return_to.scheme}://{return_to.netloc}{return_to.path}",
            "https://beauty.example/oauth-popup/done",
        )
        state = parse_qs(return_to.query)["state"][0]
        # Il modo sta nello state a database: con un salone è un collegamento.
        flow = YourangOAuthState.objects.get(state=state)
        self.assertEqual(flow.salon_id is None, mode == "login")
        return state, body["nonce"]

    def exchange(self, payload, headers=None):
        return post_json(self.client, EXCHANGE, payload, **(headers or {}))

    @staticmethod
    def redeem(identity=None):
        """Il riscatto del link code sul proxy: il codice vale `identity`."""
        return mock.patch("apps.integrations.client.redeem_link_code", return_value=identity)


class ConnectStateTests(_FlowCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = _member(self.salon, "owner@p.it", owner=True)
        self.auth = bearer(self.owner, self.salon)

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
        with self.redeem(_identity("org-legit")) as redeem, \
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
        with self.redeem(_identity("org-sua", "altra@p.it", name="Altra")), \
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
        with self.redeem(_identity("org-legit")) as redeem, \
                mock.patch("apps.integrations.client.httpx.request") as api, \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            r = self.exchange({"code": "c", "state": state, "nonce": nonce}, self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["mode"], "connect")
        conn = YourangConnection.objects.get(salon=self.salon)
        self.assertEqual((conn.yourang_org_id, conn.connected_by_id), ("org-legit", self.owner.id))
        redeem.assert_called_once_with("c")
        # Né token né registrazione del webhook: li gestisce il proxy (e la
        # PUT /webhook-subscription attraverso il proxy è un 403).
        self.assertEqual((conn.access_token_enc, conn.webhook_secret_enc), ("", ""))
        api.assert_not_called()
        background.assert_called_once_with(conn.pk)  # la sync non gira nella richiesta


class FlowStartTests(_FlowCase):
    """Bug sospetti del 24/09, voce 16: l'avvio del flusso non lascia righe orfane.

    Le righe dei flussi mai conclusi (popup chiuso, errore) si cancellavano
    solo allo scambio, cioè mai. (L'avvio col proxy non esce più in rete: la
    parte della voce sul discovery irraggiungibile non ha più oggetto.)
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.auth = bearer(_member(self.salon, "owner@p.it", owner=True), self.salon)

    def test_expired_states_go_away_when_a_new_flow_starts(self):
        from apps.integrations.oauth import STATE_TTL_SECONDS

        now = timezone.now()
        for state, age in (("scaduto", STATE_TTL_SECONDS + 60), ("in-corso", STATE_TTL_SECONDS - 60)):
            YourangOAuthState.objects.create(state=state, code_verifier="v")
            YourangOAuthState.objects.filter(state=state).update(created_at=now - timedelta(seconds=age))
        new, _ = self.start("login")
        # Quello in corso resta: chi l'ha avviato può ancora concluderlo.
        self.assertEqual(set(YourangOAuthState.objects.values_list("state", flat=True)), {"in-corso", new})


class LoginStartCapTests(_FlowCase):
    """Bug sospetti del 24/09, voce 57: l'avvio pubblico del login ha un tetto per IP.

    Ogni chiamata scrive una riga (lo state) e l'endpoint non chiede nessuna
    sessione. Gli altri endpoint pubblici che scrivono (registrazione,
    richiesta del codice, modulo contatti) hanno un tetto per IP, questo no:
    uno script che lo chiamava in ciclo riempiva la tabella.
    """

    URL = "/api/integrations/yourang/oauth/login/start"

    def test_one_address_cannot_fill_the_table(self):
        statuses = [self.client.get(self.URL, REMOTE_ADDR="203.0.113.7").status_code for _ in range(60)]
        refused = self.client.get(self.URL, REMOTE_ADDR="203.0.113.7")
        other = self.client.get(self.URL, REMOTE_ADDR="198.51.100.20")
        self.assertIn(429, statuses)
        allowed = statuses.index(429)
        self.assertEqual(statuses, [200] * allowed + [429] * (60 - allowed))
        self.assertEqual(refused.json()["detail"], "Troppe richieste: riprova tra qualche minuto")
        # Un altro indirizzo ha il suo tetto, e le richieste rifiutate non scrivono niente.
        self.assertEqual(other.status_code, 200, other.content)
        self.assertEqual(YourangOAuthState.objects.count(), allowed + 1)
        from apps.integrations.api import LOGIN_START_MAX_PER_IP

        self.assertEqual(allowed, LOGIN_START_MAX_PER_IP)


class OrgChangeTests(_FlowCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = _member(self.salon, "owner@p.it", owner=True)
        self.auth = bearer(self.owner, self.salon)
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
        with self.redeem(_identity(org)), \
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
        self.assertTrue(all("last_sync_at" not in fields for fields in seen), seen)


class LoginAdoptionTests(_FlowCase):
    def _login(self, org, email, name=""):
        from apps.integrations.login import login_with_link_code

        with self.redeem(_identity(org, email, name=name)), \
                mock.patch("apps.integrations.sync._run_in_background") as background, \
                self.captureOnCommitCallbacks(execute=True):
            session = login_with_link_code("code")
        return session, background

    def test_login_exchange_needs_the_flow_of_this_window(self):
        """Il link di ritorno dell'accesso di un altro, aperto qui: senza il nonce
        di questa finestra non entra nessuno (e lo state non si brucia)."""
        state, nonce = self.start("login")
        with self.redeem() as redeem:
            r = self.exchange({"code": "codice-altrui", "state": state})
        self.assertEqual(r.status_code, 400, r.content)
        redeem.assert_not_called()

        with self.redeem(_identity("org-nuova", "nuova@p.it", name="Nuova")), \
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
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertTrue(session["is_owner"])
        background.assert_called_once_with(conn.pk)

    def test_colleague_login_leaves_a_working_connection_alone(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = _member(salon, "owner@p.it", owner=True)
        YourangConnection.objects.create(
            salon=salon, yourang_org_id="org-x", connected_by=owner,
            last_error="Sincronizzazione parziale: x",
        )
        session, background = self._login("org-x", "collega@p.it", "C")
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertFalse(session["is_owner"])
        conn = YourangConnection.objects.get(salon=salon)
        self.assertEqual(conn.connected_by_id, owner.id)
        self.assertEqual(conn.last_error, "Sincronizzazione parziale: x")
        background.assert_not_called()

    def test_a_login_of_the_org_repairs_a_connection_that_cannot_work(self):
        """In errore (o disconnessa): il primo accesso con Yourang dell'org la
        rimette in piedi. Senza token non vuol dire più guasta: li tiene il proxy."""
        cases = {
            "in errore": dict(status=YourangConnection.Status.ERROR, last_error="502 di ieri"),
            "disconnessa": dict(status=YourangConnection.Status.DISCONNECTED),
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
                background.assert_called_once_with(conn.pk)

    def test_new_identity_gets_a_new_linked_salon(self):
        session, background = self._login("org-new", "new@p.it", "Nuovo")
        conn = YourangConnection.objects.get(yourang_org_id="org-new")
        self.assertEqual(session["salon"]["id"], conn.salon_id)
        self.assertTrue(session["is_owner"])
        background.assert_called_once_with(conn.pk)

    def test_the_new_salon_has_the_system_roles(self):
        """Bug sospetti del 24/09, voce 14: il salone nato qui è come gli altri.

        Nasceva con sede, impostazioni e titolare ma senza i ruoli Manager,
        Front desk e Operatrice, che `create_salon_foundation` dà a ogni altro
        salone: in Impostazioni › Team l'elenco era vuoto, e per invitare una
        collega il titolare doveva prima crearne uno a mano.
        """
        from apps.accounts.services import DEFAULT_ROLES

        session, _ = self._login("org-new", "new@p.it", "Nuovo")
        salon = Salon.objects.get(pk=session["salon"]["id"])
        self.assertEqual(
            sorted(Role.objects.filter(salon=salon).values_list("name", "scopes", "is_system")),
            sorted((name, scopes, True) for name, scopes in DEFAULT_ROLES),
        )
        # Il resto della fondazione, come prima: una sede predefinita e le impostazioni.
        self.assertEqual(list(salon.locations.values_list("name", "is_default")), [("Nuovo", True)])
        self.assertTrue(hasattr(salon, "settings"))


class OrgOwnerTakesOwnershipTests(_FlowCase):
    """Il titolare dell'org Yourang diventa titolare del salone collegato.

    Caso Elisir: il salone l'aveva attivato un collega di Yourang entrando per
    primo, e il titolare restava lui finché qualcuno non toccava il database.
    """

    def _login(self, org, email, org_role, org_name=None):
        from apps.integrations.login import login_with_link_code

        with self.redeem(_identity(org, email, name=email, org_role=org_role, org_name=org_name)), \
                mock.patch("apps.integrations.sync._run_in_background"), \
                self.captureOnCommitCallbacks(execute=True):
            return login_with_link_code("code")

    def test_the_client_takes_over_from_the_colleague_who_activated_it(self):
        first = self._login("org-elisir", "collega@yourang.it", "admin", "Elisir")
        self.assertTrue(first["is_owner"])  # nessun altro, per ora: può configurare
        # Il salone si chiama come l'org del cliente, non come il collega.
        self.assertEqual(first["salon"]["name"], "Elisir")

        session = self._login("org-elisir", "stefania@elisir.it", "owner")
        self.assertTrue(session["is_owner"])
        salon = Salon.objects.get(id=session["salon"]["id"])
        self.assertEqual(Membership.objects.filter(salon=salon, is_owner=True).count(), 1)
        collega = Membership.objects.get(salon=salon, user__email="collega@yourang.it")
        self.assertFalse(collega.is_owner)
        self.assertEqual(collega.role.name, "Manager")  # resta dentro, non chiuso fuori

        # Il collega che rientra non se la riprende.
        again = self._login("org-elisir", "collega@yourang.it", "admin")
        self.assertFalse(again["is_owner"])

    def test_a_member_of_the_org_does_not_take_it(self):
        self._login("org-elisir", "stefania@elisir.it", "owner")
        session = self._login("org-elisir", "op@elisir.it", "member")
        self.assertFalse(session["is_owner"])

    def test_owning_another_org_says_nothing_about_this_salon(self):
        """Un'operatrice titolare della SUA org entra nel salone senza collegarlo:
        quel ruolo non riguarda questo salone."""
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        _member(salon, "owner@p.it", owner=True)
        _member(salon, "op@p.it", scopes=["agenda"])
        session = self._login("org-op", "op@p.it", "owner")
        self.assertEqual(session["salon"]["id"], salon.id)
        self.assertFalse(session["is_owner"])


class ConcurrentFirstLoginTests(_FlowCase):
    """18-15: due primi accessi della stessa org corrono su slug, email e vincolo
    dell'org. Chi perde non esce con un 500 né lascia un salone a metà: il suo
    giro torna indietro per intero e la risoluzione si rifà una volta."""

    IDENTITY = _identity("org-doppia", "new@p.it", name="Nuovo")

    def _login_with(self, racing_enter):
        from apps.integrations import login

        with self.redeem(self.IDENTITY), \
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

    def test_a_conflict_that_persists_is_a_409_not_a_500(self):
        from apps.integrations import login
        from apps.integrations.connection import ORG_TAKEN, OrgConflict

        state, nonce = self.start("login")
        with self.redeem(self.IDENTITY), \
                mock.patch.object(login, "_enter", side_effect=OrgConflict(ORG_TAKEN)):
            r = self.exchange({"code": "c", "state": state, "nonce": nonce})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["detail"], ORG_TAKEN)


class StatusLastErrorTests(TestCase):
    """C9: GET /yourang/status espone last_error ("" se nessuno)."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.auth = bearer(_member(self.salon, "owner@p.it", owner=True), self.salon)

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


class LoginIdentityTests(TestCase):
    """Un'org già collegata dà il SALONE, mai l'utente titolare: chi accede
    entra con la propria identità Yourang."""

    def test_mapped_org_does_not_return_the_owner(self):
        from apps.accounts.models import Membership, User
        from apps.core.models import Salon
        from apps.integrations.login import _resolve_salon
        from apps.integrations.models import YourangConnection

        salon = Salon.objects.create(name="Salone", slug="salone-org")
        owner = User.objects.create_user(email="titolare@x.it", password=None)
        Membership.objects.create(user=owner, salon=salon, is_owner=True)
        YourangConnection.objects.create(salon=salon, yourang_org_id="org3")

        self.assertEqual(
            _resolve_salon("org3", "collega@x.it", True), (salon, None)
        )

    def test_unverified_email_cannot_take_over_an_existing_account(self):
        """Guardia anti account-takeover: un'identità Yourang con la stessa
        email ma NON verificata non entra in un account beauty già esistente."""
        from apps.accounts.models import User
        from apps.integrations.login import _get_or_create_user

        User.objects.create_user(email="titolare@salone.it", password=None)
        with self.assertRaises(ValueError):
            _get_or_create_user("Titolare@Salone.it", "Mario Rossi", email_verified=False)
        # Verificata: si adotta l'account esistente, non se ne crea un secondo.
        adopted = _get_or_create_user("Titolare@Salone.it", "Mario Rossi", email_verified=True)
        self.assertEqual(adopted.email, "titolare@salone.it")
        self.assertEqual(User.objects.filter(email__iexact="titolare@salone.it").count(), 1)

    def test_identity_without_org_is_refused(self):
        """Senza organizzazione il connect rifiuta: il login faceva passare, e
        ogni accesso provisionava un salone nuovo e vuoto."""
        from apps.core.models import Salon
        from apps.integrations.login import login_with_link_code

        before = Salon.objects.count()
        identity = {"org_id": "", "email": "nuovo@x.it", "email_verified": True, "name": "Nuovo"}
        with patch("apps.integrations.login.yc.redeem_link_code", return_value=identity):
            with self.assertRaises(ValueError):
                login_with_link_code("code-1")
        self.assertEqual(Salon.objects.count(), before)


class OrgUniquenessTests(TestCase):
    """Il guard applicativo non basta: due exchange simultanee lo superano e gli
    eventi finiscono nel salone sbagliato (il webhook risolve il salone dall'org)."""

    def test_the_database_refuses_a_second_salon_on_the_same_org(self):
        from django.db import IntegrityError, transaction

        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        first = Salon.objects.create(name="Primo", slug="primo-org")
        second = Salon.objects.create(name="Secondo", slug="secondo-org")
        YourangConnection.objects.create(salon=first, yourang_org_id="org-unica")

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                YourangConnection.objects.create(salon=second, yourang_org_id="org-unica")

    def test_many_connections_can_stay_unlinked(self):
        """Il vincolo è parziale: "" significa "non ancora collegata"."""
        from apps.core.models import Salon
        from apps.integrations.models import YourangConnection

        for i in range(3):
            salon = Salon.objects.create(name=f"Vuoto {i}", slug=f"vuoto-{i}")
            YourangConnection.objects.create(salon=salon, yourang_org_id="")
        self.assertEqual(YourangConnection.objects.filter(yourang_org_id="").count(), 3)


class DisconnectTests(TestCase):
    """Alla disconnessione i riferimenti remoti devono sparire, o dopo una
    riconnessione clienti e listino non si sincronizzano mai più."""

    def test_disconnect_clears_remote_ids(self):
        from apps.catalog.models import Package, Service, ServiceCategory
        from apps.clients.models import Client
        from apps.core.models import Salon
        from apps.integrations.api import disconnect
        from apps.integrations.models import YourangConnection

        salon = Salon.objects.create(name="Salone Disc", slug="salone-disc")
        YourangConnection.objects.create(salon=salon, yourang_org_id="org-disc")
        client_obj = Client.objects.create(
            salon=salon, first_name="Ada", phone="+393331110002", yourang_contact_id="c-1"
        )
        cat = ServiceCategory.objects.create(salon=salon, name_it="Capelli")
        svc = Service.objects.create(
            salon=salon, category=cat, name_it="Piega", duration_min=30, price=20,
            yourang_item_id="i-1",
        )
        pkg = Package.objects.create(salon=salon, name="Pacchetto", price=100,
                                     yourang_item_id="i-2")

        ctx = Mock(salon=salon, is_owner=True)
        disconnect(Mock(auth=ctx))

        client_obj.refresh_from_db()
        svc.refresh_from_db()
        pkg.refresh_from_db()
        self.assertEqual(client_obj.yourang_contact_id, "")
        self.assertEqual(svc.yourang_item_id, "")
        self.assertEqual(pkg.yourang_item_id, "")
        self.assertFalse(YourangConnection.objects.filter(salon=salon).exists())
