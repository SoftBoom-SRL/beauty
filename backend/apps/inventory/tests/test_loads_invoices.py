"""Carichi di magazzino (singoli e da CSV) e fatture del carico.

Caccia del 22/09:
- 09-02 / 15-04 (C7): il carico va al prodotto scelto (`product_id`); per nome
  o SKU solo fra gli attivi, e un abbinamento ambiguo è un errore di riga;
- 09-06: un errore a metà carico resta sulla sua riga, niente 500 e niente
  righe caricate due volte al nuovo tentativo;
- 10-16: la fattura si salva con nome ed estensione decisi dal server;
- 10-09: il link della fattura solo a titolare e cassa.
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DataError
from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import Salon
from common.testing import staff_context

from .. import api as inventory_api
from ..api import load_product
from ..models import Product, StockMovement, Supplier
from ..schemas import MovementOut, ProductLoadIn
from ..services import apply_movement
from .base import _InventorySetup


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
        owner = staff_context(salon, is_owner=True)
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
        ctx = staff_context(self.salon, {"inventory"})
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


class LoadCsvMatchingTests(_InventorySetup):
    """09-02 + 15-04: «Carico registrato», ma la merce su un altro articolo."""

    def test_the_picked_product_gets_the_stock_even_with_a_homonym(self):
        davines = self._product("Shampoo idratante", brand="Davines")
        kerastase = self._product("Shampoo idratante", supplier=self.sup_b, brand="Kerastase")
        out = self._load_csv([{"product_id": kerastase.id, "name": "Shampoo idratante", "qty": 12}])
        self.assertEqual(out["loaded"], 1)
        self.assertEqual(out["results"][0]["product_id"], kerastase.id)
        davines.refresh_from_db()
        kerastase.refresh_from_db()
        self.assertEqual((davines.stock_qty, kerastase.stock_qty), (Decimal("0"), Decimal("12")))

    def test_the_product_id_must_belong_to_the_salon(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        foreign = Product.objects.create(
            salon=other, name="Gel", supplier=Supplier.objects.create(salon=other, name="X")
        )
        out = self._load_csv([{"product_id": foreign.id, "name": "Gel", "qty": 3}])
        self.assertEqual((out["loaded"], out["errors"]), (0, 1))
        foreign.refresh_from_db()
        self.assertEqual(foreign.stock_qty, Decimal("0"))

    def test_the_old_deactivated_article_no_longer_steals_the_load(self):
        old = self._product("Shampoo Idratante", active=False)
        new = self._product("Shampoo Idratante", supplier=self.sup_b)
        self._load_csv([{"name": "Shampoo Idratante", "sku": "", "qty": 12}])
        old.refresh_from_db()
        new.refresh_from_db()
        self.assertEqual((old.stock_qty, new.stock_qty), (Decimal("0"), Decimal("12")))

    def test_a_shared_sku_goes_to_the_active_product(self):
        old = self._product("Shampoo nutriente 250", sku="SH-01", active=False)
        new = self._product("Shampoo nutriente 300", sku="SH-01", supplier=self.sup_b)
        self._load_csv([{"name": "", "sku": "SH-01", "qty": 10}])
        old.refresh_from_db()
        new.refresh_from_db()
        self.assertEqual((old.stock_qty, new.stock_qty), (Decimal("0"), Decimal("10")))

    def test_an_ambiguous_match_is_a_row_error_not_a_guess(self):
        a = self._product("Lacca forte", brand="Marca A")
        b = self._product("Lacca forte", supplier=self.sup_b, brand="Marca B")
        out = self._load_csv([{"name": "Lacca forte", "qty": 5}, {"product_id": b.id, "qty": 2}])
        self.assertEqual(out["results"][0]["status"], "error")
        self.assertIn("ambiguo", out["results"][0]["error"])
        self.assertEqual(out["results"][1]["status"], "loaded")
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertEqual((a.stock_qty, b.stock_qty), (Decimal("0"), Decimal("2")))

    def test_a_new_row_matching_only_a_deactivated_product_creates_the_product(self):
        old = self._product("Maschera ristrutturante", active=False)
        out = self._load_csv([{"name": "Maschera ristrutturante", "qty": 4}], supplier_id=self.sup_b.id)
        self.assertEqual((out["created"], out["loaded"]), (1, 1))
        created = Product.objects.get(pk=out["results"][0]["product_id"])
        self.assertNotEqual(created.pk, old.pk)
        self.assertTrue(created.active)
        self.assertEqual(created.stock_qty, Decimal("4"))
        old.refresh_from_db()
        self.assertEqual(old.stock_qty, Decimal("0"))


class LoadCsvRowIsolationTests(_InventorySetup):
    """09-06: un errore del database a metà lasciava caricate le righe prima."""

    def test_a_database_error_stays_on_its_row(self):
        gel = self._product("Gel", sku="G1")
        lima = self._product("Lima", sku="L1")
        real = inventory_api.apply_movement
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise DataError("numeric field overflow")  # quello che fa PostgreSQL
            return real(*args, **kwargs)

        self.client.raise_request_exception = False
        with mock.patch.object(inventory_api, "apply_movement", side_effect=flaky):
            out = self._load_csv([{"sku": "G1", "qty": 5}, {"sku": "L1", "qty": 7}, {"sku": "G1", "qty": 1}])
        self.assertEqual((out["loaded"], out["errors"]), (2, 1))
        self.assertEqual([r["status"] for r in out["results"]], ["loaded", "error", "loaded"])
        gel.refresh_from_db()
        lima.refresh_from_db()
        self.assertEqual((gel.stock_qty, lima.stock_qty), (Decimal("6"), Decimal("0")))

    def test_a_failed_row_does_not_leave_a_half_created_product(self):
        self.client.raise_request_exception = False
        with mock.patch.object(inventory_api, "apply_movement", side_effect=DataError("boom")):
            out = self._load_csv([{"name": "Nuovo siero", "qty": 3}], supplier_id=self.sup_a.id)
        self.assertEqual((out["created"], out["errors"]), (0, 1))
        self.assertFalse(Product.objects.filter(name="Nuovo siero").exists())

    def test_an_ean_read_as_quantity_is_refused_before_writing(self):
        gel = self._product("Gel", sku="G1")
        out = self._load_csv([{"sku": "G1", "qty": 8001234567890}, {"sku": "G1", "qty": 2}])
        self.assertEqual(out["results"][0]["status"], "error")
        self.assertIn("fuori scala", out["results"][0]["error"])
        gel.refresh_from_db()
        self.assertEqual(gel.stock_qty, Decimal("2"))

    def test_a_new_product_name_longer_than_the_column_is_a_row_error(self):
        out = self._load_csv([{"name": "X" * 200, "qty": 1}], supplier_id=self.sup_a.id)
        self.assertEqual((out["created"], out["errors"]), (0, 1))
        self.assertFalse(Product.objects.exists())

    def test_the_single_load_has_the_same_ceiling(self):
        gel = self._product("Gel")
        res = self.client.post(
            f"/api/inventory/products/{gel.id}/load", data={"qty": "8001234567890"}, **self.auth
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(StockMovement.objects.exists())


class InvoiceUploadTests(_InventorySetup):
    """10-16 + 10-09: la fattura del carico."""

    def setUp(self):
        super().setUp()
        self.gel = self._product("Gel")

    def _load(self, upload, auth=None):
        return self.client.post(
            f"/api/inventory/products/{self.gel.id}/load",
            data={"qty": "2", "invoice": upload},
            **(auth or self.auth),
        )

    def test_an_html_file_declared_as_pdf_is_refused(self):
        res = self._load(SimpleUploadedFile("fattura.html", b"<script>", content_type="application/pdf"))
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(StockMovement.objects.exists())

    def test_the_file_is_stored_under_a_name_chosen_by_the_server(self):
        res = self._load(
            SimpleUploadedFile("Fattura Marzo.PDF", b"%PDF-1.4", content_type="application/pdf")
        )
        self.assertEqual(res.status_code, 200, res.content)
        movement = StockMovement.objects.get()
        try:
            stored = movement.invoice.name
            self.assertTrue(stored.startswith("inventory/invoices/"), stored)
            self.assertTrue(stored.endswith(".pdf"), stored)
            self.assertNotIn("Fattura", stored)
        finally:
            movement.invoice.delete(save=False)

    def test_the_invoice_link_reaches_only_owner_and_sales(self):
        movement = apply_movement(
            self.gel,
            StockMovement.Kind.LOAD,
            Decimal("5"),
            invoice=SimpleUploadedFile("fattura.pdf", b"%PDF-1.4", content_type="application/pdf"),
        )
        try:
            def invoice_url(auth):
                res = self.client.get("/api/inventory/movements", **auth)
                self.assertEqual(res.status_code, 200, res.content)
                return res.json()["items"][0]["invoice_url"]

            self.assertIsNone(invoice_url(self.auth))  # solo magazzino
            self.assertIn("?t=", invoice_url(self._member("cassa@parlour.it", ["sales", "inventory"])))
            self.assertIn("?t=", invoice_url(self._member("titolare@parlour.it", owner=True)))
            res = self.client.get(f"/api/inventory/products/{self.gel.id}/movements", **self.auth)
            self.assertIsNone(res.json()["items"][0]["invoice_url"])
        finally:
            movement.invoice.delete(save=False)
