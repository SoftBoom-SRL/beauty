"""Basi comuni ai test del catalogo.

Le view sono chiamate per lo più direttamente (bypassando l'HTTP layer): usano
solo `request.auth`, quindi basta un `SimpleNamespace` con un `StaffContext`
costruito a mano (`fake_request`, `CatalogTestCase`). `_CatalogSetup` serve ai
test che passano dall'HTTP vero: un servizio «Colore» con la posa e un
titolare col suo token.
"""

from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase

from apps.accounts.models import Membership, User
from apps.core.models import Salon
from common.testing import bearer, staff_context

from ..models import Service, ServiceCategory


def fake_request(auth=None):
    """Richiesta finta: `META` serve al rate limit degli endpoint pubblici."""
    return SimpleNamespace(auth=auth, META={"REMOTE_ADDR": "203.0.113.7"}, GET={})


class CatalogTestCase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ctx = staff_context(self.salon, {"pricing"})
        self.request = fake_request(ctx)


class _CatalogSetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.cat = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.color = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Colore", duration_min=60,
            soak_min=40, price=Decimal("60"),
        )
        owner = User.objects.create_user(email="titolare@parlour.it", password="x-Segreta-1")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = bearer(owner, self.salon)
