from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import Salon
from apps.staff.models import Operator
from common.auth import StaffContext

from .api import (
    create_category,
    create_product,
    load_product,
    send_order,
    unload_product,
    update_category,
    update_order,
    update_product,
)
from .models import Product, ProductCategory, PurchaseOrder, PurchaseOrderLine, StockMovement, Supplier
from .schemas import CategoryIn, MovementOut, ProductIn, ProductLoadIn, ProductUnloadIn
from .services import apply_movement, generate_draft_orders, receive_order


class InventoryTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier_a = Supplier.objects.create(salon=self.salon, name="Davines")
        self.supplier_b = Supplier.objects.create(salon=self.salon, name="Kerastase")

    def _product(self, name, *, supplier=None, stock=0, threshold=0, reorder=0, **extra):
        return Product.objects.create(
            salon=self.salon,
            name=name,
            supplier=supplier or self.supplier_a,
            stock_qty=Decimal(stock),
            min_threshold=Decimal(threshold),
            reorder_qty=Decimal(reorder),
            **extra,
        )

    # ---- apply_movement ------------------------------------------------------

    def test_apply_movement_updates_stock(self):
        product = self._product("Shampoo")
        movement = apply_movement(product, StockMovement.Kind.LOAD, Decimal("10"))
        self.assertEqual(movement.kind, "load")
        self.assertEqual(product.stock_qty, Decimal("10"))
        apply_movement(product, StockMovement.Kind.INTERNAL_USE, Decimal("-4"))
        self.assertEqual(product.stock_qty, Decimal("6"))
        self.assertEqual(product.movements.count(), 2)

    def test_apply_movement_blocks_negative_stock(self):
        product = self._product("Shampoo", stock=6)
        with self.assertRaises(HttpError) as caught:
            apply_movement(product, StockMovement.Kind.SALE, Decimal("-7"))
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("Giacenza insufficiente", str(caught.exception))
        product.refresh_from_db()
        self.assertEqual(product.stock_qty, Decimal("6"))
        self.assertEqual(product.movements.count(), 0)  # nessun movimento creato

    def test_stock_state_property(self):
        product = self._product("Shampoo", stock=2, threshold=5)
        self.assertEqual(product.stock_state, "low")
        product.stock_qty = Decimal("7")  # ≤ 5×1.5
        self.assertEqual(product.stock_state, "warning")
        product.stock_qty = Decimal("8")
        self.assertEqual(product.stock_state, "ok")

    # ---- generate_draft_orders -----------------------------------------------

    def test_generate_draft_orders_groups_by_supplier(self):
        p1 = self._product("Shampoo", supplier=self.supplier_a, stock=1, threshold=5, reorder=10)
        p2 = self._product("Balsamo", supplier=self.supplier_a, stock=0, threshold=3)  # reorder 0
        p3 = self._product("Maschera", supplier=self.supplier_b, stock=2, threshold=2, reorder=6)
        self._product("Olio", supplier=self.supplier_b, stock=50, threshold=2)  # sopra soglia
        self._product("Vecchio", supplier=self.supplier_b, stock=0, threshold=2, reorder=1, active=False)

        orders = generate_draft_orders(self.salon)
        self.assertEqual(len(orders), 2)
        by_supplier = {o.supplier_id: o for o in orders}

        order_a = by_supplier[self.supplier_a.id]
        self.assertEqual(order_a.status, PurchaseOrder.Status.DRAFT)
        qty_by_product = {l.product_id: l.qty_ordered for l in order_a.lines.all()}
        self.assertEqual(qty_by_product[p1.id], Decimal("10"))  # reorder_qty
        self.assertEqual(qty_by_product[p2.id], Decimal("3"))  # soglia − stock

        order_b = by_supplier[self.supplier_b.id]
        self.assertEqual(order_b.lines.count(), 1)
        self.assertEqual(order_b.lines.get().product_id, p3.id)

        # secondo run: i prodotti sono già in bozza → niente duplicati
        self.assertEqual(generate_draft_orders(self.salon), [])

    # ---- receive_order ---------------------------------------------------------

    def test_receive_complete_marks_received(self):
        product = self._product("Shampoo", stock=0, threshold=1, reorder=4)
        [order] = generate_draft_orders(self.salon)
        line = order.lines.get()
        order, discrepancies = receive_order(
            order, [{"id": line.id, "qty_received": Decimal("4")}]
        )
        self.assertEqual(order.status, PurchaseOrder.Status.RECEIVED)
        self.assertEqual(discrepancies, [])
        product.refresh_from_db()
        self.assertEqual(product.stock_qty, Decimal("4"))
        movement = product.movements.get()
        self.assertEqual(movement.kind, "load")
        self.assertEqual(movement.order_id, order.id)

    def test_receive_with_discrepancy_marks_partial(self):
        p1 = self._product("Shampoo", stock=0, threshold=2, reorder=10)
        p2 = self._product("Balsamo", stock=0, threshold=2, reorder=5)
        [order] = generate_draft_orders(self.salon)
        line1 = order.lines.get(product=p1)
        line2 = order.lines.get(product=p2)

        order, discrepancies = receive_order(
            order,
            [
                {"id": line1.id, "qty_received": Decimal("10")},  # combacia
                {"id": line2.id, "qty_received": Decimal("3")},  # ordinati 5
            ],
        )
        self.assertEqual(order.status, PurchaseOrder.Status.PARTIAL)
        self.assertEqual(len(discrepancies), 1)
        self.assertEqual(discrepancies[0]["line_id"], line2.id)
        self.assertEqual(discrepancies[0]["delta"], Decimal("-2"))

        p1.refresh_from_db()
        p2.refresh_from_db()
        self.assertEqual(p1.stock_qty, Decimal("10"))
        self.assertEqual(p2.stock_qty, Decimal("3"))

        # una seconda ricezione è vietata
        with self.assertRaises(HttpError):
            receive_order(order, [])


class InventoryApiTests(TestCase):
    """Endpoint-level: colore delle categorie e operatrice sullo scarico.

    Le view sono chiamate direttamente con uno `StaffContext` costruito a mano
    (stesso pattern di apps.catalog.tests): usano solo `request.auth`.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        ctx = StaffContext(
            user=None,
            salon=self.salon,
            membership=None,
            scopes={"inventory"},
            is_owner=False,
        )
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


class ReceiveOrderConcurrencyTests(TestCase):
    """La stessa ricezione non deve poter essere registrata due volte.

    Il controllo «ordine già ricevuto» guardava l'istanza arrivata con la
    richiesta e stava fuori dalla transazione: due schermate aperte sullo stesso
    ordine caricavano dieci pezzi ciascuna, la giacenza saliva a venti e la riga
    d'ordine ne dichiarava dieci.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Fornitore")
        self.product = Product.objects.create(
            salon=self.salon, supplier=self.supplier, name="Shampoo", stock_qty=0
        )
        self.order = PurchaseOrder.objects.create(
            salon=self.salon, supplier=self.supplier, status=PurchaseOrder.Status.SENT
        )
        self.line = PurchaseOrderLine.objects.create(
            order=self.order, product=self.product, qty_ordered=10
        )

    def test_the_second_receipt_is_refused_and_changes_nothing(self):
        stale = PurchaseOrder.objects.get(pk=self.order.pk)  # copia letta prima
        receive_order(self.order, [{"id": self.line.pk, "qty_received": 10}])

        with self.assertRaises(HttpError) as caught:
            receive_order(stale, [{"id": self.line.pk, "qty_received": 10}])
        self.assertEqual(caught.exception.status_code, 400)

        self.product.refresh_from_db()
        self.line.refresh_from_db()
        self.assertEqual(self.product.stock_qty, 10)
        self.assertEqual(self.line.qty_received, 10)
        self.assertEqual(
            StockMovement.objects.filter(product=self.product, kind=StockMovement.Kind.LOAD).count(),
            1,
        )


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
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"inventory"}, is_owner=False
        )
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
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"inventory"}, is_owner=False
        )
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


class InvoiceUrlTests(TestCase):
    """Il link alla fattura del carico deve essere firmato: `inventory/invoices/`
    è un prefisso riservato e senza token la vista /media/ risponde 403."""

    def test_invoice_url_carries_the_signature(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from common.media import TOKEN_PARAM, verify_media_token

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        supplier = Supplier.objects.create(salon=salon, name="Davines")
        product = Product.objects.create(salon=salon, name="Shampoo", supplier=supplier)
        movement = apply_movement(
            product,
            StockMovement.Kind.LOAD,
            Decimal("5"),
            invoice=SimpleUploadedFile("fattura.pdf", b"%PDF-1.4", content_type="application/pdf"),
        )
        # Il link esce solo a titolare e cassa (10-09): lo chiede il titolare.
        owner = StaffContext(user=None, salon=salon, membership=None, scopes=set(), is_owner=True)
        url = MovementOut.resolve_invoice_url(movement, {"request": SimpleNamespace(auth=owner)})
        self.assertIn(f"?{TOKEN_PARAM}=", url)
        self.assertTrue(verify_media_token(movement.invoice.name, url.split(f"{TOKEN_PARAM}=")[1]))
        movement.invoice.delete(save=False)

    def test_without_invoice_the_url_is_none(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        supplier = Supplier.objects.create(salon=salon, name="Davines")
        product = Product.objects.create(salon=salon, name="Shampoo", supplier=supplier)
        movement = apply_movement(product, StockMovement.Kind.LOAD, Decimal("5"))
        self.assertIsNone(MovementOut.resolve_invoice_url(movement))


class InvoiceUploadValidationTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        self.product = Product.objects.create(salon=self.salon, name="Shampoo", supplier=supplier)
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"inventory"}, is_owner=False
        )
        self.request = SimpleNamespace(auth=ctx)

    def test_executable_attachment_is_refused(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        upload = SimpleUploadedFile(
            "fattura.exe", b"MZ", content_type="application/x-msdownload"
        )
        with self.assertRaises(HttpError) as caught:
            load_product(self.request, self.product.id, ProductLoadIn(qty=Decimal("1")), upload)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(StockMovement.objects.count(), 0)

    def test_oversized_attachment_is_refused(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        upload = SimpleUploadedFile("fattura.pdf", b"%PDF", content_type="application/pdf")
        upload.size = 20 * 1024 * 1024
        with self.assertRaises(HttpError) as caught:
            load_product(self.request, self.product.id, ProductLoadIn(qty=Decimal("1")), upload)
        self.assertEqual(caught.exception.status_code, 400)


class ProductDeletionProtectsHistoryTests(TestCase):
    """Cancellare davvero un prodotto (dall'admin) portava via i movimenti:
    la prova contabile di che cosa è entrato e uscito dal magazzino."""

    def test_a_product_with_movements_cannot_be_deleted(self):
        from django.db.models import ProtectedError as ModelProtectedError

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        supplier = Supplier.objects.create(salon=salon, name="Davines")
        product = Product.objects.create(salon=salon, name="Shampoo", supplier=supplier)
        apply_movement(product, StockMovement.Kind.LOAD, Decimal("5"))
        with self.assertRaises(ModelProtectedError):
            product.delete()
        self.assertEqual(StockMovement.objects.count(), 1)


class DraftOrderThresholdTests(TestCase):
    """Giacenza esattamente pari alla soglia con reorder_qty a zero: il prodotto
    era «sotto scorta» in elenco ma «Genera ordini» lo scartava in silenzio."""

    def test_product_exactly_at_threshold_is_ordered(self):
        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        supplier = Supplier.objects.create(salon=salon, name="Davines")
        product = Product.objects.create(
            salon=salon, name="Balsamo", supplier=supplier,
            stock_qty=Decimal("5"), min_threshold=Decimal("5"), reorder_qty=Decimal("0"),
        )
        self.assertEqual(product.stock_state, "low")
        [order] = generate_draft_orders(salon)
        line = order.lines.get()
        self.assertEqual(line.product_id, product.id)
        self.assertEqual(line.qty_ordered, Decimal("1"))


class OrderWorkflowTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        self.p1 = Product.objects.create(salon=self.salon, name="Shampoo", supplier=self.supplier)
        self.p2 = Product.objects.create(salon=self.salon, name="Balsamo", supplier=self.supplier)
        self.order = PurchaseOrder.objects.create(salon=self.salon, supplier=self.supplier)
        self.l1 = PurchaseOrderLine.objects.create(
            order=self.order, product=self.p1, qty_ordered=Decimal("4")
        )
        self.l2 = PurchaseOrderLine.objects.create(
            order=self.order, product=self.p2, qty_ordered=Decimal("2")
        )
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"inventory"}, is_owner=False
        )
        self.request = SimpleNamespace(auth=ctx)

    def test_update_order_is_all_or_nothing(self):
        from .schemas import OrderLineUpdateIn, OrderUpdateIn

        with self.assertRaises(HttpError) as caught:
            update_order(
                self.request,
                self.order.id,
                OrderUpdateIn(
                    lines=[
                        OrderLineUpdateIn(id=self.l1.id, qty_ordered=Decimal("9")),
                        OrderLineUpdateIn(id=999999, qty_ordered=Decimal("1")),
                    ]
                ),
            )
        self.assertEqual(caught.exception.status_code, 404)
        self.l1.refresh_from_db()
        self.assertEqual(self.l1.qty_ordered, Decimal("4"))  # nulla è stato scritto

    def test_update_order_applies_every_line(self):
        from .schemas import OrderLineUpdateIn, OrderUpdateIn

        update_order(
            self.request,
            self.order.id,
            OrderUpdateIn(
                lines=[
                    OrderLineUpdateIn(id=self.l1.id, qty_ordered=Decimal("9")),
                    OrderLineUpdateIn(id=self.l2.id, qty_ordered=Decimal("0")),  # riga rimossa
                ]
            ),
        )
        self.l1.refresh_from_db()
        self.assertEqual(self.l1.qty_ordered, Decimal("9"))
        self.assertFalse(PurchaseOrderLine.objects.filter(pk=self.l2.pk).exists())

    def test_the_second_send_is_refused(self):
        from .schemas import OrderSendIn

        send_order(self.request, self.order.id, OrderSendIn())
        stale = PurchaseOrder.objects.get(pk=self.order.pk)
        stale.status = PurchaseOrder.Status.DRAFT  # copia letta prima dell'invio
        with self.assertRaises(HttpError) as caught:
            send_order(self.request, stale.id, OrderSendIn())
        self.assertEqual(caught.exception.status_code, 400)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, PurchaseOrder.Status.SENT)

    def test_update_order_refuses_a_sent_order(self):
        from .schemas import OrderLineUpdateIn, OrderSendIn, OrderUpdateIn

        send_order(self.request, self.order.id, OrderSendIn())
        with self.assertRaises(HttpError) as caught:
            update_order(
                self.request,
                self.order.id,
                OrderUpdateIn(lines=[OrderLineUpdateIn(id=self.l1.id, qty_ordered=Decimal("1"))]),
            )
        self.assertEqual(caught.exception.status_code, 400)


class InventoryHttpSmokeTests(TestCase):
    """Una richiesta HTTP vera per router: senza, un endpoint irraggiungibile
    resterebbe verde in una suite che chiama le view come funzioni."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        user = User.objects.create_user(email="magazzino@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Magazzino", scopes=["inventory"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

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
