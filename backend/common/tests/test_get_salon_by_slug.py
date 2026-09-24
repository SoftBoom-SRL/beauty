"""`apps.core.services.get_salon_by_slug` contro le sei copie che sostituisce.

Al commit 4ecefc8: accounts/api.py `_salon_by_slug`, catalog/api.py e
staff/api.py `_get_salon_by_slug`, e lo stesso try/except scritto dentro
core/api.py `public_branding`, agenda/api.py `public_availability` e
clients/api.py `public_hook`.
"""

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import Salon
from apps.core.services import get_salon_by_slug


def _copied_lookup(slug):
    # accounts/api.py `_salon_by_slug`, com'era.
    try:
        return Salon.objects.get(slug=slug)
    except Salon.DoesNotExist:
        raise HttpError(404, "Salone non trovato")


def _outcome(fn, slug):
    try:
        return ("salon", fn(slug).pk)
    except HttpError as exc:
        return ("error", exc.status_code, exc.message)


class GetSalonBySlugTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.salon = Salon.objects.create(name="Atelier Bianchi", slug="atelier-bianchi")
        cls.demo = Salon.objects.create(name="The Parlour", slug="the-parlour", is_demo=True)

    def test_finds_the_salon_with_one_query(self):
        with self.assertNumQueries(1):
            found = get_salon_by_slug("atelier-bianchi")
        self.assertEqual(found, self.salon)
        self.assertIsInstance(found, Salon)

    def test_unknown_slug_is_a_404(self):
        with self.assertRaises(HttpError) as caught:
            get_salon_by_slug("non-esiste")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(caught.exception.message, "Salone non trovato")

    def test_demo_salon_is_not_filtered_out(self):
        # Le copie non filtrano `is_demo`: la web app del salone demo funziona.
        self.assertEqual(get_salon_by_slug("the-parlour"), self.demo)

    def test_same_outcome_as_the_copies(self):
        for slug in ("atelier-bianchi", "the-parlour", "non-esiste", "", "ATELIER-BIANCHI", "atelier-bianchi "):
            self.assertEqual(_outcome(get_salon_by_slug, slug), _outcome(_copied_lookup, slug), repr(slug))
