"""Probe temporaneo del revisore 14 (da cancellare)."""

import json
from decimal import Decimal

from django.test import TestCase

from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Payment, Sale


class CartRoundingProbe(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User
        from apps.inventory.models import Product, Supplier

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="owner@theparlour.it", password="x")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        sup = Supplier.objects.create(salon=self.salon, name="Fornitore")
        self.p1 = Product.objects.create(salon=self.salon, name="Maschera", supplier=sup, sale_price=Decimal("18.90"))
        self.p2 = Product.objects.create(salon=self.salon, name="Shampoo", supplier=sup, sale_price=Decimal("9.50"))
        Product.objects.filter(salon=self.salon).update(stock_qty=Decimal("10"))

    def _pos(self, lines, amount):
        body = {
            "client_id": None,
            "blocks": [{"operator_id": None, "lines": lines}],
            "payments": [{"method": "cash", "amount": amount}],
        }
        return self.client.post("/api/sales/pos", json.dumps(body), content_type="application/json", **self.auth)

    def _line(self, p):
        # CartTab.asApiLine con lo sconto vendita 15% (effDisc)
        return {"line_type": "product", "product_id": p.id, "qty": 1,
                "unit_price": f"{p.sale_price:.2f}", "discount_pct": 15, "is_gift": False}

    def test_two_discounted_products_total_shown_by_cart_is_refused(self):
        # Totale calcolato da CartTab (round2 in virgola mobile): 16.06 + 8.07 = 24.13
        res = self._pos([self._line(self.p1), self._line(self.p2)], "24.13")
        print("\nPROBE due righe -15%:", res.status_code, res.content[:120])
        self.assertEqual(res.status_code, 200)

    def test_one_discounted_product_records_a_payment_different_from_the_total(self):
        res = self._pos([self._line(self.p1)], "16.06")
        self.assertEqual(res.status_code, 200, res.content)
        sale = Sale.objects.get()
        paid = sum(p.amount for p in Payment.objects.filter(sale=sale))
        print("\nPROBE una riga -15%: totale vendita", sale.total, "· incassato", paid)
        self.assertEqual(sale.total, paid)


class DepositDoubleCountProbe(TestCase):
    """Caparra incassata (vendita-caparra) + check-out: KPI di scheda e storico."""

    def setUp(self):
        from django.utils import timezone

        from apps.accounts.models import Membership, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="owner@theparlour.it", password="x")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.cl = Client.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222")
        op = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        svc = Service.objects.create(salon=self.salon, category=cat, name_it="Colore", duration_min=60, price=Decimal("100.00"))
        self.appt = Appointment.objects.create(salon=self.salon, client=self.cl, operator=op,
                                               start=timezone.now() + timezone.timedelta(days=1))
        AppointmentService.objects.create(appointment=self.appt, service=svc, operator=op, duration_min=60, price=Decimal("100.00"))
        self.appt.deposit_amount = Decimal("30.00")
        self.appt.deposit_status = "paid"
        self.appt.save()
        from apps.sales.services import record_deposit_cashed
        record_deposit_cashed(self.salon, self.appt, method="cash")
        body = {"blocks": [{"operator_id": op.id, "lines": [
            {"line_type": "service", "service_id": svc.id, "qty": 1, "unit_price": "100.00"}]}],
            "payments": [{"method": "cash", "amount": "70.00"}]}
        res = self.client.post(f"/api/sales/checkout/{self.appt.id}", json.dumps(body),
                               content_type="application/json", **self.auth)
        assert res.status_code == 200, res.content

    def test_client_kpis_and_history_revenue(self):
        c = self.client.get(f"/api/clients/{self.cl.id}", **self.auth).json()
        h = self.client.get(f"/api/sales/?client_id={self.cl.id}", **self.auth).json()
        print("\nPROBE scheda: visite", c["visits"], "· speso", c["total_spent"],
              "· storico vendite: incasso", h["kpi"]["revenue"], "n.", h["kpi"]["count"])
        self.assertEqual(c["visits"], 1)
        self.assertEqual(Decimal(str(c["total_spent"])), Decimal("100.00"))
        self.assertEqual(Decimal(str(h["kpi"]["revenue"])), Decimal("100.00"))
