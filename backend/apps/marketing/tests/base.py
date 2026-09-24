"""Basi e aiuti condivisi dai moduli di test del marketing.

Qui non vanno test: il runner raccoglie solo i file `test*.py`, e una classe
con dei test importata in un altro modulo verrebbe eseguita due volte.
"""

import json

from django.test import TestCase

from apps.core.models import Salon
from common.auth import create_staff_tokens


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
    from apps.clients.models import Client

    return Client.objects.create(
        salon=salon, first_name=first_name, last_name="Ricci", phone=phone,
        consents={"privacy": True, "marketing": True, "card_charge": False},
    )


class GiftCardTestBase(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = self._auth(owner)
        self.sofia = _client(self.salon)

    def _auth(self, user):
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _staff(self, email, scopes):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email=email, password="segretissima")
        role = Role.objects.create(salon=self.salon, name=email, scopes=scopes)
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return self._auth(user)

    def _post(self, url, body, auth=None):
        return self.client.post(
            url, data=json.dumps(body), content_type="application/json", **(auth or self.auth)
        )

    def _get(self, url, params=None, auth=None):
        res = self.client.get(url, params or {}, **(auth or self.auth))
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()
