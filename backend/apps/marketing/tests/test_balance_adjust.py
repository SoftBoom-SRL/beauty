"""Modifica manuale del saldo della carta VIP e storico dei movimenti
(Beauty Boutique, 11/2026): il saldo cambia senza incasso, con il motivo, e il
movimento resta nello storico della carta."""

from decimal import Decimal

from apps.core.models import ActivityLog
from apps.sales.models import Payment, Sale

from ..gift_cards import redeem_gift_card
from ..models import GiftCard, GiftCardAdjustment
from .base import GiftCardTestBase


class BalanceAdjustTests(GiftCardTestBase):
    def _sell(self, **extra):
        body = {"kind": "prepaid", "value": "100.00", "recipient_client_id": self.sofia.id,
                "paid": True, "paid_method": "cash", **extra}
        res = self._post("/api/marketing/gift-cards", body)
        self.assertEqual(res.status_code, 200, res.content)
        return GiftCard.objects.get(pk=res.json()["id"])

    def _adjust(self, card, auth=None, **body):
        return self._post(f"/api/marketing/gift-cards/{card.id}/adjust", body, auth=auth)

    def test_adding_credit_changes_the_balance_without_cashing_anything(self):
        card = self._sell()
        sales, payments = Sale.objects.count(), Payment.objects.count()
        res = self._adjust(card, amount="25.00", note="Bonus concordato")
        self.assertEqual(res.status_code, 200, res.content)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("125.00"))
        self.assertEqual((Sale.objects.count(), Payment.objects.count()), (sales, payments))
        adj = GiftCardAdjustment.objects.get()
        self.assertEqual((adj.delta, adj.balance_after, adj.note), (Decimal("25.00"), Decimal("125.00"), "Bonus concordato"))
        self.assertTrue(ActivityLog.objects.filter(type="giftcard.adjusted").exists())

    def test_removing_credit_or_setting_the_new_balance(self):
        card = self._sell()
        self.assertEqual(self._adjust(card, amount="-30", note="Errore di carico").status_code, 200)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("70.00"))
        self.assertEqual(self._adjust(card, new_balance="0", note="Credito chiuso").status_code, 200)
        card.refresh_from_db()
        self.assertEqual((card.balance, card.status), (Decimal("0.00"), GiftCard.Status.REDEEMED))
        # di nuovo su: la carta esaurita torna attiva
        self.assertEqual(self._adjust(card, amount="10", note="Rimborso").status_code, 200)
        card.refresh_from_db()
        self.assertEqual((card.balance, card.status), (Decimal("10.00"), GiftCard.Status.ACTIVE))

    def test_the_note_is_required_and_the_balance_cannot_go_negative(self):
        card = self._sell()
        res = self._adjust(card, amount="10", note="  ")
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["detail"], "Scrivi il motivo della modifica del saldo")
        self.assertEqual(self._adjust(card, amount="-150", note="x").status_code, 422)
        self.assertEqual(self._adjust(card, amount="10", new_balance="5", note="x").status_code, 422)
        self.assertFalse(GiftCardAdjustment.objects.exists())

    def test_it_asks_for_the_sales_permission(self):
        card = self._sell()
        auth = self._staff("mkt@parlour.it", ["marketing"])
        self.assertEqual(self._adjust(card, auth=auth, amount="10", note="x").status_code, 403)

    def test_a_cancelled_card_is_not_adjusted(self):
        card = self._sell()
        self._post(f"/api/marketing/gift-cards/{card.id}/cancel", {"reason": "errore"})
        self.assertEqual(self._adjust(card, amount="10", note="x").status_code, 422)

    def test_the_movements_tell_the_story_of_the_card(self):
        card = self._sell()
        self._post(f"/api/marketing/gift-cards/{card.id}/top-up", {"amount": "50.00", "method": "card"})
        redeem_gift_card(self.salon, card.code, Decimal("30"))
        self._adjust(card, amount="-5", note="Arrotondamento")
        res = self.client.get(f"/api/marketing/gift-cards/{card.id}/movements", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        rows = [(m["kind"], m["amount"], m["note"]) for m in res.json()]
        self.assertIn(("load", "100.00", ""), rows)
        self.assertIn(("load", "50.00", ""), rows)
        self.assertIn(("adjust", "-5.00", "Arrotondamento"), rows)
        self.assertEqual(rows[-1][0], "adjust")

    def test_an_imported_card_starts_with_its_issue(self):
        card = self._sell(value="80.00", imported=True, paid=False, paid_method="")
        self._adjust(card, amount="20", note="Bonus")
        rows = self.client.get(f"/api/marketing/gift-cards/{card.id}/movements", **self.auth).json()
        self.assertEqual([(m["kind"], m["amount"]) for m in rows], [("issued", "80.00"), ("adjust", "20.00")])
