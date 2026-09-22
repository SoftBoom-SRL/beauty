"""PROBE temporaneo (revisore 15): il «Carico merce» della dashboard manda nome/SKU
e non l'id del prodotto scelto; il server risolve il bersaglio con .first()."""

import json
from decimal import Decimal

from django.test import TestCase

from apps.accounts.models import Membership, User
from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Product, Supplier


class RestockTargetProbe(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="t@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.h = {"HTTP_AUTHORIZATION": "Bearer " + create_staff_tokens(owner, self.salon)["access"]}
        self.sup_a = Supplier.objects.create(salon=self.salon, name="Fornitore A")
        self.sup_b = Supplier.objects.create(salon=self.salon, name="Fornitore B")

    def _post(self, body):
        return self.client.post(
            "/api/inventory/load-csv", data=json.dumps(body), content_type="application/json", **self.h
        )

    def test_same_name_old_inactive_product_gets_the_stock(self):
        # vecchio articolo disattivato e nuovo articolo attivo con lo stesso nome (senza SKU)
        old = Product.objects.create(salon=self.salon, name="Shampoo Idratante", supplier=self.sup_a, active=False)
        new = Product.objects.create(salon=self.salon, name="Shampoo Idratante", supplier=self.sup_b)
        # RestockModal: prodotto scelto dall'elenco (attivo, senza sku) → {name, sku: ''}
        r = self._post({"rows": [{"name": "Shampoo Idratante", "sku": "", "qty": 12}], "supplier_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        old.refresh_from_db(); new.refresh_from_db()
        print("\n[probe] load-csv same name -> old(inactive)", old.stock_qty, "new(active)", new.stock_qty,
              "result product_id", r.json()["results"][0]["product_id"], "old.id", old.id, "new.id", new.id)
        # l'utente ha scelto `new`: il carico dovrebbe finire lì
        self.assertEqual(new.stock_qty, Decimal("12"))

    def test_same_sku_two_suppliers(self):
        a = Product.objects.create(salon=self.salon, name="Gel rosso", sku="GEL-RD-001", supplier=self.sup_a)
        b = Product.objects.create(salon=self.salon, name="Gel rosso (B)", sku="GEL-RD-001", supplier=self.sup_b)
        # prodotto scelto: b → RestockModal manda {name: '', sku: 'GEL-RD-001'}
        r = self._post({"rows": [{"name": "", "sku": "GEL-RD-001", "qty": 5}], "supplier_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db(); b.refresh_from_db()
        print("\n[probe] load-csv same sku -> a", a.stock_qty, "b", b.stock_qty)
        self.assertEqual(b.stock_qty, Decimal("5"))
