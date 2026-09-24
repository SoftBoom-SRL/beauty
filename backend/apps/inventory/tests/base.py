"""Basi comuni ai test del magazzino.

`_InventorySetup`: un salone con due fornitori e un membro col solo permesso
«inventory», per i test che passano dall'HTTP vero (giacenze, prodotti,
carichi e fatture).
"""

import json

from django.test import TestCase

from apps.accounts.models import Membership, Role, User
from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..models import Product, Supplier


class _InventorySetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sup_a = Supplier.objects.create(salon=self.salon, name="Davines")
        self.sup_b = Supplier.objects.create(salon=self.salon, name="Kerastase")
        self.auth = self._member("magazzino@parlour.it", ["inventory"])

    def _member(self, email, scopes=None, owner=False):
        user = User.objects.create_user(email=email, password="x-Segreta-1")
        role = Role.objects.create(salon=self.salon, name=email, scopes=scopes) if scopes else None
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=owner)
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _load_csv(self, rows, supplier_id=None, auth=None):
        res = self.client.post(
            "/api/inventory/load-csv",
            data=json.dumps({"rows": rows, "supplier_id": supplier_id}),
            content_type="application/json",
            **(auth or self.auth),
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def _product(self, name, supplier=None, **extra):
        return Product.objects.create(salon=self.salon, name=name, supplier=supplier or self.sup_a, **extra)
