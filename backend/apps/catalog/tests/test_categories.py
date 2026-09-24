"""Categorie del listino: riordino, colore, validazione.

`CatalogHttpSmokeTests` passa invece DAVVERO da /api/catalog/…: finché nessun
test faceva una richiesta HTTP, un instradamento rotto sarebbe rimasto
invisibile con la suite tutta verde.
"""

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import Salon
from common.testing import bearer

from ..api import create_category, reorder_categories, update_category
from ..models import ServiceCategory
from ..schemas import CategoryIn, ReorderIn
from .base import CatalogTestCase


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


class CatalogHttpSmokeTests(TestCase):
    """Una richiesta HTTP vera per router: senza, un endpoint irraggiungibile
    (405 o 404 di instradamento) resta verde in una suite che chiama le view
    come funzioni. Il riordino categorie era dato per rotto proprio così."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="titolare@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Listino", scopes=["pricing"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = bearer(user, self.salon)

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
