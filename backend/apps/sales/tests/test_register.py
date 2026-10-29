"""Cassa del giorno e scontrino: ogni incasso registrato, con o senza scontrino fiscale.

Il salone usa il gestionale come registro di tutti gli incassi: la vendita dice
se lo scontrino è stato battuto (`Sale.receipt_issued`), la cassa del giorno
elenca i pagamenti arrivati quel giorno e li divide per metodo e per scontrino.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone

from common.testing import post_json

from ..models import Payment, Sale
from .base import PATCH_LOYALTY, HistoryTestBase


@patch(PATCH_LOYALTY)
class RegisterTests(HistoryTestBase):
    def _bill(self, payments, **extra):
        appointment = self._appointment()
        return self.client.post(
            f"/api/sales/checkout/{appointment.id}",
            data=json.dumps({
                "blocks": [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
                "payments": payments,
                **extra,
            }),
            content_type="application/json", **self.auth,
        )

    def _register(self, day=""):
        res = self.client.get(f"/api/sales/register?date={day}", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_a_sale_has_a_receipt_unless_told_otherwise(self, _loyalty):
        res = self._bill([{"method": "card", "amount": "100.00"}])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["sale"]["receipt_issued"])

        res = self._bill([{"method": "cash", "amount": "100.00"}], receipt_issued=False)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["sale"]["receipt_issued"])
        self.assertFalse(Sale.objects.get(pk=res.json()["sale"]["id"]).receipt_issued)

    def test_a_counter_sale_without_receipt(self, _loyalty):
        res = post_json(self.client, "/api/sales/pos", {
            "blocks": [{"operator_id": None, "lines": [self._line(self.piega, "30.00")]}],
            "payments": [{"method": "cash", "amount": "30.00"}],
            "receipt_issued": False,
        }, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["receipt_issued"])

    def test_the_day_register_splits_methods_and_receipts(self, _loyalty):
        self._bill([{"method": "card", "amount": "100.00"}])
        self._bill([{"method": "cash", "amount": "60.00"}, {"method": "card", "amount": "40.00"}], receipt_issued=False)
        reg = self._register()
        self.assertEqual(len(reg["payments"]), 3)
        self.assertEqual(Decimal(reg["by_method"]["card"]), Decimal("140.00"))
        self.assertEqual(Decimal(reg["by_method"]["cash"]), Decimal("60.00"))
        self.assertEqual(Decimal(reg["receipt"]), Decimal("100.00"))
        self.assertEqual(Decimal(reg["no_receipt"]), Decimal("100.00"))
        self.assertEqual(Decimal(reg["cash_in"]), Decimal("200.00"))
        self.assertEqual(reg["payments"][0]["client_name"], "Sofia Ricci")

    def test_a_settlement_counts_on_the_day_it_arrives(self, _loyalty):
        res = self._bill([{"method": "cash", "amount": "40.00"}], leave_due=True)
        sale_id = res.json()["sale"]["id"]
        yesterday = timezone.now() - dt.timedelta(days=1)
        Sale.objects.filter(pk=sale_id).update(created_at=yesterday)
        Payment.objects.filter(sale_id=sale_id).update(created_at=yesterday)
        post_json(self.client, f"/api/sales/{sale_id}/settle",
                  {"payments": [{"method": "card", "amount": "60.00"}]}, **self.auth)

        reg = self._register()
        self.assertEqual([p["amount"] for p in reg["payments"]], ["60.00"])
        self.assertTrue(reg["payments"][0]["is_settlement"])
        self.assertEqual(Decimal(reg["cash_in"]), Decimal("60.00"))
        past = self._register(timezone.localdate(yesterday).isoformat())
        self.assertEqual(Decimal(past["by_method"]["cash"]), Decimal("40.00"))
        self.assertEqual(Decimal(past["due_left"]), Decimal("60.00"))

    def test_the_history_filters_by_receipt(self, _loyalty):
        self._bill([{"method": "card", "amount": "100.00"}])
        self._bill([{"method": "cash", "amount": "100.00"}], receipt_issued=False)
        res = self.client.get("/api/sales/?receipt=false", **self.auth)
        self.assertEqual(res.json()["count"], 1)
        self.assertFalse(res.json()["items"][0]["receipt_issued"])
        self.assertEqual(self.client.get("/api/sales/?receipt=true", **self.auth).json()["count"], 1)
        self.assertEqual(self.client.get("/api/sales/", **self.auth).json()["count"], 2)

    def test_the_register_asks_for_the_sales_permission(self, _loyalty):
        from apps.accounts.models import Membership

        Membership.objects.filter(salon=self.salon).update(role=None)
        self.assertEqual(self.client.get("/api/sales/register", **self.auth).status_code, 403)

    def test_a_bad_date_is_a_400(self, _loyalty):
        self.assertEqual(self.client.get("/api/sales/register?date=2026-02-30", **self.auth).status_code, 400)
