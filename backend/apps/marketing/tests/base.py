"""Basi e aiuti condivisi dai moduli di test del marketing.

Qui non vanno test: il runner raccoglie solo i file `test*.py`, e una classe
con dei test importata in un altro modulo verrebbe eseguita due volte.
"""

from django.test import TestCase

from apps.core.models import Salon
from common.testing import bearer, post_json


def _make_client(salon, first_name="Sofia", phone="+393331112233", marketing=True):
    from apps.clients.models import Client  # lazy: app di un altro agente

    return Client.objects.create(
        salon=salon,
        first_name=first_name,
        last_name="Ricci",
        phone=phone,
        consents={"privacy": True, "marketing": marketing, "card_charge": False},
    )


def _client(salon, first_name="Sofia", phone="+393331112233"):
    """La cliente dei test della caccia del 22/09: sempre col consenso marketing."""
    return _make_client(salon, first_name=first_name, phone=phone)


class StaffRequestsMixin:
    """Richieste dello staff di `self.salon`: header, membri con i loro permessi, POST JSON.

    `_post` usa `self.auth` quando non se ne passa un altro.
    """

    def _auth(self, user):
        return bearer(user, self.salon)

    def _staff(self, email, scopes):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email=email, password="segretissima")
        role = Role.objects.create(salon=self.salon, name=email, scopes=scopes)
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return self._auth(user)

    def _post(self, url, body, auth=None):
        return post_json(self.client, url, body, **(auth or self.auth))


class OwnerTestBase(TestCase):
    """Salone con la titolare autenticata in `self.auth`."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = bearer(user, self.salon)


class GiftCardTestBase(StaffRequestsMixin, TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = self._auth(owner)
        self.sofia = _client(self.salon)

    def _get(self, url, params=None, auth=None):
        res = self.client.get(url, params or {}, **(auth or self.auth))
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()
