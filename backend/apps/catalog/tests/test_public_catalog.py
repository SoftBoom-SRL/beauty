"""Caccia del 22/09: catalogo.

- 09-07 (C4): il listino pubblico porta la posa (`soak_min`), anche nei pacchetti;
- 18-07: modificare un servizio o un pacchetto non riscrive `yourang_item_id`
  scritto nel frattempo dalla sincronizzazione.
"""

import json
from decimal import Decimal
from unittest import mock

from django.test import TestCase

from apps.accounts.models import Membership, User
from apps.core.models import Salon
from common.auth import create_staff_tokens

from .. import api as catalog_api
from ..models import Package, PackageItem, Service, ServiceCategory


class _CatalogSetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.cat = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.color = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Colore", duration_min=60,
            soak_min=40, price=Decimal("60"),
        )
        owner = User.objects.create_user(email="titolare@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}


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


class YourangLinkSurvivesEditsTests(_CatalogSetup):
    """18-07: la sincronizzazione collega la voce mentre il titolare modifica il prezzo."""

    def _sync_links_meanwhile(self, model, item_id):
        real = catalog_api.salon_get

        def read_then_sync(m, ctx, pk, **kwargs):
            obj = real(m, ctx, pk, **kwargs)
            if m is model:
                model.objects.filter(pk=obj.pk).update(yourang_item_id=item_id)
            return obj

        return mock.patch.object(catalog_api, "salon_get", side_effect=read_then_sync)

    def test_editing_a_service_keeps_the_link_written_by_the_sync(self):
        body = {
            "category_id": self.cat.id, "name_it": "Colore", "duration_min": 60,
            "soak_min": 40, "price": "65",
        }
        with self._sync_links_meanwhile(Service, "yr-123"):
            res = self.client.put(
                f"/api/catalog/services/{self.color.id}", data=json.dumps(body),
                content_type="application/json", **self.auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.color.refresh_from_db()
        self.assertEqual(self.color.price, Decimal("65"))
        self.assertEqual(self.color.yourang_item_id, "yr-123")

    def test_editing_a_package_keeps_the_link_written_by_the_sync(self):
        package = Package.objects.create(salon=self.salon, name="Colore e piega", price=Decimal("80"))
        with self._sync_links_meanwhile(Package, "yr-456"):
            res = self.client.put(
                f"/api/catalog/packages/{package.id}",
                data=json.dumps({"name": "Colore e piega", "price": "85"}),
                content_type="application/json", **self.auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        package.refresh_from_db()
        self.assertEqual(package.price, Decimal("85"))
        self.assertEqual(package.yourang_item_id, "yr-456")
