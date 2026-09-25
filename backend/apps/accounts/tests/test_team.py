"""Il personale del salone: ruoli di sistema, inviti, cambio ruolo.

Lo scope `team` gestisce il personale, non promuove a titolare: la passata del
18/09 aveva chiuso l'auto-promozione diretta (S5, TeamPrivilegeTests), ma
restavano tre porte laterali, chiuse dalla caccia del 22/09 (10-01, 10-05, 15-02,
15-10) — il codice degli inviti in attesa leggibile da chiunque avesse `team`, il
cambio ruolo che non guardava il ruolo ATTUALE del collega, e i ruoli di sistema
riscrivibili via API.
"""

import datetime as dt
from importlib import import_module
from unittest import mock

from django.apps import apps as django_apps
from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from common.permissions import SCOPES
from common.testing import bearer, post_json, put_json

from ..models import Invitation, Membership, Role, User
from ..services import ensure_default_roles


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


class SystemRolesMigrationTests(TestCase):
    """Bug sospetti del 24/09, voce 14: la migrazione 0006 dà i ruoli di sistema ai saloni che non li hanno.

    I saloni nati da «Accedi con Yourang» non ricevevano Manager, Front desk e
    Operatrice: per invitare una collega il titolare doveva prima crearne uno
    a mano. La migrazione crea solo quelli che mancano per nome, e non tocca
    mai un ruolo che c'è già.
    """

    MODULE = "apps.accounts.migrations.0006_bs24_account_ruoli_di_sistema"

    def _migrate(self):
        import_module(self.MODULE).forwards(django_apps, None)

    def _system_roles(self):
        return sorted((name, scopes, True) for name, scopes in import_module(self.MODULE).SYSTEM_ROLES)

    @staticmethod
    def _roles(salon):
        return sorted(Role.objects.filter(salon=salon).values_list("name", "scopes", "is_system"))

    def test_a_salon_without_roles_gets_the_system_roles(self):
        salon = Salon.objects.create(name="Nato da Yourang", slug="nato-da-yourang")
        self._migrate()
        self.assertEqual(self._roles(salon), self._system_roles())

    def test_a_role_made_by_hand_with_the_same_name_stays_as_it_is(self):
        salon = Salon.objects.create(name="Nato da Yourang", slug="nato-da-yourang")
        manager = Role.objects.create(salon=salon, name="Manager", scopes=["agenda"])
        self._migrate()
        manager.refresh_from_db()
        self.assertEqual((manager.name, manager.scopes, manager.is_system), ("Manager", ["agenda"], False))
        expected = [r for r in self._system_roles() if r[0] != "Manager"] + [("Manager", ["agenda"], False)]
        self.assertEqual(self._roles(salon), sorted(expected))

    def test_running_it_twice_creates_no_duplicates(self):
        bare = Salon.objects.create(name="Nato da Yourang", slug="nato-da-yourang")
        by_hand = Salon.objects.create(name="Con un ruolo a mano", slug="con-un-ruolo-a-mano")
        Role.objects.create(salon=by_hand, name="Manager", scopes=["agenda"])
        self._migrate()
        first = (self._roles(bare), self._roles(by_hand))
        self._migrate()
        self.assertEqual((self._roles(bare), self._roles(by_hand)), first)
        self.assertEqual(Role.objects.filter(salon=bare).count(), 3)
        self.assertEqual(Role.objects.filter(salon=by_hand).count(), 3)

    def test_a_salon_with_system_roles_is_left_alone(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ensure_default_roles(salon)
        Role.objects.filter(salon=salon, name="Operatrice").delete()  # dall'admin, per esempio
        before = self._roles(salon)
        self._migrate()
        self.assertEqual(self._roles(salon), before)


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
        from ..models import Invitation

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
        from ..models import Invitation

        for password in ("abc", "password"):
            invitation = Invitation.objects.create(
                salon=self.salon, email=f"{password}@parlour.it", role=self.role
            )
            response = self._accept(invitation, password)
            self.assertEqual(response.status_code, 400, password)


class TeamPrivilegeTests(TestCase):
    """S5: lo scope `team` gestisce il personale, non promuove a titolare.

    Al responsabile del personale viene dato il solo scope team. Senza questi
    controlli si creava un ruolo con tutti e nove i permessi e se lo assegnava:
    al rinnovo aveva incassi, listino, magazzino e analisi che il titolare gli
    aveva negato."""

    def setUp(self):
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = User.objects.create_user(email="titolare@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=self.owner, salon=self.salon, is_owner=True)

        self.role_team = Role.objects.create(salon=self.salon, name="Personale", scopes=["team"])
        self.manager = User.objects.create_user(email="hr@parlour.it", password="x-Segreta-1")
        self.manager_membership = Membership.objects.create(
            user=self.manager, salon=self.salon, role=self.role_team
        )
        self.hr = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.manager, self.salon)['access']}"
        }
        self.boss = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.owner, self.salon)['access']}"
        }

    def test_a_role_cannot_grant_scopes_the_caller_does_not_have(self):
        response = post_json(
            self.client,
            "/api/auth/roles",
            {"name": "Tuttofare", "scopes": ["team", "sales", "insights"]},
            **self.hr,
        )
        self.assertEqual(response.status_code, 403, response.content)
        self.assertFalse(Role.objects.filter(salon=self.salon, name="Tuttofare").exists())

    def test_a_role_with_only_owned_scopes_is_allowed(self):
        response = post_json(
            self.client, "/api/auth/roles", {"name": "Vice", "scopes": ["team"]}, **self.hr
        )
        self.assertEqual(response.status_code, 200, response.content)

    def test_nobody_edits_their_own_membership(self):
        potente = Role.objects.create(salon=self.salon, name="Tutto", scopes=["team", "sales"])
        response = post_json(
            self.client,
            f"/api/auth/members/{self.manager_membership.id}/role",
            {"role_id": potente.id},
            **self.hr,
        )
        self.assertEqual(response.status_code, 403, response.content)
        self.manager_membership.refresh_from_db()
        self.assertEqual(self.manager_membership.role_id, self.role_team.id)

    def test_a_colleague_cannot_be_given_more_than_the_caller_has(self):
        collega = User.objects.create_user(email="sofia@parlour.it", password="x-Segreta-1")
        membership = Membership.objects.create(user=collega, salon=self.salon)
        potente = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        response = post_json(
            self.client, f"/api/auth/members/{membership.id}/role", {"role_id": potente.id}, **self.hr
        )
        self.assertEqual(response.status_code, 403, response.content)

    def test_an_invitation_cannot_smuggle_in_a_powerful_role(self):
        potente = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        response = post_json(
            self.client,
            "/api/auth/invitations",
            {"email": "nuova@parlour.it", "role_id": potente.id},
            **self.hr,
        )
        self.assertEqual(response.status_code, 403, response.content)

    def test_a_more_powerful_colleague_cannot_be_removed(self):
        collega = User.objects.create_user(email="sofia@parlour.it", password="x-Segreta-1")
        potente = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        membership = Membership.objects.create(user=collega, salon=self.salon, role=potente)
        response = self.client.delete(f"/api/auth/members/{membership.id}", **self.hr)
        self.assertEqual(response.status_code, 403, response.content)

    def test_the_owner_still_runs_the_salon(self):
        """Il titolare seminato deve continuare a lavorare senza limiti."""
        creazione = post_json(
            self.client,
            "/api/auth/roles",
            {"name": "Tuttofare", "scopes": list(SCOPES)},
            **self.boss,
        )
        self.assertEqual(creazione.status_code, 200, creazione.content)
        role_id = creazione.json()["id"]
        assegnazione = post_json(
            self.client,
            f"/api/auth/members/{self.manager_membership.id}/role",
            {"role_id": role_id},
            **self.boss,
        )
        self.assertEqual(assegnazione.status_code, 200, assegnazione.content)


class _TeamSetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = User.objects.create_user(email="titolare@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=self.owner, salon=self.salon, is_owner=True)
        self.boss = bearer(self.owner, self.salon)

        # La responsabile del personale: solo `team`.
        self.role_team = Role.objects.create(salon=self.salon, name="Personale", scopes=["team"])
        self.hr_user = User.objects.create_user(email="hr@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=self.hr_user, salon=self.salon, role=self.role_team)
        self.hr = bearer(self.hr_user, self.salon)

        self.manager_role = Role.objects.create(
            salon=self.salon,
            name="Manager+",
            scopes=["agenda", "clients", "sales", "inventory", "pricing"],
        )


class InvitationTokenTests(_TeamSetup):
    """10-01: il codice dell'invito vale un account con il ruolo dell'invito."""

    def _invite(self, email, role, auth):
        res = post_json(
            self.client, "/api/auth/invitations", {"email": email, "role_id": role.id}, **auth
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _list(self, auth):
        res = self.client.get("/api/auth/invitations", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        return {row["email"]: row for row in res.json()}

    def test_team_only_member_does_not_see_the_code_of_a_more_powerful_invitation(self):
        self._invite("nuova@parlour.it", self.manager_role, self.boss)
        rows = self._list(self.hr)
        # L'invito resta visibile (chi gestisce il personale sa che è in attesa)…
        self.assertIn("nuova@parlour.it", rows)
        self.assertEqual(rows["nuova@parlour.it"]["role"]["name"], "Manager+")
        # …ma il codice, che è l'account Manager, no.
        self.assertIsNone(rows["nuova@parlour.it"]["token"])

    def test_the_code_reaches_who_could_grant_that_role(self):
        created = self._invite("vice@parlour.it", self.role_team, self.hr)
        # Chi lo crea lo riceve subito: è l'unica via per condividerlo oggi.
        self.assertIsNotNone(created["token"])
        rows = self._list(self.hr)
        self.assertEqual(rows["vice@parlour.it"]["token"], created["token"])
        # Il titolare vede i codici di tutti gli inviti in attesa.
        self._invite("nuova@parlour.it", self.manager_role, self.boss)
        rows = self._list(self.boss)
        self.assertIsNotNone(rows["nuova@parlour.it"]["token"])
        self.assertIsNotNone(rows["vice@parlour.it"]["token"])

    def test_spent_or_expired_codes_are_not_listed(self):
        accepted = Invitation.objects.create(
            salon=self.salon, email="a@parlour.it", role=self.role_team,
            status=Invitation.Status.ACCEPTED,
        )
        expired = Invitation.objects.create(
            salon=self.salon, email="b@parlour.it", role=self.role_team,
            expires_at=timezone.now() - dt.timedelta(days=1),
        )
        rows = self._list(self.boss)
        self.assertIsNone(rows[accepted.email]["token"])
        self.assertIsNone(rows[expired.email]["token"])

    def test_a_team_member_cannot_become_manager_through_the_list(self):
        """Lo scenario del reperto, dall'inizio alla fine."""
        self._invite("nuova@parlour.it", self.manager_role, self.boss)
        token = self._list(self.hr)["nuova@parlour.it"]["token"]
        self.assertIsNone(token)
        res = post_json(
            self.client,
            "/api/auth/invitations/accept",
            {"token": str(token), "password": "Cartellina-2026", "first_name": "F", "last_name": "D"},
        )
        self.assertEqual(res.status_code, 404, res.content)
        self.assertFalse(User.objects.filter(email="nuova@parlour.it").exists())


class InvitationSingleUseTests(_TeamSetup):
    """10-01: un invito si accetta una volta sola, anche con due richieste insieme."""

    BODY = {"password": "Cartellina-2026", "first_name": "Nora", "last_name": "Bianchi"}

    def setUp(self):
        super().setUp()
        self.invitation = Invitation.objects.create(
            salon=self.salon, email="nora@parlour.it", role=self.role_team
        )

    def _accept(self):
        return post_json(
            self.client,
            "/api/auth/invitations/accept",
            {"token": str(self.invitation.token), **self.BODY},
        )

    def test_the_second_acceptance_is_refused(self):
        self.assertEqual(self._accept().status_code, 200)
        again = self._accept()
        self.assertEqual(again.status_code, 400, again.content)
        self.assertEqual(Membership.objects.filter(user__email="nora@parlour.it").count(), 1)

    def test_an_acceptance_that_lands_while_this_one_is_running_wins(self):
        """L'altra richiesta accetta fra il controllo iniziale e la scrittura."""

        def accepted_meanwhile(*args, **kwargs):
            Invitation.objects.filter(pk=self.invitation.pk).update(
                status=Invitation.Status.ACCEPTED
            )

        with mock.patch("apps.accounts.api.team.validate_password", side_effect=accepted_meanwhile):
            res = self._accept()
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(User.objects.filter(email="nora@parlour.it").exists())

    def test_an_account_created_meanwhile_is_a_400_not_a_500(self):
        def user_created_meanwhile(*args, **kwargs):
            User.objects.create_user(email="nora@parlour.it", password="Altra-Password-9")

        self.client.raise_request_exception = False
        with mock.patch("apps.accounts.api.team.validate_password", side_effect=user_created_meanwhile):
            res = self._accept()
        self.assertEqual(res.status_code, 400, res.content)
        self.invitation.refresh_from_db()
        self.assertEqual(self.invitation.status, Invitation.Status.PENDING)
        self.assertFalse(Membership.objects.filter(user__email="nora@parlour.it").exists())


class MemberRoleChangeTests(_TeamSetup):
    """10-05 + 15-02: cambiare ruolo a una collega più potente vale quanto rimuoverla."""

    def setUp(self):
        super().setUp()
        colleague = User.objects.create_user(email="sofia@parlour.it", password="x-Segreta-1")
        self.manager_membership = Membership.objects.create(
            user=colleague, salon=self.salon, role=self.manager_role
        )

    def _set_role(self, membership, role_id, auth):
        return post_json(
            self.client, f"/api/auth/members/{membership.id}/role", {"role_id": role_id}, **auth
        )

    def test_team_only_cannot_strip_the_role_of_a_more_powerful_colleague(self):
        res = self._set_role(self.manager_membership, None, self.hr)
        self.assertEqual(res.status_code, 403, res.content)
        self.manager_membership.refresh_from_db()
        self.assertEqual(self.manager_membership.role_id, self.manager_role.id)

    def test_team_only_cannot_narrow_the_role_of_a_more_powerful_colleague(self):
        narrow = Role.objects.create(salon=self.salon, name="Solo team", scopes=["team"])
        res = self._set_role(self.manager_membership, narrow.id, self.hr)
        self.assertEqual(res.status_code, 403, res.content)
        self.manager_membership.refresh_from_db()
        self.assertEqual(self.manager_membership.role_id, self.manager_role.id)

    def test_team_only_still_manages_colleagues_within_its_reach(self):
        junior = User.objects.create_user(email="junior@parlour.it", password="x-Segreta-1")
        membership = Membership.objects.create(user=junior, salon=self.salon, role=self.role_team)
        res = self._set_role(membership, None, self.hr)
        self.assertEqual(res.status_code, 200, res.content)
        membership.refresh_from_db()
        self.assertIsNone(membership.role_id)
        # E chi è senza ruolo può ricevere un ruolo che la responsabile possiede.
        res = self._set_role(membership, self.role_team.id, self.hr)
        self.assertEqual(res.status_code, 200, res.content)

    def test_the_owner_can_change_anyone(self):
        res = self._set_role(self.manager_membership, None, self.boss)
        self.assertEqual(res.status_code, 200, res.content)


class SystemRoleTests(_TeamSetup):
    """15-10: la dashboard dice «permessi non modificabili» e ora lo sono davvero."""

    def setUp(self):
        super().setUp()
        ensure_default_roles(self.salon)
        self.operatrice = Role.objects.get(salon=self.salon, name="Operatrice")
        self.role_team.scopes = ["team", "agenda", "clients"]
        self.role_team.save(update_fields=["scopes"])

    def _put(self, role, body, auth):
        return put_json(self.client, f"/api/auth/roles/{role.id}", body, **auth)

    def test_a_system_role_is_not_rewritten_by_a_team_member(self):
        res = self._put(self.operatrice, {"name": "Operatrice", "scopes": ["clients"]}, self.hr)
        self.assertEqual(res.status_code, 400, res.content)
        self.operatrice.refresh_from_db()
        self.assertEqual(sorted(self.operatrice.scopes), ["agenda", "clients"])

    def test_nor_by_the_owner(self):
        res = self._put(self.operatrice, {"name": "Stilista", "scopes": ["agenda"]}, self.boss)
        self.assertEqual(res.status_code, 400, res.content)
        self.operatrice.refresh_from_db()
        self.assertEqual(self.operatrice.name, "Operatrice")

    def test_custom_roles_stay_editable(self):
        custom = Role.objects.create(salon=self.salon, name="Reception", scopes=["agenda"])
        res = self._put(custom, {"name": "Reception", "scopes": ["agenda", "clients"]}, self.hr)
        self.assertEqual(res.status_code, 200, res.content)
