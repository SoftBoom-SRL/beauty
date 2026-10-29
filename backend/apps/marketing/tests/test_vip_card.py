"""La «carta VIP» (Beauty Boutique 10/2026): una carta a importo della cliente
che si ricarica in cassa e si spende ai conti, più il credito portato dal
gestionale di prima senza contarlo come incasso di oggi."""

from decimal import Decimal

from apps.catalog.models import Service, ServiceCategory
from apps.sales.models import Payment, Sale

from ..gift_cards import redeem_gift_card
from ..models import GiftCard
from .base import GiftCardTestBase


class VipCardTests(GiftCardTestBase):
    def _sell(self, **extra):
        body = {"kind": "prepaid", "value": "100.00", "recipient_client_id": self.sofia.id,
                "paid": True, "paid_method": "cash", **extra}
        res = self._post("/api/marketing/gift-cards", body)
        self.assertEqual(res.status_code, 200, res.content)
        return GiftCard.objects.get(pk=res.json()["id"])

    def _top_up(self, card, amount="50.00", method="card", auth=None, **extra):
        return self._post(f"/api/marketing/gift-cards/{card.id}/top-up",
                          {"amount": amount, "method": method, **extra}, auth=auth)

    def _cash_in(self):
        return Decimal(self._get("/api/sales/register")["cash_in"])

    def test_an_imported_balance_is_spendable_but_not_cashed_today(self):
        card = self._sell(value="80.00", imported=True, paid=False, paid_method="")
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.PAID)
        self.assertEqual(card.paid_method, "import")
        self.assertFalse(Sale.objects.exists())
        self.assertEqual(self._cash_in(), Decimal("0"))
        kpi = self._get("/api/marketing/gift-cards")["kpi"]
        self.assertEqual(Decimal(kpi["sold_total"]), Decimal("0"))
        self.assertEqual(Decimal(kpi["outstanding"]), Decimal("80.00"))
        redeem_gift_card(self.salon, card.code, Decimal("30"))
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("50.00"))

    def test_importing_asks_for_the_sales_permission(self):
        auth = self._staff("mkt@parlour.it", ["marketing"])
        res = self._post("/api/marketing/gift-cards", {"kind": "prepaid", "value": "80.00",
                         "recipient_client_id": self.sofia.id, "imported": True}, auth=auth)
        self.assertEqual(res.status_code, 403)

    def test_a_top_up_raises_the_balance_and_goes_in_the_register(self):
        card = self._sell()
        res = self._top_up(card, "50.00", "card")
        self.assertEqual(res.status_code, 200, res.content)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("150.00"))
        self.assertEqual(card.initial_value, Decimal("150.00"))
        top_up = Payment.objects.filter(method="card").get()
        self.assertEqual(top_up.amount, Decimal("50.00"))
        self.assertEqual(top_up.sale.client_id, self.sofia.id)
        self.assertEqual(self._cash_in(), Decimal("150.00"))  # 100 venduta + 50 ricarica

    def test_a_spent_card_comes_back_with_a_top_up(self):
        card = self._sell(value="40.00")
        redeem_gift_card(self.salon, card.code, Decimal("40"))
        card.refresh_from_db()
        self.assertEqual(card.status, GiftCard.Status.REDEEMED)
        self.assertEqual(self._top_up(card, "60.00", "cash").status_code, 200)
        card.refresh_from_db()
        self.assertEqual(card.status, GiftCard.Status.ACTIVE)
        redeem_gift_card(self.salon, card.code, Decimal("60"))

    def test_a_top_up_without_receipt(self):
        card = self._sell()
        self.assertEqual(self._top_up(card, receipt_issued=False).status_code, 200)
        self.assertFalse(Payment.objects.get(method="card").sale.receipt_issued)

    def test_what_cannot_be_topped_up(self):
        card = self._sell()
        self.assertEqual(self._top_up(card, "0").status_code, 422)
        self.assertEqual(self._top_up(card, "10", "bonifico").status_code, 422)
        self.assertEqual(self._top_up(card, "10", "").status_code, 422)
        unpaid = self._sell(paid=False, paid_method="")
        self.assertEqual(self._top_up(unpaid).status_code, 422)
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        svc = Service.objects.create(salon=self.salon, category=category, name_it="Piega",
                                     price=Decimal("25"), duration_min=30)
        treatment = self._sell(gift_service_id=svc.id)
        self.assertEqual(self._top_up(treatment).status_code, 422)
        auth = self._staff("mkt@parlour.it", ["marketing"])
        self.assertEqual(self._top_up(card, auth=auth).status_code, 403)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("100.00"))
