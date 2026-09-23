"""create_salon: email già esistente, maiuscole, slug non valido (caccia 22/09, 08-08)."""

import json
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase

from apps.accounts.models import Membership, User

from .models import Salon


def _create(slug="secondo", email="anna@x.it", **extra):
    call_command(
        "create_salon", name="Secondo", slug=slug, owner_email=email, stdout=StringIO(), **extra
    )


class CreateSalonOwnerTests(TestCase):
    def _login(self, email, password="pw-lunga-123"):
        resp = self.client.post(
            "/api/auth/staff/login",
            data=json.dumps({"email": email, "password": password}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()["salon"]["slug"]

    def test_an_owner_already_working_elsewhere_is_refused_and_nothing_is_created(self):
        first = Salon.objects.create(name="Primo", slug="primo")
        user = User.objects.create_user(email="anna@x.it", password="pw-lunga-123")
        Membership.objects.create(user=user, salon=first, is_owner=True)
        with self.assertRaises(CommandError):
            _create(email="Anna@X.it")
        self.assertFalse(Salon.objects.filter(slug="secondo").exists())
        self.assertEqual(Membership.objects.filter(user=user).count(), 1)
        self.assertEqual(self._login("anna@x.it"), "primo")

    def test_the_email_is_matched_without_case_and_no_duplicate_is_born(self):
        # ex collaboratrice rimossa dal team: l'utente resta, senza membership
        user = User.objects.create_user(email="Anna@x.it", password="pw-lunga-123")
        _create(email="anna@x.it")
        self.assertEqual(User.objects.filter(email__iexact="anna@x.it").count(), 1)
        membership = Membership.objects.get(user=user)
        self.assertTrue(membership.is_owner)
        self.assertEqual(membership.salon.slug, "secondo")
        # la password resta la sua, e il login porta al salone nuovo
        self.assertEqual(self._login("anna@x.it"), "secondo")

    def test_a_new_owner_is_stored_lowercase_without_a_usable_password(self):
        _create(email="  Bea.Rossi@Esempio.IT ")
        owner = User.objects.get(email="bea.rossi@esempio.it")
        self.assertFalse(owner.has_usable_password())
        self.assertFalse(owner.is_staff)

    def test_a_deactivated_user_is_refused(self):
        User.objects.create_user(email="anna@x.it", password="pw-lunga-123", is_active=False)
        with self.assertRaises(CommandError):
            _create()
        self.assertFalse(Salon.objects.filter(slug="secondo").exists())

    def test_an_invalid_email_is_refused(self):
        with self.assertRaises(CommandError):
            _create(email="anna-at-x")
        self.assertFalse(Salon.objects.exists())


class CreateSalonSlugTests(TestCase):
    def test_slugs_the_client_app_cannot_open_are_refused(self):
        for slug in ("bellezza mia", "città", "-inizio", "_inizio", "a/b", "x" * 51, " "):
            with self.subTest(slug=slug):
                with self.assertRaises(CommandError):
                    _create(slug=slug)
        self.assertFalse(Salon.objects.exists())
        self.assertFalse(User.objects.exists())

    def test_a_valid_slug_is_normalised_to_lowercase(self):
        _create(slug="  Bellezza-Mia_2 ")
        self.assertTrue(Salon.objects.filter(slug="bellezza-mia_2").exists())
