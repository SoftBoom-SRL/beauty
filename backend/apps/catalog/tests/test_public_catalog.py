"""Listino pubblico, senza autenticazione: servizi raggruppati per categoria,
solo gli attivi, pacchetti con le loro righe, 404 per un salone inesistente.

Caccia del 22/09:
- 09-07 (C4): il listino pubblico porta la posa (`soak_min`), anche nei pacchetti.
"""

from decimal import Decimal

from ninja.errors import HttpError

from ..api import public_packages, public_services
from ..models import Package, PackageItem, Service, ServiceCategory
from .base import CatalogTestCase, _CatalogSetup, fake_request


class PublicEndpointsTests(CatalogTestCase):
    def test_public_services_groups_by_category_and_hides_inactive(self):
        cat_a = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie", order=1)
        cat_b = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli", order=0)
        Service.objects.create(
            salon=self.salon, category=cat_a, name_it="Manicure", duration_min=30,
            price=Decimal("20.00"), active=True,
        )
        Service.objects.create(
            salon=self.salon, category=cat_a, name_it="Vecchio trattamento", duration_min=30,
            price=Decimal("10.00"), active=False,
        )
        Service.objects.create(
            salon=self.salon, category=cat_b, name_it="Piega", duration_min=40,
            price=Decimal("25.00"), active=True,
        )

        result = public_services(fake_request(), self.salon.slug)

        # ordinate per "order" della categoria: Capelli (0) prima di Unghie (1)
        self.assertEqual([c["id"] for c in result], [cat_b.id, cat_a.id])
        unghie = next(c for c in result if c["id"] == cat_a.id)
        self.assertEqual(len(unghie["services"]), 1)
        self.assertEqual(unghie["services"][0].name_it, "Manicure")

    def test_public_services_unknown_salon_returns_404(self):
        with self.assertRaises(HttpError) as exc:
            public_services(fake_request(), "salone-inesistente")
        self.assertEqual(exc.exception.status_code, 404)

    def test_public_packages_hides_inactive_and_includes_items(self):
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = Service.objects.create(
            salon=self.salon, category=cat, name_it="Manicure", duration_min=30, price=Decimal("20.00")
        )
        active_pkg = Package.objects.create(salon=self.salon, name="Combo attivo", price=Decimal("40.00"), active=True)
        PackageItem.objects.create(package=active_pkg, service=service, qty=1)
        Package.objects.create(salon=self.salon, name="Combo disattivo", price=Decimal("40.00"), active=False)

        result = public_packages(fake_request(), self.salon.slug)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["name"], "Combo attivo")
        self.assertEqual(result[0]["items"][0]["name_it"], "Manicure")

    def test_public_packages_unknown_salon_returns_404(self):
        with self.assertRaises(HttpError) as exc:
            public_packages(fake_request(), "salone-inesistente")
        self.assertEqual(exc.exception.status_code, 404)


class PublicSoakTests(_CatalogSetup):
    """09-07: colore 60' + 40' di posa, l'app diceva «1 h»."""

    def test_public_services_carry_the_soak(self):
        res = self.client.get(f"/api/catalog/public/services?salon={self.salon.slug}")
        self.assertEqual(res.status_code, 200, res.content)
        service = res.json()[0]["services"][0]
        self.assertEqual((service["duration_min"], service["soak_min"]), (60, 40))

    def test_public_packages_carry_the_soak_of_their_services(self):
        package = Package.objects.create(salon=self.salon, name="Colore e piega", price=Decimal("80"))
        PackageItem.objects.create(package=package, service=self.color, qty=1)
        res = self.client.get(f"/api/catalog/public/packages?salon={self.salon.slug}")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()[0]["items"][0]["soak_min"], 40)
