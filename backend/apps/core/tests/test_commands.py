"""seed_demo: niente superuser con password pubblica, niente reset di saloni veri.

Caccia ai bug del 22/09: 08-01 (+15-01) e 08-02.
"""

import re
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings

from apps.accounts.models import Membership, User
from apps.clients.models import Client

from ..management.commands.seed_demo import DEMO_OWNER_EMAIL, DEMO_SLUG, _teardown
from ..models import Salon


def _seed(*args, **kwargs):
    out = StringIO()
    call_command("seed_demo", *args, stdout=out, **kwargs)
    return out.getvalue()


def _printed_password(output: str) -> str:
    match = re.search(r"password: (\S+) \(mostrata solo ora\)", output)
    return match.group(1) if match else ""


@override_settings(DEBUG=True)
class SeedDemoAccountTests(TestCase):
    def test_the_demo_owner_is_a_normal_user_with_a_private_password(self):
        other = Salon.objects.create(name="Salone vero", slug="vero")
        Client.objects.create(salon=other, first_name="Segreta", last_name="Rossi", phone="+393339998877")

        output = _seed()
        password = _printed_password(output)
        owner = User.objects.get(email=DEMO_OWNER_EMAIL)
        self.assertFalse(owner.is_staff)
        self.assertFalse(owner.is_superuser)
        self.assertTrue(password)
        self.assertNotEqual(password, "theparlour")
        self.assertFalse(owner.check_password("theparlour"))
        # la password stampata funziona, ma /admin/ non si apre
        self.assertTrue(self.client.login(email=DEMO_OWNER_EMAIL, password=password))
        resp = self.client.get("/admin/clients/client/?q=Segreta")
        self.assertNotEqual(resp.status_code, 200)
        self.assertNotIn(b"Segreta", resp.content)
        # è il titolare della demo, e solo della demo
        membership = Membership.objects.get(user=owner)
        self.assertTrue(membership.is_owner)
        self.assertEqual(membership.salon.slug, DEMO_SLUG)
        self.assertTrue(membership.salon.is_demo)

    def test_every_run_draws_a_different_password(self):
        first = _printed_password(_seed())
        User.objects.filter(email=DEMO_OWNER_EMAIL).delete()
        second = _printed_password(_seed("--reset"))
        self.assertTrue(first and second)
        self.assertNotEqual(first, second)

    def test_the_password_can_be_chosen(self):
        output = _seed("--password", "demo-scelta-123")
        self.assertIn("demo-scelta-123", output)
        self.assertTrue(User.objects.get(email=DEMO_OWNER_EMAIL).check_password("demo-scelta-123"))

    def test_a_superuser_left_by_an_old_seed_is_neutralised(self):
        old = User.objects.create_superuser(email=DEMO_OWNER_EMAIL, password="theparlour")
        tv = old.token_version
        output = _seed()
        old.refresh_from_db()
        self.assertFalse(old.is_superuser)
        self.assertFalse(old.is_staff)
        self.assertFalse(old.check_password("theparlour"))
        self.assertTrue(old.check_password(_printed_password(output)))
        # le sessioni aperte con la password pubblica non valgono più
        self.assertGreater(old.token_version, tv)

    def test_an_existing_private_password_is_kept(self):
        User.objects.create_user(email=DEMO_OWNER_EMAIL, password="privata-lunga-1")
        output = _seed()
        self.assertIn("password invariata", output)
        self.assertEqual(_printed_password(output), "")
        self.assertTrue(User.objects.get(email=DEMO_OWNER_EMAIL).check_password("privata-lunga-1"))

    def test_the_demo_account_of_a_real_salon_is_not_touched(self):
        real = Salon.objects.create(name="Salone vero", slug="vero")
        user = User.objects.create_user(email=DEMO_OWNER_EMAIL, password="privata-lunga-1")
        Membership.objects.create(user=user, salon=real, is_owner=True)
        for args in ((), ("--password", "altra-password-1")):
            with self.assertRaises(CommandError):
                _seed(*args)
        user.refresh_from_db()
        self.assertTrue(user.check_password("privata-lunga-1"))
        self.assertFalse(Salon.objects.filter(slug=DEMO_SLUG).exists())


class SeedDemoOutsideDebugTests(TestCase):
    """I test girano con DEBUG spento, come la produzione."""

    def test_without_debug_it_refuses_and_creates_nothing(self):
        with self.assertRaises(CommandError):
            _seed()
        self.assertFalse(Salon.objects.exists())
        self.assertFalse(User.objects.filter(email=DEMO_OWNER_EMAIL).exists())

    def test_an_explicit_flag_allows_a_test_environment(self):
        _seed("--allow-production")
        self.assertTrue(Salon.objects.get(slug=DEMO_SLUG).is_demo)


@override_settings(DEBUG=True)
class SeedDemoResetTests(TestCase):
    def test_reset_never_deletes_a_real_salon_with_the_demo_slug(self):
        from apps.integrations.login import _provision_salon

        owner = User.objects.create_user(email="vera@titolare.it", password="pw-lunga-123")
        real = _provision_salon(owner, "The Parlour")  # come «Accedi con Yourang»
        self.assertEqual(real.slug, DEMO_SLUG)
        Client.objects.create(salon=real, first_name="Cliente", last_name="Vera", phone="+393331110000")

        for args in ((), ("--reset",)):
            with self.assertRaises(CommandError):
                _seed(*args)
        self.assertTrue(Salon.objects.filter(pk=real.pk).exists())
        self.assertEqual(Client.objects.filter(salon=real).count(), 1)
        self.assertFalse(User.objects.filter(email=DEMO_OWNER_EMAIL).exists())

    def test_reset_recreates_only_the_demo(self):
        other = Salon.objects.create(name="Salone vero", slug="vero")
        _seed("--password", "demo-scelta-123")
        demo = Salon.objects.get(slug=DEMO_SLUG)
        self.assertIn("già presente", _seed())
        self.assertTrue(Salon.objects.filter(pk=demo.pk).exists())

        output = _seed("--reset")
        self.assertIn("password invariata", output)
        self.assertFalse(Salon.objects.filter(pk=demo.pk).exists())
        again = Salon.objects.get(slug=DEMO_SLUG)
        self.assertTrue(again.is_demo)
        self.assertTrue(Salon.objects.filter(pk=other.pk).exists())
        self.assertTrue(User.objects.get(email=DEMO_OWNER_EMAIL).check_password("demo-scelta-123"))

    def test_the_teardown_refuses_a_salon_that_is_not_a_demo(self):
        real = Salon.objects.create(name="The Parlour", slug="vero")
        with self.assertRaises(CommandError):
            _teardown(real)
        self.assertTrue(Salon.objects.filter(pk=real.pk).exists())
