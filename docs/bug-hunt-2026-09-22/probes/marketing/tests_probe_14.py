"""Probe temporaneo del revisore 14 (da cancellare)."""

import json
from decimal import Decimal

from django.test import TestCase

from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram


class StampCardProbe(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="owner@theparlour.it", password="x")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.piega = Service.objects.create(
            salon=self.salon, category=cat, name_it="Piega", duration_min=30, price=Decimal("25.00")
        )
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )

    def _post(self, path, body):
        return self.client.post(path, json.dumps(body), content_type="application/json", **self.auth)

    def test_stamp_card_created_from_dashboard_counts_one_stamp_per_euro(self):
        # Payload identico a LoyaltyEditModal.buildPayload() per «Nuovo programma»:
        # blank() parte da type 'points' + earn_metric 'per_euro'; si clicca
        # «A timbri» (set({type:'stamps'})), «Servizio omaggio», soglia 10.
        payload = {
            "name": "Tessera piega", "type": "stamps", "earn_metric": "per_euro",
            "earn_ratio": "1.00", "reward_type": "free_service", "reward_value": "0.00",
            "reward_service_id": self.piega.id, "threshold": 10, "enrollment": "auto",
            "points_expiry_months": 0, "bonus": {}, "color": "#6366F1", "active": True,
        }
        res = self._post("/api/marketing/loyalty-programs", payload)
        self.assertEqual(res.status_code, 200, res.content)
        # una visita da 45 € (una sola visita = un timbro, secondo la maschera)
        sale = self._post("/api/sales/pos", {
            "client_id": self.client_obj.id,
            "blocks": [{"operator_id": None, "lines": [
                {"line_type": "service", "service_id": self.piega.id, "qty": 1, "unit_price": "45.00"},
            ]}],
            "payments": [{"method": "cash", "amount": "45.00"}],
        })
        self.assertEqual(sale.status_code, 200, sale.content)
        account = LoyaltyAccount.objects.get(program__salon=self.salon, client=self.client_obj)
        rewards = GiftCard.objects.filter(salon=self.salon, paid_method="loyalty").count()
        print("\nPROBE stamps: saldo timbri =", account.points, "· piega omaggio emesse =", rewards)
        # atteso da chi ha creato la tessera: 1 timbro, 0 premi
        self.assertEqual(rewards, 0)
        self.assertEqual(account.points, 1)
