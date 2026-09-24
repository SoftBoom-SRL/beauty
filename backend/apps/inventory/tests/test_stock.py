"""Giacenze: la porta unica `apply_movement`, le bozze d'ordine dei prodotti
sotto scorta, la ricezione, i movimenti che restano come prova.

Caccia del 22/09:
- 09-08: la vendita avvisa il magazzino con un evento `stock.*` senza importi.
"""

from decimal import Decimal

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import ActivityLog, Salon

from ..models import Product, PurchaseOrder, StockMovement, Supplier
from ..orders import generate_draft_orders, receive_order
from ..services import apply_movement, deduct_stock_for_sale
from .base import _InventorySetup


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
        qty_by_product = {line.product_id: line.qty_ordered for line in order_a.lines.all()}
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


class StockSoldEventTests(_InventorySetup):
    """09-08: dopo una vendita il magazzino aperto altrove resta vecchio."""

    def test_a_sale_tells_the_inventory_without_amounts(self):
        from apps.sales.models import Sale, SaleLine

        tinta = self._product("Tinta 5.0", stock_qty=Decimal("0"))
        apply_movement(tinta, StockMovement.Kind.LOAD, Decimal("3"))
        sale = Sale.objects.create(salon=self.salon, kind="pos", total=Decimal("45"))
        SaleLine.objects.create(
            sale=sale, product=tinta, line_type="product", qty=3,
            unit_price=Decimal("15"), amount=Decimal("45"),
        )
        deduct_stock_for_sale(sale)
        event = ActivityLog.objects.get(salon=self.salon, type="stock.sold")
        self.assertEqual(event.payload["product_ids"], [tinta.id])
        self.assertEqual(event.payload["sale_id"], sale.id)
        self.assertIn("Tinta 5.0 ×3", event.summary)
        self.assertNotIn("45", event.summary)
        self.assertNotIn("€", event.summary)

    def test_a_sale_without_products_raises_no_event(self):
        from apps.sales.models import Sale

        sale = Sale.objects.create(salon=self.salon, kind="pos", total=Decimal("30"))
        deduct_stock_for_sale(sale)
        self.assertFalse(ActivityLog.objects.filter(type="stock.sold").exists())
