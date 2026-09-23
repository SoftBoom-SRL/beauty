"""Caccia del 22/09: inviti, cambio ruolo e ruoli di sistema (10-01, 10-05, 15-02, 15-10).

Lo scope `team` gestisce il personale, non promuove a titolare: la passata del
18/09 aveva chiuso l'auto-promozione diretta, ma restavano tre porte laterali —
il codice degli inviti in attesa leggibile da chiunque avesse `team`, il cambio
ruolo che non guardava il ruolo ATTUALE del collega, e i ruoli di sistema
riscrivibili via API.
"""

import datetime as dt
import json
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Invitation, Membership, Role, User
from .services import ensure_default_roles


def post_json(client, url, data, **extra):
    return client.post(url, data=json.dumps(data), content_type="application/json", **extra)


def bearer(user, salon):
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


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

        with mock.patch("apps.accounts.api.validate_password", side_effect=accepted_meanwhile):
            res = self._accept()
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(User.objects.filter(email="nora@parlour.it").exists())

    def test_an_account_created_meanwhile_is_a_400_not_a_500(self):
        def user_created_meanwhile(*args, **kwargs):
            User.objects.create_user(email="nora@parlour.it", password="Altra-Password-9")

        self.client.raise_request_exception = False
        with mock.patch("apps.accounts.api.validate_password", side_effect=user_created_meanwhile):
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
        return self.client.put(
            f"/api/auth/roles/{role.id}", data=json.dumps(body), content_type="application/json", **auth
        )

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
