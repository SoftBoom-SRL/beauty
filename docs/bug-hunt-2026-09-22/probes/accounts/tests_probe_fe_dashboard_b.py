"""PROBE temporaneo (revisore 15): chi ha il solo «team» può togliere il ruolo a
una collega più potente (la rimozione dal team invece è bloccata)."""

import json

from django.test import TestCase

from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Membership, Role, User


class DemoteProbe(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="t@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        role_team = Role.objects.create(salon=self.salon, name="Personale", scopes=["team"])
        hr = User.objects.create_user(email="hr@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=hr, salon=self.salon, role=role_team)
        self.h = {"HTTP_AUTHORIZATION": "Bearer " + create_staff_tokens(hr, self.salon)["access"]}
        self.potente = Role.objects.create(
            salon=self.salon, name="Manager+", scopes=["agenda", "clients", "sales", "inventory"]
        )
        collega = User.objects.create_user(email="sofia@parlour.it", password="x-Segreta-1")
        self.m = Membership.objects.create(user=collega, salon=self.salon, role=self.potente)

    def test_remove_is_blocked(self):
        r = self.client.delete(f"/api/auth/members/{self.m.id}", **self.h)
        print("\n[probe] remove more powerful colleague ->", r.status_code)
        self.assertEqual(r.status_code, 403)

    def test_demote_to_no_role(self):
        r = self.client.post(
            f"/api/auth/members/{self.m.id}/role",
            data=json.dumps({"role_id": None}), content_type="application/json", **self.h,
        )
        self.m.refresh_from_db()
        print("\n[probe] demote more powerful colleague to none ->", r.status_code, "role now", self.m.role_id)
        self.assertEqual(r.status_code, 403)

    def test_demote_to_narrow_role(self):
        narrow = Role.objects.create(salon=self.salon, name="Solo team", scopes=["team"])
        r = self.client.post(
            f"/api/auth/members/{self.m.id}/role",
            data=json.dumps({"role_id": narrow.id}), content_type="application/json", **self.h,
        )
        self.m.refresh_from_db()
        print("\n[probe] demote more powerful colleague to narrow ->", r.status_code, "role now", self.m.role_id)
        self.assertEqual(r.status_code, 403)


class SystemRoleProbe(TestCase):
    def test_system_role_can_be_rewritten_by_team_member(self):
        from .services import ensure_default_roles

        salon = Salon.objects.create(name="P2", slug="p2")
        ensure_default_roles(salon)
        operatrice = Role.objects.get(salon=salon, name="Operatrice")
        role_hr = Role.objects.create(salon=salon, name="HR", scopes=["team", "agenda", "clients"])
        hr = User.objects.create_user(email="hr2@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=hr, salon=salon, role=role_hr)
        h = {"HTTP_AUTHORIZATION": "Bearer " + create_staff_tokens(hr, salon)["access"]}
        r = self.client.put(
            f"/api/auth/roles/{operatrice.id}",
            data=json.dumps({"name": "Operatrice", "scopes": ["clients"]}),
            content_type="application/json", **h,
        )
        operatrice.refresh_from_db()
        print("\n[probe] PUT system role by HR ->", r.status_code, operatrice.scopes, "is_system", operatrice.is_system)
        self.assertNotEqual(r.status_code, 200)
