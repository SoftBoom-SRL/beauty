"""La «Exclusive Card» (Beauty Boutique 11/2026): iscrizione annuale a pagamento,
rinnovo anticipato che allunga dalla scadenza, elenco per scadenza, lettura da n8n."""

import datetime as dt
import json
from decimal import Decimal

from django.utils import timezone

from apps.core.models import SalonSettings
from apps.integrations import automation_key
from apps.sales.models import Payment, Sale, SaleLine

from ..exclusive import add_year
from ..models import ExclusiveMembership
from .base import GiftCardTestBase, _make_client

CONF = {"enabled": True, "price": "30", "renewal_price": "25", "product_discount_pct": 10}


class ExclusiveCardTests(GiftCardTestBase):
    def setUp(self):
        super().setUp()
        self._configure(CONF)

    def _configure(self, conf):
        res = self.client.put(
            "/api/core/settings", json.dumps({"exclusive_card": conf}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["exclusive_card"]

    def _subscribe(self, client=None, method="cash", auth=None):
        return self._post(
            f"/api/marketing/exclusive-cards/client/{(client or self.sofia).id}/subscribe",
            {"method": method}, auth=auth,
        )

    def test_settings_are_saved_and_validated(self):
        saved = SalonSettings.objects.get(salon=self.salon).exclusive_card
        self.assertEqual(saved, {"enabled": True, "price": "30.00", "renewal_price": "25.00",
                                 "product_discount_pct": 10})
        res = self.client.put(
            "/api/core/settings", json.dumps({"exclusive_card": {**CONF, "product_discount_pct": 120}}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 400)

    def test_subscribing_lasts_a_year_and_cashes_the_price(self):
        today = timezone.localdate()
        res = self._subscribe(method="card")
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["expires_on"], add_year(today).isoformat())
        self.assertTrue(body["active"])
        sale = Sale.objects.get()
        self.assertEqual(sale.total, Decimal("30.00"))
        self.assertEqual(sale.client_id, self.sofia.id)
        self.assertEqual(sale.lines.get().line_type, SaleLine.LineType.MEMBERSHIP)
        self.assertEqual(Payment.objects.get().method, "card")
        self.assertEqual(Decimal(self._get("/api/sales/register")["cash_in"]), Decimal("30.00"))

    def test_early_renewal_costs_less_and_extends_from_the_expiry(self):
        today = timezone.localdate()
        expiry = today + dt.timedelta(days=20)
        ExclusiveMembership.objects.create(salon=self.salon, client=self.sofia, started_on=today, expires_on=expiry)
        quote = self._get(f"/api/marketing/exclusive-cards/client/{self.sofia.id}")
        self.assertTrue(quote["renewal"])
        self.assertEqual(Decimal(quote["amount"]), Decimal("25.00"))
        res = self._subscribe()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["expires_on"], add_year(expiry).isoformat())
        self.assertEqual(res.json()["renewals"], 1)
        self.assertEqual(Sale.objects.get().total, Decimal("25.00"))

    def test_after_the_expiry_it_is_a_new_subscription_at_full_price(self):
        today = timezone.localdate()
        old = today - dt.timedelta(days=3)
        ExclusiveMembership.objects.create(salon=self.salon, client=self.sofia, started_on=old, expires_on=old)
        res = self._subscribe()
        self.assertEqual(res.json()["expires_on"], add_year(today).isoformat())
        self.assertEqual(res.json()["started_on"], today.isoformat())
        self.assertEqual(Sale.objects.get().total, Decimal("30.00"))

    def test_disabled_card_and_gift_card_payment_are_refused(self):
        self.assertEqual(self._subscribe(method="gift_card").status_code, 422)
        self._configure({**CONF, "enabled": False})
        self.assertEqual(self._subscribe().status_code, 422)
        self.assertFalse(Sale.objects.exists())

    def test_subscribing_asks_for_the_sales_permission(self):
        auth = self._staff("mkt@parlour.it", ["marketing"])
        self.assertEqual(self._subscribe(auth=auth).status_code, 403)

    def test_the_list_filters_the_expiring_ones(self):
        today = timezone.localdate()
        giulia = _make_client(self.salon, "Giulia", "+393334445566")
        marta = _make_client(self.salon, "Marta", "+393337778899")
        ExclusiveMembership.objects.create(salon=self.salon, client=self.sofia, started_on=today,
                                           expires_on=today + dt.timedelta(days=10))
        ExclusiveMembership.objects.create(salon=self.salon, client=giulia, started_on=today,
                                           expires_on=today + dt.timedelta(days=200))
        ExclusiveMembership.objects.create(salon=self.salon, client=marta, started_on=today,
                                           expires_on=today - dt.timedelta(days=1))
        names = lambda **p: [r["client_name"] for r in self._get("/api/marketing/exclusive-cards", p)]  # noqa: E731
        self.assertEqual(names(status="expiring"), ["Sofia Ricci"])
        self.assertEqual(names(status="active"), ["Sofia Ricci", "Giulia Ricci"])
        self.assertEqual(names(status="expired"), ["Marta Ricci"])
        self.assertEqual(len(names()), 3)

    def test_n8n_reads_the_expiry_with_the_automation_key(self):
        today = timezone.localdate()
        ExclusiveMembership.objects.create(salon=self.salon, client=self.sofia, started_on=today,
                                           expires_on=today + dt.timedelta(days=5))
        key = automation_key.rotate_key(self.salon, None)
        res = self.client.get(
            "/api/integrations/automation/exclusive-cards", {"status": "expiring", "days": 7},
            HTTP_AUTHORIZATION=f"Bearer {key}",
        )
        self.assertEqual(res.status_code, 200, res.content)
        [row] = res.json()
        self.assertEqual(row["client_id"], self.sofia.id)
        self.assertEqual(row["expires_on"], (today + dt.timedelta(days=5)).isoformat())
        self.assertEqual(row["days_left"], 5)
        self.assertEqual(self.client.get("/api/integrations/automation/exclusive-cards").status_code, 401)


class AddYearTests(GiftCardTestBase):
    def test_leap_day_becomes_the_28th(self):
        self.assertEqual(add_year(dt.date(2028, 2, 29)), dt.date(2029, 2, 28))
        self.assertEqual(add_year(dt.date(2026, 11, 16)), dt.date(2027, 11, 16))
