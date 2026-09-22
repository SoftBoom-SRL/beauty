"""PROBE TEMPORANEO revisore 09 — da cancellare."""

from decimal import Decimal

from django.test import TestCase

from apps.accounts.models import Membership, Role, User
from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Product, Supplier


class ProbeLoadCsv(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sup_a = Supplier.objects.create(salon=self.salon, name="Vecchio fornitore")
        self.sup_b = Supplier.objects.create(salon=self.salon, name="Nuovo fornitore")
        user = User.objects.create_user(email="magazzino@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Magazzino", scopes=["inventory"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _restock(self, picked, qty=10):
        # Stesso corpo che costruisce RestockModal.apply per un prodotto scelto dal picker
        row = {"name": "" if picked.sku else picked.name, "sku": picked.sku, "qty": qty}
        return self.client.post(
            "/api/inventory/load-csv",
            data={"rows": [row], "supplier_id": None},
            content_type="application/json",
            **self.auth,
        )

    def test_homonym_brands_without_sku(self):
        lacca_a = Product.objects.create(salon=self.salon, name="Lacca forte", brand="Marca A", supplier=self.sup_a)
        lacca_b = Product.objects.create(salon=self.salon, name="Lacca forte", brand="Marca B", supplier=self.sup_b)
        res = self._restock(lacca_b)
        self.assertEqual(res.status_code, 200, res.content)
        lacca_a.refresh_from_db()
        lacca_b.refresh_from_db()
        print("\n[probe] omonimi: A", lacca_a.stock_qty, "B (scelto)", lacca_b.stock_qty, res.json())
        self.assertEqual(lacca_b.stock_qty, Decimal("0"))  # quello scelto non riceve niente

    def test_inactive_old_product_same_sku(self):
        old = Product.objects.create(salon=self.salon, name="Shampoo nutriente 250", sku="SH-01",
                                     supplier=self.sup_a, active=False)
        new = Product.objects.create(salon=self.salon, name="Shampoo nutriente 300", sku="SH-01",
                                     supplier=self.sup_b)
        res = self._restock(new)
        self.assertEqual(res.status_code, 200, res.content)
        old.refresh_from_db()
        new.refresh_from_db()
        print("\n[probe] sku condiviso: vecchio (disattivo)", old.stock_qty, "nuovo (scelto)", new.stock_qty, res.json())
        self.assertEqual(new.stock_qty, Decimal("0"))
        self.assertEqual(old.stock_qty, Decimal("10"))


class ProbeLoadCsvPartial(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sup = Supplier.objects.create(salon=self.salon, name="Davines")
        user = User.objects.create_user(email="magazzino@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Magazzino", scopes=["inventory"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def test_db_error_on_second_row_keeps_first(self):
        from unittest import mock

        from django.db import DataError

        from . import api as inv_api

        a = Product.objects.create(salon=self.salon, name="Gel", sku="G1", supplier=self.sup)
        b = Product.objects.create(salon=self.salon, name="Lima", sku="L1", supplier=self.sup)
        real = inv_api.apply_movement
        calls = {"n": 0}

        def flaky(*args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 2:
                raise DataError("numeric field overflow")  # quello che fa PostgreSQL su numeric(10,2)
            return real(*args, **kwargs)

        self.client.raise_request_exception = False
        with mock.patch.object(inv_api, "apply_movement", side_effect=flaky):
            res = self.client.post(
                "/api/inventory/load-csv",
                data={"rows": [{"sku": "G1", "qty": 5}, {"sku": "L1", "qty": 100000000}]},
                content_type="application/json",
                **self.auth,
            )
        a.refresh_from_db()
        b.refresh_from_db()
        print("\n[probe] csv parziale:", res.status_code, "Gel", a.stock_qty, "Lima", b.stock_qty)
        self.assertEqual(res.status_code, 500)
        self.assertEqual(a.stock_qty, Decimal("5"))
