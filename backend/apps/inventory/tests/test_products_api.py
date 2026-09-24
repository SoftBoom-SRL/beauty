"""Prodotti e categorie del magazzino: API, validazione, elenchi.

Caccia del 22/09:
- 09-10: ordinamenti univoci sotto la paginazione;
- 15-05 (C8, verifica): i prodotti disattivati si ritrovano e si riattivano.
"""

import json
from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import Salon
from apps.staff.models import Operator
from common.testing import bearer, staff_context

from .. import api as inventory_api
from ..api import (
    create_category,
    create_product,
    unload_product,
    update_category,
    update_product,
)
from ..models import Product, ProductCategory, StockMovement, Supplier
from ..schemas import CategoryIn, MovementOut, ProductIn, ProductUnloadIn
from ..services import apply_movement
from .base import _InventorySetup


class InventoryApiTests(TestCase):
    """Endpoint-level: colore delle categorie e operatrice sullo scarico.

    Le view sono chiamate direttamente con uno `StaffContext` costruito a mano
    (stesso pattern di apps.catalog.tests.base): usano solo `request.auth`.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        ctx = staff_context(self.salon, {"inventory"})
        self.request = SimpleNamespace(auth=ctx)

    def _product(self, name, *, stock=0):
        return Product.objects.create(
            salon=self.salon,
            name=name,
            supplier=self.supplier,
            stock_qty=Decimal(stock),
        )

    # ---- colore categorie ----------------------------------------------------

    def test_create_category_persists_color(self):
        cat = create_category(self.request, CategoryIn(name="Tinte", color="#FF0000"))
        self.assertEqual(cat.color, "#FF0000")
        self.assertEqual(ProductCategory.objects.get(pk=cat.id).color, "#FF0000")

    def test_create_category_defaults_color(self):
        cat = create_category(self.request, CategoryIn(name="Cura"))
        self.assertEqual(cat.color, "#E0E7FF")

    def test_update_category_without_color_keeps_existing(self):
        cat = create_category(self.request, CategoryIn(name="Tinte", color="#123456"))
        # payload senza color (come dal gestore categorie delle impostazioni)
        update_category(self.request, cat.id, CategoryIn(name="Colori", order=3))
        cat.refresh_from_db()
        self.assertEqual(cat.color, "#123456")  # colore invariato
        self.assertEqual(cat.name, "Colori")
        self.assertEqual(cat.order, 3)

    def test_update_category_with_color_updates_it(self):
        cat = create_category(self.request, CategoryIn(name="Tinte", color="#123456"))
        update_category(self.request, cat.id, CategoryIn(name="Tinte", color="#00FF00"))
        cat.refresh_from_db()
        self.assertEqual(cat.color, "#00FF00")

    # ---- operatrice sullo scarico --------------------------------------------

    def test_unload_with_operator_records_it(self):
        operator = Operator.objects.create(
            salon=self.salon, first_name="Anna", last_name="Rossi"
        )
        product = self._product("Shampoo", stock=10)
        movement = unload_product(
            self.request,
            product.id,
            ProductUnloadIn(
                qty=Decimal("2"), kind="internal_use", operator_id=operator.id
            ),
        )
        self.assertEqual(movement.operator_id, operator.id)
        self.assertEqual(MovementOut.resolve_operator_name(movement), "Anna Rossi")
        product.refresh_from_db()
        self.assertEqual(product.stock_qty, Decimal("8"))

    def test_unload_without_operator(self):
        product = self._product("Balsamo", stock=5)
        movement = unload_product(
            self.request,
            product.id,
            ProductUnloadIn(qty=Decimal("1"), kind="adjustment"),
        )
        self.assertIsNone(movement.operator_id)
        self.assertEqual(MovementOut.resolve_operator_name(movement), "")
        product.refresh_from_db()
        self.assertEqual(product.stock_qty, Decimal("4"))


class ProductCrudTests(TestCase):
    """Creazione e modifica prodotto: non erano coperte da nessun test.

    Il difetto vero è nella modifica: un save() pieno riscriveva anche
    `stock_qty` col valore letto a inizio richiesta, cancellando dalla giacenza
    i movimenti registrati nel frattempo.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        self.category = ProductCategory.objects.create(salon=self.salon, name="Cura")
        ctx = staff_context(self.salon, {"inventory"})
        self.request = SimpleNamespace(auth=ctx)

    def _payload(self, **overrides):
        data = {
            "name": "Shampoo",
            "sku": "SH-01",
            "brand": "Davines",
            "category_id": self.category.id,
            "usage": "retail",
            "supplier_id": self.supplier.id,
            "purchase_price": Decimal("5.00"),
            "sale_price": Decimal("12.00"),
            "min_threshold": Decimal("3"),
            "reorder_qty": Decimal("6"),
        }
        data.update(overrides)
        return ProductIn(**data)

    def test_create_product_persists_the_payload(self):
        product = create_product(self.request, self._payload())
        product.refresh_from_db()
        self.assertEqual(product.salon_id, self.salon.id)
        self.assertEqual(product.name, "Shampoo")
        self.assertEqual(product.category_id, self.category.id)
        self.assertEqual(product.supplier_id, self.supplier.id)
        self.assertEqual(product.sale_price, Decimal("12.00"))
        self.assertEqual(product.stock_qty, Decimal("0"))

    def test_create_product_with_unknown_usage_is_a_400(self):
        with self.assertRaises(HttpError) as caught:
            create_product(self.request, self._payload(usage="inventato"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(Product.objects.exists())

    def test_update_product_changes_the_registry_fields(self):
        product = create_product(self.request, self._payload())
        update_product(self.request, product.id, self._payload(name="Shampoo delicato",
                                                              sale_price=Decimal("14.00"),
                                                              category_id=None))
        product.refresh_from_db()
        self.assertEqual(product.name, "Shampoo delicato")
        self.assertEqual(product.sale_price, Decimal("14.00"))
        self.assertIsNone(product.category_id)

    def test_update_product_does_not_resurrect_the_stale_stock(self):
        """Si apre la scheda con giacenza 10, il banco vende 3, si salva il
        prezzo: la giacenza deve restare 7, non tornare a 10."""
        product = create_product(self.request, self._payload())
        apply_movement(product, StockMovement.Kind.LOAD, Decimal("10"))

        stale = Product.objects.get(pk=product.pk)  # copia letta a inizio richiesta
        apply_movement(
            Product.objects.get(pk=product.pk), StockMovement.Kind.SALE, Decimal("-3")
        )
        self.assertEqual(stale.stock_qty, Decimal("10"))  # la copia è ferma a prima

        update_product(self.request, stale.id, self._payload(sale_price=Decimal("15.00")))

        product.refresh_from_db()
        self.assertEqual(product.stock_qty, Decimal("7"))
        self.assertEqual(product.sale_price, Decimal("15.00"))


class CategoryValidationTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ctx = staff_context(self.salon, {"inventory"})
        self.request = SimpleNamespace(auth=ctx)

    def test_invalid_color_is_a_400(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, CategoryIn(name="Tinte", color="verde acqua"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertFalse(ProductCategory.objects.exists())

    def test_negative_order_is_a_400(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, CategoryIn(name="Tinte", order=-1))
        self.assertEqual(caught.exception.status_code, 400)

    def test_order_beyond_the_column_is_a_400(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, CategoryIn(name="Tinte", order=99999))
        self.assertEqual(caught.exception.status_code, 400)


class InventoryHttpSmokeTests(TestCase):
    """Una richiesta HTTP vera per router: senza, un endpoint irraggiungibile
    resterebbe verde in una suite che chiama le view come funzioni."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        user = User.objects.create_user(email="magazzino@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Magazzino", scopes=["inventory"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = bearer(user, self.salon)

    def test_product_create_list_and_update_over_http(self):
        created = self.client.post(
            "/api/inventory/products",
            data={"name": "Shampoo", "supplier_id": self.supplier.id, "sale_price": "12.00"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(created.status_code, 200, created.content)
        product_id = created.json()["id"]

        listing = self.client.get("/api/inventory/products", **self.auth)
        self.assertEqual(listing.status_code, 200, listing.content)
        self.assertEqual([p["id"] for p in listing.json()["items"]], [product_id])

        updated = self.client.put(
            f"/api/inventory/products/{product_id}",
            data={"name": "Shampoo delicato", "supplier_id": self.supplier.id,
                  "sale_price": "13.00"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(updated.status_code, 200, updated.content)
        self.assertEqual(updated.json()["name"], "Shampoo delicato")

    def test_categories_over_http(self):
        created = self.client.post(
            "/api/inventory/categories",
            data={"name": "Tinte", "color": "#ABCDEF"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(created.status_code, 200, created.content)
        self.assertEqual(created.json()["color"], "#ABCDEF")

        refused = self.client.post(
            "/api/inventory/categories",
            data={"name": "Tinte", "color": "azzurro"},
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(refused.status_code, 400, refused.content)


class StableOrderingTests(_InventorySetup):
    """09-10: con LIMIT/OFFSET l'ordine deve essere univoco."""

    def _request(self):
        ctx = staff_context(self.salon, {"inventory"})
        return SimpleNamespace(auth=ctx)

    def test_products_end_with_the_id(self):
        qs = inventory_api.list_products.__wrapped__(self._request())
        self.assertEqual(list(qs.query.order_by), ["below_threshold", "name", "id"])

    def test_movements_end_with_the_id(self):
        qs = inventory_api._filter_movements(StockMovement.objects.all(), "", "", "")
        self.assertEqual(list(qs.query.order_by), ["-created_at", "-id"])

    def test_homonyms_are_paged_without_repeats(self):
        ids = [self._product("Shampoo idratante", brand=f"Marca {n}").id for n in range(3)]
        seen = []
        for offset in range(3):
            res = self.client.get(f"/api/inventory/products?limit=1&offset={offset}", **self.auth)
            seen.extend(item["id"] for item in res.json()["items"])
        self.assertEqual(seen, ids)


class MovementDateFilterTests(_InventorySetup):
    """Bug sospetti del 24/09, voce 15: «2026-02-30» è scritta bene ma non
    esiste, e `parse_date` solleva ValueError: lo storico dei movimenti
    rispondeva 500."""

    def test_an_impossible_date_is_a_400(self):
        product = self._product("Shampoo")
        for url in ("/api/inventory/movements", f"/api/inventory/products/{product.id}/movements"):
            for param in ("date_from", "date_to"):
                res = self.client.get(f"{url}?{param}=2026-02-30", **self.auth)
                self.assertEqual(res.status_code, 400, (url, param))
                self.assertEqual(res.json()["detail"], "Data non valida: usa il formato YYYY-MM-DD")


class DeactivatedProductsTests(_InventorySetup):
    """15-05 (C8, verifica): «Disattiva» sul prodotto è reversibile dall'API."""

    def test_deactivated_products_are_listed_on_request_and_can_be_reactivated(self):
        gel = self._product("Gel", active=False)
        default = self.client.get("/api/inventory/products", **self.auth).json()["items"]
        self.assertEqual(default, [])
        listed = self.client.get("/api/inventory/products?include_inactive=true", **self.auth).json()
        self.assertEqual([p["id"] for p in listed["items"]], [gel.id])
        self.assertIs(listed["items"][0]["active"], False)
        body = {"name": "Gel", "supplier_id": self.sup_a.id, "active": True}
        res = self.client.put(
            f"/api/inventory/products/{gel.id}", data=json.dumps(body),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        gel.refresh_from_db()
        self.assertTrue(gel.active)
