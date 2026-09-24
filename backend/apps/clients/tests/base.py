"""Basi e aiuti condivisi dai moduli di test dei clienti.

Le view sono chiamate direttamente (bypassando l'HTTP layer): usano solo
`request.auth`, quindi basta un `SimpleNamespace` con uno `StaffContext`
costruito a mano (`staff_context` di common.testing) — evita di dipendere
dal login reale di apps.accounts.
Dove conta la risposta HTTP, `_staff_http` dà l'header di un membro vero.
"""

from types import SimpleNamespace

from django.test import TestCase

from apps.core.models import Salon
from common.testing import bearer, staff_context

from ..models import Client


class ClientsTestCase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(auth=staff_context(self.salon, {"clients"}))

    def make_client(self, **kwargs):
        defaults = dict(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+391110000000")
        defaults.update(kwargs)
        return Client.objects.create(**defaults)


def _staff_http(salon, scopes):
    """Un membro staff vero, con un ruolo suo: ridà (utente, header)."""
    from apps.accounts.models import Membership, Role, User

    user = User.objects.create_user(email=f"staff{salon.id}@theparlour.it", password="x" * 10)
    role = Role.objects.create(salon=salon, name="Ruolo test", scopes=scopes)
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=False)
    return user, bearer(user, salon)
