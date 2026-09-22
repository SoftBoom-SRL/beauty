"""Test essenziali: reorder categorie, pacchetto con items (ricreati a ogni
update), endpoint pubblici (raggruppamento + filtro attivi + 404 salone).

Le view sono chiamate per lo più direttamente (bypassando l'HTTP layer): usano
solo `request.auth`, quindi basta un `SimpleNamespace` con un `StaffContext`
costruito a mano. `CatalogHttpSmokeTests` invece passa DAVVERO da /api/catalog/…:
finché nessun test faceva una richiesta HTTP, un instradamento rotto sarebbe
rimasto invisibile con la suite tutta verde.
"""

from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import ActivityLog, Salon
from common.auth import StaffContext

from .api import (
    create_category,
    create_package,
    create_service,
    public_packages,
    public_services,
    reorder_categories,
    update_category,
    update_package,
    update_service,
)
from .models import Package, PackageItem, Service, ServiceCategory
from .schemas import CategoryIn, PackageIn, PackageItemIn, ReorderIn, ServiceIn


def fake_request(auth=None):
    """Richiesta finta: `META` serve al rate limit degli endpoint pubblici."""
    return SimpleNamespace(auth=auth, META={"REMOTE_ADDR": "203.0.113.7"}, GET={})


class CatalogTestCase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"pricing"}, is_owner=False
        )
        self.request = fake_request(ctx)


class ReorderCategoriesTests(CatalogTestCase):
    def test_reorder_updates_order_field(self):
        c1 = create_category(self.request, CategoryIn(name_it="Unghie"))
        c2 = create_category(self.request, CategoryIn(name_it="Capelli"))
        c3 = create_category(self.request, CategoryIn(name_it="Viso"))
        self.assertEqual([c1.order, c2.order, c3.order], [0, 0, 0])

        reorder_categories(self.request, ReorderIn(ids=[c3.id, c1.id, c2.id]))

        c1.refresh_from_db()
        c2.refresh_from_db()
        c3.refresh_from_db()
        self.assertEqual(c3.order, 0)
        self.assertEqual(c1.order, 1)
        self.assertEqual(c2.order, 2)

    def test_reorder_ignores_unknown_ids(self):
        c1 = create_category(self.request, CategoryIn(name_it="Unghie"))
        result = list(reorder_categories(self.request, ReorderIn(ids=[999, c1.id])))
        self.assertEqual([c.id for c in result], [c1.id])


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


class PackageUpdateAtomicityTests(CatalogTestCase):
    """Un aggiornamento con un servizio inesistente non deve lasciare il
    pacchetto senza righe o con il prezzo già cambiato."""

    def test_failed_update_keeps_items_and_price(self):
        from django.http import Http404

        category = create_category(self.request, CategoryIn(name_it="Unghie"))
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
        category = create_category(self.request, CategoryIn(name_it="Unghie"))
        create_service(
            self.request,
            ServiceIn(category_id=category.id, name_it="Manicure", description_it="Cura completa di mani e unghie",
                      description_en="Full hand and nail care", duration_min=30, price=Decimal("20")),
        )
        listing = public_services(self.request, salon="the-parlour")
        service = listing[0]["services"][0]
        self.assertEqual(service.description_it, "Cura completa di mani e unghie")
        self.assertEqual(service.description_en, "Full hand and nail care")


class CategoryColorTests(CatalogTestCase):
    """Rinominare una categoria non deve riportarne il colore a quello di fabbrica."""

    def test_update_without_color_keeps_the_existing_one(self):
        category = create_category(self.request, CategoryIn(name_it="Unghie", color="#123456"))
        update_category(self.request, category.id, CategoryIn(name_it="Mani", order=2))
        category.refresh_from_db()
        self.assertEqual(category.color, "#123456")
        self.assertEqual(category.name_it, "Mani")
        self.assertEqual(category.order, 2)

    def test_update_with_color_changes_it(self):
        category = create_category(self.request, CategoryIn(name_it="Unghie", color="#123456"))
        update_category(self.request, category.id, CategoryIn(name_it="Unghie", color="#00FF00"))
        category.refresh_from_db()
        self.assertEqual(category.color, "#00FF00")

    def test_create_without_color_uses_the_default(self):
        category = create_category(self.request, CategoryIn(name_it="Viso"))
        self.assertEqual(category.color, "#E0E7FF")


class CategoryValidationTests(CatalogTestCase):
    """Colore e ordine fuori range sono errori della richiesta, non del database."""

    def test_invalid_color_is_a_400(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, CategoryIn(name_it="Unghie", color="rosso"))
        self.assertEqual(caught.exception.status_code, 400)

    def test_negative_order_is_a_400(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, CategoryIn(name_it="Unghie", order=-1))
        self.assertEqual(caught.exception.status_code, 400)

    def test_update_with_invalid_color_is_a_400_and_changes_nothing(self):
        category = create_category(self.request, CategoryIn(name_it="Unghie", color="#123456"))
        with self.assertRaises(HttpError) as caught:
            update_category(self.request, category.id, CategoryIn(name_it="X", color="#12"))
        self.assertEqual(caught.exception.status_code, 400)
        category.refresh_from_db()
        self.assertEqual((category.name_it, category.color), ("Unghie", "#123456"))


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


class CatalogHttpSmokeTests(TestCase):
    """Una richiesta HTTP vera per router: senza, un endpoint irraggiungibile
    (405 o 404 di instradamento) resta verde in una suite che chiama le view
    come funzioni. Il riordino categorie era dato per rotto proprio così."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="titolare@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Listino", scopes=["pricing"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

    def test_post_categories_reorder_is_routed_and_persists_the_order(self):
        first = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        second = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        res = self.client.post(
            "/api/catalog/categories/reorder",
            data={"ids": [second.id, first.id]},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([c["id"] for c in res.json()], [second.id, first.id])
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((second.order, first.order), (0, 1))

    def test_categories_crud_round_trip_over_http(self):
        created = self.client.post(
            "/api/catalog/categories",
            data={"name_it": "Viso", "color": "#ABCDEF"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(created.status_code, 200, created.content)
        category_id = created.json()["id"]

        renamed = self.client.put(
            f"/api/catalog/categories/{category_id}",
            data={"name_it": "Viso e collo"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(renamed.status_code, 200, renamed.content)
        self.assertEqual(renamed.json()["color"], "#ABCDEF")  # colore non travolto

        listing = self.client.get("/api/catalog/categories", **self.auth)
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual([c["name_it"] for c in listing.json()], ["Viso e collo"])

    def test_public_services_over_http_needs_no_auth(self):
        res = self.client.get(f"/api/catalog/public/services?salon={self.salon.slug}")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json(), [])
