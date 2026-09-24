"""Servizi e pacchetti del listino: le righe del pacchetto (ricreate a ogni
modifica, conservate se la modifica non le manda), il cambio di prezzo nel
registro attività, la posa, la descrizione.

Caccia del 22/09:
- 18-07: modificare un servizio o un pacchetto non riscrive `yourang_item_id`
  scritto nel frattempo dalla sincronizzazione.
"""

import json
from decimal import Decimal
from unittest import mock

from apps.core.models import ActivityLog

from .. import api as catalog_api
from ..api import (
    create_category,
    create_package,
    create_service,
    public_services,
    update_package,
    update_service,
)
from ..models import Package, PackageItem, Service, ServiceCategory
from ..schemas import PackageIn, PackageItemIn, ServiceCategoryIn, ServiceIn
from .base import CatalogTestCase, _CatalogSetup


class PackageWithItemsTests(CatalogTestCase):
    def setUp(self):
        super().setUp()
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.s1 = Service.objects.create(
            salon=self.salon, category=cat, name_it="Manicure", duration_min=30, price=Decimal("20.00")
        )
        self.s2 = Service.objects.create(
            salon=self.salon, category=cat, name_it="Pedicure", duration_min=45, price=Decimal("30.00")
        )

    def test_create_package_creates_nested_items(self):
        data = PackageIn(
            name="Combo mani-piedi",
            price=Decimal("45.00"),
            items=[PackageItemIn(service_id=self.s1.id, qty=2)],
        )
        out = create_package(self.request, data)

        package = Package.objects.get(id=out["id"])
        self.assertEqual(package.items.count(), 1)
        self.assertEqual(package.items.first().service_id, self.s1.id)
        self.assertEqual(package.items.first().qty, 2)
        # la view ritorna istanze PackageItem (serializzate da ninja a livello HTTP)
        self.assertEqual(out["items"][0].qty, 2)

    def test_update_package_recreates_items(self):
        data = PackageIn(
            name="Combo",
            price=Decimal("45.00"),
            items=[PackageItemIn(service_id=self.s1.id, qty=2)],
        )
        out = create_package(self.request, data)
        package_id = out["id"]
        old_item_id = PackageItem.objects.get(package_id=package_id).id

        data2 = PackageIn(
            name="Combo",
            price=Decimal("45.00"),
            items=[PackageItemIn(service_id=self.s2.id, qty=1)],
        )
        update_package(self.request, package_id, data2)

        items = list(PackageItem.objects.filter(package_id=package_id))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].service_id, self.s2.id)
        self.assertEqual(items[0].qty, 1)
        self.assertFalse(PackageItem.objects.filter(id=old_item_id).exists())


class ServicePriceChangeLogTests(CatalogTestCase):
    def test_price_change_logs_activity_with_old_and_new(self):
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = create_service(
            self.request,
            ServiceIn(category_id=cat.id, name_it="Manicure", duration_min=30, price=Decimal("20.00")),
        )
        update_service(
            self.request,
            service.id,
            ServiceIn(category_id=cat.id, name_it="Manicure", duration_min=30, price=Decimal("25.00")),
        )
        log = ActivityLog.objects.get(type="service.price_changed")
        self.assertEqual(log.payload["old"], "20.00")
        self.assertEqual(log.payload["new"], "25.00")

    def test_no_price_change_does_not_log(self):
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = create_service(
            self.request,
            ServiceIn(category_id=cat.id, name_it="Manicure", duration_min=30, price=Decimal("20.00")),
        )
        update_service(
            self.request,
            service.id,
            ServiceIn(category_id=cat.id, name_it="Manicure", duration_min=35, price=Decimal("20.00")),
        )
        self.assertFalse(ActivityLog.objects.filter(type="service.price_changed").exists())


class ServiceSoakMinTests(CatalogTestCase):
    """Il tempo di posa (soak_min) fa round-trip su create/update del servizio."""

    def setUp(self):
        super().setUp()
        self.cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")

    def test_create_service_persists_soak_min(self):
        service = create_service(
            self.request,
            ServiceIn(
                category_id=self.cat.id,
                name_it="Colore",
                duration_min=30,
                soak_min=45,
                price=Decimal("60.00"),
            ),
        )
        service.refresh_from_db()
        self.assertEqual(service.duration_min, 30)
        self.assertEqual(service.soak_min, 45)

    def test_create_service_soak_min_defaults_to_zero(self):
        service = create_service(
            self.request,
            ServiceIn(
                category_id=self.cat.id,
                name_it="Piega",
                duration_min=40,
                price=Decimal("25.00"),
            ),
        )
        self.assertEqual(service.soak_min, 0)

    def test_update_service_persists_soak_min(self):
        service = create_service(
            self.request,
            ServiceIn(
                category_id=self.cat.id,
                name_it="Colore",
                duration_min=30,
                soak_min=45,
                price=Decimal("60.00"),
            ),
        )
        update_service(
            self.request,
            service.id,
            ServiceIn(
                category_id=self.cat.id,
                name_it="Colore",
                duration_min=30,
                soak_min=20,
                price=Decimal("60.00"),
            ),
        )
        service.refresh_from_db()
        self.assertEqual(service.soak_min, 20)


class PackageUpdateAtomicityTests(CatalogTestCase):
    """Un aggiornamento con un servizio inesistente non deve lasciare il
    pacchetto senza righe o con il prezzo già cambiato."""

    def test_failed_update_keeps_items_and_price(self):
        from django.http import Http404

        category = create_category(self.request, ServiceCategoryIn(name_it="Unghie"))
        service = create_service(
            self.request,
            ServiceIn(category_id=category.id, name_it="Manicure", duration_min=30, price=Decimal("20")),
        )
        created = create_package(
            self.request,
            PackageIn(name="Pack", price=Decimal("50"), items=[PackageItemIn(service_id=service.id, qty=2)]),
        )
        package = Package.objects.get(pk=created["id"])
        with self.assertRaises(Http404):
            update_package(
                self.request,
                package.id,
                PackageIn(name="Pack", price=Decimal("10"), items=[PackageItemIn(service_id=999999)]),
            )
        package.refresh_from_db()
        self.assertEqual(package.price, Decimal("50"))
        self.assertEqual(list(package.items.values_list("service_id", "qty")), [(service.id, 2)])

    def test_schema_rejects_zero_duration_and_negative_price(self):
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            ServiceIn(category_id=1, name_it="X", duration_min=0, price=Decimal("10"))
        with self.assertRaises(ValidationError):
            ServiceIn(category_id=1, name_it="X", duration_min=30, price=Decimal("-1"))
        with self.assertRaises(ValidationError):
            PackageItemIn(service_id=1, qty=0)


class ServiceDescriptionTests(CatalogTestCase):
    def test_description_is_stored_and_public(self):
        category = create_category(self.request, ServiceCategoryIn(name_it="Unghie"))
        create_service(
            self.request,
            ServiceIn(category_id=category.id, name_it="Manicure", description_it="Cura completa di mani e unghie",
                      description_en="Full hand and nail care", duration_min=30, price=Decimal("20")),
        )
        listing = public_services(self.request, salon="the-parlour")
        service = listing[0]["services"][0]
        self.assertEqual(service.description_it, "Cura completa di mani e unghie")
        self.assertEqual(service.description_en, "Full hand and nail care")


class PackageItemsPreservedTests(CatalogTestCase):
    """Un PUT che cambia solo il prezzo non deve svuotare il pacchetto."""

    def setUp(self):
        super().setUp()
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon, category=cat, name_it="Manicure", duration_min=30, price=Decimal("20")
        )

    def test_update_without_items_keeps_them(self):
        created = create_package(
            self.request,
            PackageIn(
                name="Combo", price=Decimal("45"),
                items=[PackageItemIn(service_id=self.service.id, qty=2)],
            ),
        )
        update_package(self.request, created["id"], PackageIn(name="Combo", price=Decimal("39")))
        package = Package.objects.get(pk=created["id"])
        self.assertEqual(package.price, Decimal("39"))
        self.assertEqual(
            list(package.items.values_list("service_id", "qty")), [(self.service.id, 2)]
        )

    def test_update_with_empty_items_empties_the_package(self):
        """Mandare `items: []` resta un ordine esplicito di svuotare."""
        created = create_package(
            self.request,
            PackageIn(
                name="Combo", price=Decimal("45"),
                items=[PackageItemIn(service_id=self.service.id, qty=2)],
            ),
        )
        update_package(
            self.request, created["id"], PackageIn(name="Combo", price=Decimal("45"), items=[])
        )
        self.assertEqual(Package.objects.get(pk=created["id"]).items.count(), 0)


class ServiceColumnLimitsTests(_CatalogSetup):
    """Bug sospetti del 24/09, voce 21: `ServiceIn` non limitava i nomi (colonne
    da 120 caratteri) né l'ordine (PositiveIntegerField). Un nome più lungo su
    PostgreSQL e un ordine negativo anche su SQLite erano un 500 invece di un
    errore che dice quale campo correggere."""

    def _send(self, method, url, body):
        return getattr(self.client, method)(
            url, data=json.dumps(body), content_type="application/json", **self.auth
        )

    def test_names_and_order_stay_within_their_columns(self):
        base = {"category_id": self.cat.id, "name_it": "Piega", "duration_min": 30, "price": "25.00"}
        refused = [("name_it", "x" * 121), ("name_en", "x" * 121), ("order", -1), ("order", 2147483648)]
        for field, value in refused:
            body = {**base, field: value}
            res = self._send("post", "/api/catalog/services", body)
            self.assertEqual(res.status_code, 422, (field, value))
            res = self._send("put", f"/api/catalog/services/{self.color.id}", body)
            self.assertEqual(res.status_code, 422, (field, value))
        self.assertFalse(Service.objects.filter(name_it="Piega").exists())
        at_the_limit = {**base, "name_it": "x" * 120, "name_en": "x" * 120, "order": 2147483647}
        res = self._send("post", "/api/catalog/services", at_the_limit)
        self.assertEqual(res.status_code, 200, res.content)


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
