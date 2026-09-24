"""Ordini ai fornitori: bozze dei prodotti sotto scorta, modifica, invio e
ricezione, ognuno una volta sola."""

from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import Salon
from common.testing import staff_context

from ..api import send_order, update_order
from ..models import Product, PurchaseOrder, PurchaseOrderLine, StockMovement, Supplier
from ..orders import generate_draft_orders, receive_order


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
        ctx = staff_context(self.salon, {"inventory"})
        self.request = SimpleNamespace(auth=ctx)

    def test_update_order_is_all_or_nothing(self):
        from ..schemas import OrderLineUpdateIn, OrderUpdateIn

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
        from ..schemas import OrderLineUpdateIn, OrderUpdateIn

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
        from ..schemas import OrderSendIn

        send_order(self.request, self.order.id, OrderSendIn())
        stale = PurchaseOrder.objects.get(pk=self.order.pk)
        stale.status = PurchaseOrder.Status.DRAFT  # copia letta prima dell'invio
        with self.assertRaises(HttpError) as caught:
            send_order(self.request, stale.id, OrderSendIn())
        self.assertEqual(caught.exception.status_code, 400)
        self.order.refresh_from_db()
        self.assertEqual(self.order.status, PurchaseOrder.Status.SENT)

    def test_update_order_refuses_a_sent_order(self):
        from ..schemas import OrderLineUpdateIn, OrderSendIn, OrderUpdateIn

        send_order(self.request, self.order.id, OrderSendIn())
        with self.assertRaises(HttpError) as caught:
            update_order(
                self.request,
                self.order.id,
                OrderUpdateIn(lines=[OrderLineUpdateIn(id=self.l1.id, qty_ordered=Decimal("1"))]),
            )
        self.assertEqual(caught.exception.status_code, 400)
