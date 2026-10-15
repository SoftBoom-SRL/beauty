"""Slug del salone: cambiarlo dall'admin non rompe i link già dati alle clienti.

Un salone attivato da una collega per la cliente nasceva con lo slug della
collega, e i link dell'app cliente (`/<slug>`, `/<slug>/hook`) ne portavano il
nome. Cambiando lo slug il vecchio resta come alias (`previous_slug`).
"""

from django.test import TestCase

from ..models import Salon


class SalonSlugChangeTests(TestCase):
    def setUp(self):
        from apps.accounts.models import User

        self.salon = Salon.objects.create(name="Maria Carbone", slug="maria-carbone")
        self.client.force_login(User.objects.create_superuser(email="root@x.it", password="pw-lunga-123"))

    def _rename(self, salon, name, slug):
        return self.client.post(
            f"/admin/core/salon/{salon.pk}/change/",
            {"name": name, "slug": slug, "default_lang": "it", "currency": "EUR"},
        )

    def _branding(self, slug):
        return self.client.get(f"/api/core/public/branding?salon={slug}")

    def test_the_old_slug_still_finds_the_salon(self):
        resp = self._rename(self.salon, "Estetica Lucia", "estetica-lucia")
        self.assertEqual(resp.status_code, 302, resp.content)
        self.salon.refresh_from_db()
        self.assertEqual(self.salon.slug, "estetica-lucia")
        self.assertEqual(self.salon.previous_slug, "maria-carbone")

        for slug in ("estetica-lucia", "maria-carbone"):
            resp = self._branding(slug)
            self.assertEqual(resp.status_code, 200, slug)
            # Il salone risponde col suo slug attuale anche da un link vecchio.
            self.assertEqual(resp.json()["slug"], "estetica-lucia")
            self.assertEqual(resp.json()["name"], "Estetica Lucia")
        self.assertEqual(self._branding("nessuno").status_code, 404)

    def test_renaming_without_changing_the_slug_keeps_no_alias(self):
        resp = self._rename(self.salon, "Estetica Lucia", "maria-carbone")
        self.assertEqual(resp.status_code, 302, resp.content)
        self.salon.refresh_from_db()
        self.assertIsNone(self.salon.previous_slug)

    def test_a_salon_cannot_take_the_old_slug_of_another(self):
        self._rename(self.salon, "Estetica Lucia", "estetica-lucia")
        other = Salon.objects.create(name="Altro", slug="altro")

        resp = self._rename(other, "Altro", "maria-carbone")
        self.assertEqual(resp.status_code, 200)  # il form torna con l'errore
        other.refresh_from_db()
        self.assertEqual(other.slug, "altro")
        # I link vecchi portano ancora al salone giusto.
        self.assertEqual(self._branding("maria-carbone").json()["name"], "Estetica Lucia")

    def test_new_salons_skip_old_slugs(self):
        from apps.integrations.login import _unique_salon_slug

        self._rename(self.salon, "Estetica Lucia", "estetica-lucia")
        self.assertEqual(_unique_salon_slug("Maria Carbone"), "maria-carbone-2")
        self.assertTrue(Salon.slug_taken("maria-carbone"))
        self.assertFalse(Salon.slug_taken("libero"))
