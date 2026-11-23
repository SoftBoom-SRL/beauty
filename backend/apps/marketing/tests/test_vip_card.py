"""La «carta VIP» (Beauty Boutique 10/2026): una carta a importo della cliente
che si ricarica in cassa e si spende ai conti, più il credito portato dal
gestionale di prima senza contarlo come incasso di oggi."""

import json
from decimal import Decimal

from apps.catalog.models import Service, ServiceCategory
from apps.core.models import SalonSettings
from apps.sales.models import Payment, Sale

from ..gift_cards import redeem_gift_card
from ..models import GiftCard
from .base import GiftCardTestBase, _client


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


class VipBonusTests(GiftCardTestBase):
    """Beauty Boutique 11/2026: «paga 500 € e riceve 600 € di credito». In cassa
    entra solo il pagato; il credito comprende il bonus, che resta nello
    storico della carta."""

    _sell = VipCardTests._sell
    _top_up = VipCardTests._top_up
    _cash_in = VipCardTests._cash_in

    def setUp(self):
        super().setUp()
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"gift_card_bonus_rules": [
            {"min_amount": "200.00", "bonus": "30.00"},
            {"min_amount": "500.00", "bonus": "100.00"},
        ]})

    def test_a_top_up_over_the_threshold_gets_the_bonus_but_not_in_the_register(self):
        card = self._sell(value="20.00")
        self.assertEqual(self._top_up(card, "500.00", "card").status_code, 200)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("620.00"))
        self.assertEqual(Payment.objects.get(method="card").amount, Decimal("500.00"))
        self.assertEqual(self._cash_in(), Decimal("520.00"))
        moves = self._get(f"/api/marketing/gift-cards/{card.id}/movements")
        bonus = [m for m in moves if m["kind"] == "adjust"]
        self.assertEqual([Decimal(m["amount"]) for m in bonus], [Decimal("100.00")])
        self.assertIn("Bonus VIP", bonus[0]["note"])

    def test_the_highest_threshold_reached_wins_and_below_none(self):
        card = self._sell(value="20.00")
        self._top_up(card, "300.00", "cash")
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("350.00"))   # 20 + 300 + 30
        self._top_up(card, "199.99", "cash")
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("549.99"))   # sotto la prima soglia: niente

    def test_selling_the_card_paid_gets_the_bonus(self):
        card = self._sell(value="500.00")
        self.assertEqual(card.balance, Decimal("600.00"))
        self.assertEqual(self._cash_in(), Decimal("500.00"))

    def test_no_bonus_on_imported_credit(self):
        card = self._sell(value="800.00", imported=True, paid=False, paid_method="")
        self.assertEqual(card.balance, Decimal("800.00"))

    def test_a_card_sold_at_the_till_gets_the_bonus(self):
        from unittest.mock import patch

        from apps.sales.services import finalize_sale
        from apps.sales.tests.base import PATCH_LOYALTY, _blocks

        with patch(PATCH_LOYALTY):
            sale = finalize_sale(
                self.salon, kind=Sale.Kind.POS, client=self.sofia,
                blocks=_blocks([{"line_type": "gift_card", "value": Decimal("500.00"), "qty": 1}]),
                payments=[{"method": "cash", "amount": Decimal("500.00")}],
            )
        card = GiftCard.objects.get(salon=self.salon)
        self.assertEqual(sale.total, Decimal("500.00"))
        self.assertEqual(card.balance, Decimal("600.00"))

    def test_the_rules_are_saved_in_order_and_validated(self):
        put = lambda rules: self.client.put(  # noqa: E731
            "/api/core/settings", json.dumps({"gift_card_bonus_rules": rules}),
            content_type="application/json", **self.auth,
        )
        res = put([{"min_amount": "500", "bonus": "100"}, {"min_amount": "200", "bonus": "30"}])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            [(Decimal(r["min_amount"]), Decimal(r["bonus"])) for r in res.json()["gift_card_bonus_rules"]],
            [(Decimal("200"), Decimal("30")), (Decimal("500"), Decimal("100"))],
        )
        self.assertEqual(put([{"min_amount": "0", "bonus": "10"}]).status_code, 400)
        self.assertEqual(put([{"min_amount": "100", "bonus": "10"}, {"min_amount": "100", "bonus": "20"}]).status_code, 400)
        self.assertEqual(put([]).status_code, 200)
        self.assertEqual(SalonSettings.objects.get(salon=self.salon).gift_card_bonus_rules, [])


class OneVipCardTests(GiftCardTestBase):
    """Beauty Boutique 11/2026: la cliente che rifà la carta VIP prima di finire
    il credito deve avere UNA carta, col credito vecchio più il nuovo; prima ne
    nasceva una seconda e il credito restava diviso."""

    _sell = VipCardTests._sell
    _cash_in = VipCardTests._cash_in

    def _till(self, *lines, client=None):
        from unittest.mock import patch

        from apps.sales.services import finalize_sale
        from apps.sales.tests.base import PATCH_LOYALTY, _blocks

        total = sum(Decimal(str(line["value"])) * line.get("qty", 1) for line in lines)
        with patch(PATCH_LOYALTY):
            return finalize_sale(
                self.salon, kind=Sale.Kind.POS, client=client or self.sofia,
                blocks=_blocks([{"line_type": "gift_card", "qty": 1, **line} for line in lines]),
                payments=[{"method": "cash", "amount": total}],
            )

    def test_selling_her_card_again_adds_to_the_one_she_has(self):
        card = self._sell(value="100.00")
        redeem_gift_card(self.salon, card.code, Decimal("30"))
        again = self._sell(value="200.00", paid_method="card")
        self.assertEqual(again.pk, card.pk)
        self.assertEqual(GiftCard.objects.filter(salon=self.salon).count(), 1)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("270.00"))
        self.assertEqual(card.initial_value, Decimal("300.00"))
        self.assertEqual(self._cash_in(), Decimal("300.00"))   # 100 + 200, il denaro entra lo stesso
        self.assertEqual(Payment.objects.get(method="card").amount, Decimal("200.00"))

    def test_the_bonus_applies_to_the_new_credit(self):
        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"gift_card_bonus_rules": [
            {"min_amount": "500.00", "bonus": "100.00"},
        ]})
        card = self._sell(value="50.00")
        self._sell(value="500.00")
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("650.00"))

    def test_at_the_till_the_new_credit_goes_on_her_card(self):
        card = self._sell(value="100.00")
        sale = self._till({"value": Decimal("150.00")})
        self.assertEqual(GiftCard.objects.filter(salon=self.salon).count(), 1)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("250.00"))
        self.assertEqual(sale.lines.get().gift_card_id, card.pk)
        self.assertEqual(self._cash_in(), Decimal("250.00"))
        moves = self._get(f"/api/marketing/gift-cards/{card.id}/movements")
        self.assertEqual(sorted(Decimal(m["amount"]) for m in moves if m["kind"] == "load"),
                         [Decimal("100.00"), Decimal("150.00")])

    def test_gifts_stay_separate_cards(self):
        card = self._sell(value="100.00")
        self._till({"value": Decimal("50.00"), "recipient_name": "Giulia"})
        self._till({"value": Decimal("50.00"), "qty": 2})
        laura = _client(self.salon, "Laura", "+393339998877")
        self._sell(kind="gift", value="40.00", buyer_client_id=self.sofia.id, recipient_client_id=laura.id)
        self.assertEqual(GiftCard.objects.filter(salon=self.salon).count(), 5)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("100.00"))

    def test_a_spent_expired_or_unpaid_card_does_not_take_the_credit(self):
        from datetime import timedelta

        from django.utils import timezone

        spent = self._sell(value="20.00")
        redeem_gift_card(self.salon, spent.code, Decimal("20"))
        unpaid = self._sell(value="30.00", paid=False, paid_method="")
        old = self._sell(value="40.00")
        GiftCard.objects.filter(pk=old.pk).update(expires_at=timezone.now() - timedelta(days=1))
        new = self._sell(value="60.00")
        self.assertNotIn(new.pk, {spent.pk, unpaid.pk, old.pk})
        self.assertEqual(new.balance, Decimal("60.00"))

    def test_the_longer_expiry_wins(self):
        from datetime import timedelta

        from django.utils import timezone

        card = self._sell(value="100.00")
        soon = timezone.now() + timedelta(days=10)
        GiftCard.objects.filter(pk=card.pk).update(expires_at=soon)
        later = (timezone.now() + timedelta(days=365)).replace(microsecond=0)
        self._sell(value="50.00", expires_at=later.isoformat())
        card.refresh_from_db()
        self.assertEqual(card.expires_at, later)
