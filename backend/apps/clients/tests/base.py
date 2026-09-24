"""Basi e aiuti condivisi dai moduli di test dei clienti.

Le view sono chiamate direttamente (bypassando l'HTTP layer): usano solo
`request.auth`, quindi basta un `SimpleNamespace` con uno `StaffContext`
costruito a mano — evita di dipendere dal login reale di apps.accounts.
Dove conta la risposta HTTP, `_staff_http` dà l'header di un membro vero.
"""

from types import SimpleNamespace

from django.test import TestCase

from apps.core.models import Salon
from common.auth import StaffContext, create_staff_tokens

from ..models import Client


class ClientsTestCase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"clients"}, is_owner=False
        )
        self.request = SimpleNamespace(auth=ctx)

    def make_client(self, **kwargs):
        defaults = dict(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+391110000000")
        defaults.update(kwargs)
        return Client.objects.create(**defaults)


def _staff_http(salon, scopes):
    from apps.accounts.models import Membership, Role, User

    user = User.objects.create_user(email=f"staff{salon.id}@theparlour.it", password="x" * 10)
    role = Role.objects.create(salon=salon, name="Ruolo test", scopes=scopes)
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=False)
    tokens = create_staff_tokens(user, salon)
    return user, {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}
