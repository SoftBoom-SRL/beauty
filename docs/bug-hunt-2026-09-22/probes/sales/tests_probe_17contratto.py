"""PROBE temporaneo del revisore 17 (contratto frontend/backend). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.clients.models import Client
from apps.core.models import Salon
from apps.inventory.models import Product, Supplier
from common.auth import create_staff_tokens


class Probe17Rounding(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="p17s@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales", "agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        sup = Supplier.objects.create(salon=self.salon, name="Davines")
        self.p1 = Product.objects.create(salon=self.salon, name="Shampoo", supplier=sup, stock_qty=Decimal("20"), sale_price=Decimal("19.99"))
        self.p2 = Product.objects.create(salon=self.salon, name="Balsamo", supplier=sup, stock_qty=Decimal("20"), sale_price=Decimal("17.99"))

    def test_pos_global_discount_two_lines(self):
        # CartTab.asApiLine con sconto globale 50% e resolvePayments(total) calcolato come lib.js
        body = {
            "client_id": None,
            "blocks": [{"operator_id": None, "lines": [
                {"line_type": "product", "product_id": self.p1.id, "qty": 1, "unit_price": "19.99", "discount_pct": 50, "is_gift": False},
                {"line_type": "product", "product_id": self.p2.id, "qty": 1, "unit_price": "17.99", "discount_pct": 50, "is_gift": False},
            ]}],
            "payments": [{"method": "cash", "amount": "18.98"}],  # round2(9.99 + 8.99) del frontend
        }
        res = self.client.post("/api/sales/pos", data=json.dumps(body), content_type="application/json", **self.auth)
        print("\n[probe17] POS 2 righe −50% (FE dovuto 18.98):", res.status_code, res.content[:120])
        body["payments"][0]["amount"] = "19.00"
        res2 = self.client.post("/api/sales/pos", data=json.dumps(body), content_type="application/json", **self.auth)
        print("[probe17] stesso conto pagato 19.00 (totale del server):", res2.status_code)
        self.assertEqual(res.status_code, 422)

    def test_checkout_deposit_above_discounted_total(self):
        """SellModal blocca `due < 0`; il server invece detrae fino al totale e segna l'eccedenza."""
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        client = Client.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        svc = Service.objects.create(salon=self.salon, category=cat, name_it="Piega", duration_min=60, price=Decimal("50.00"))
        op = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="B")
        appt = Appointment.objects.create(
            salon=self.salon, client=client, operator=op,
            start=timezone.now() + dt.timedelta(hours=1),
            deposit_status="paid", deposit_amount=Decimal("30.00"),
        )
        AppointmentService.objects.create(appointment=appt, service=svc, operator=op, duration_min=60, price=Decimal("50.00"))
        # riga col 50% di sconto (25 €) + caparra 30 € → il frontend calcola due = -5 e spegne «Incassa»
        body = {
            "blocks": [{"operator_id": op.id, "lines": [
                {"line_type": "service", "service_id": svc.id, "qty": 1, "unit_price": "50.00", "discount_pct": 50, "is_gift": False},
            ]}],
            "payments": [{"method": "cash", "amount": "0.00"}],
        }
        res = self.client.post(f"/api/sales/checkout/{appt.id}", data=json.dumps(body), content_type="application/json", **self.auth)
        print("\n[probe17] checkout con caparra > totale scontato:", res.status_code, res.content[:160])
        self.assertEqual(res.status_code, 200)
