"""Conti da saldare: la cliente paga una parte, il resto resta scritto sulla vendita.

Il venduto resta del giorno della vendita, il denaro entra in cassa il giorno in
cui arriva: il riepilogo di oggi toglie la parte lasciata da saldare e aggiunge
i saldi arrivati oggi per conti di altri giorni (`Payment.created_at`).
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone

from apps.core.models import ActivityLog, Salon
from apps.insights.services import kpis
from common.testing import aware, post_json

from ..models import Payment, Sale
from ..reports import today_summary
from .base import PATCH_LOYALTY, HistoryTestBase


class DueTestBase(HistoryTestBase):
    """Una visita da 100 di Sofia e gli aiuti per incassarla lasciando un debito."""

    def _bill(self, paid="40.00", leave_due=True, appointment=None):
        appointment = appointment or self._appointment()
        payments = [{"method": "cash", "amount": paid}] if Decimal(paid) else []
        return self.client.post(
            f"/api/sales/checkout/{appointment.id}",
            data=json.dumps({
                "blocks": [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
                "payments": payments,
                "leave_due": leave_due,
            }),
            content_type="application/json", **self.auth,
        )

    def _settle(self, sale_id, *payments):
        return post_json(self.client, f"/api/sales/{sale_id}/settle", {"payments": list(payments)}, **self.auth)

    def _backdate(self, sale_id, when):
        """La vendita (e i pagamenti fatti al conto) come se fossero di `when`."""
        Sale.objects.filter(pk=sale_id).update(created_at=when)
        Payment.objects.filter(sale_id=sale_id).update(created_at=when)


class LeaveDueTests(DueTestBase):
    def test_the_checkout_leaves_the_rest_of_the_bill_due(self):
        res = self._bill(paid="40.00")
        self.assertEqual(res.status_code, 200, res.content)
        sale = res.json()["sale"]
        self.assertEqual(Decimal(sale["total"]), Decimal("100.00"))
        self.assertEqual(Decimal(sale["amount_due"]), Decimal("60.00"))
        self.assertEqual(Sale.objects.get(pk=sale["id"]).amount_due, Decimal("60.00"))
        # ogni pagamento dice quando è arrivato il denaro: al conto, con la vendita
        self.assertIsNotNone(sale["payments"][0]["created_at"])
        self.assertIn("da saldare € 60.00", ActivityLog.objects.get(type="sale.created").summary)

    def test_nothing_paid_now_leaves_the_whole_bill_due(self):
        res = self._bill(paid="0")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["sale"]["amount_due"]), Decimal("100.00"))
        self.assertEqual(res.json()["sale"]["payments"], [])

    def test_without_the_flag_a_short_payment_is_still_refused(self):
        res = self._bill(paid="40.00", leave_due=False)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], "I pagamenti non corrispondono al totale")
        self.assertFalse(Sale.objects.exists())

    def test_paying_more_than_the_bill_is_refused_even_leaving_a_due(self):
        res = self._bill(paid="120.00")
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], "I pagamenti superano il totale da pagare")
        self.assertFalse(Sale.objects.exists())

    def test_the_full_payment_leaves_nothing_due(self):
        res = self._bill(paid="100.00")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["sale"]["amount_due"]), Decimal("0.00"))

    def test_a_walk_in_sale_cannot_leave_a_debt(self):
        """Senza cliente non si saprebbe a chi chiedere il resto."""
        body = {
            "blocks": [{"operator_id": self.giulia.id, "lines": [self._line(self.piega, "30.00")]}],
            "payments": [{"method": "cash", "amount": "10.00"}],
            "leave_due": True,
        }
        res = post_json(self.client, "/api/sales/pos", body, **self.auth)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], "Per lasciare un conto da saldare scegli la cliente")
        res = post_json(self.client, "/api/sales/pos", {**body, "client_id": self.client_obj.id}, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["amount_due"]), Decimal("20.00"))


class SettleTests(DueTestBase):
    def test_the_balance_is_paid_in_two_goes(self):
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        res = self._settle(sale_id, {"method": "card", "amount": "20.00"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["amount_due"]), Decimal("40.00"))
        res = self._settle(sale_id, {"method": "cash", "amount": "15.00"}, {"method": "card", "amount": "25.00"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["amount_due"]), Decimal("0.00"))
        sale = Sale.objects.get(pk=sale_id)
        self.assertEqual(sale.amount_due, Decimal("0.00"))
        self.assertEqual(sum(p.amount for p in sale.payments.all()), Decimal("100.00"))
        # il venduto non cambia: è sempre il conto da 100 del giorno della visita
        self.assertEqual(sale.total, Decimal("100.00"))
        settled = ActivityLog.objects.filter(type="sale.settled").order_by("id")
        self.assertEqual(settled.count(), 2)
        self.assertEqual(settled.last().payload["amount_due"], "0.00")

    def test_paying_more_than_what_is_left_is_refused(self):
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        res = self._settle(sale_id, {"method": "cash", "amount": "70.00"})
        self.assertEqual(res.status_code, 422, res.content)
        self.assertIn("60.00", res.json()["detail"])
        self.assertEqual(Sale.objects.get(pk=sale_id).payments.count(), 1)

    def test_a_paid_bill_has_nothing_to_settle(self):
        sale_id = self._bill(paid="100.00").json()["sale"]["id"]
        res = self._settle(sale_id, {"method": "cash", "amount": "10.00"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(res.json()["detail"], "Questo conto è già saldato")

    def test_a_zero_payment_is_refused(self):
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        res = self._settle(sale_id, {"method": "cash", "amount": "0"})
        self.assertEqual(res.status_code, 422, res.content)

    def test_the_balance_can_be_paid_with_a_gift_card(self):
        from apps.marketing.gift_cards import create_gift_card
        from apps.marketing.models import GiftCard

        card = create_gift_card(self.salon, Decimal("100.00"), paid=True, paid_method="cash")
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        res = self._settle(sale_id, {"method": "gift_card", "amount": "60.00", "gift_card_code": card.code})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(GiftCard.objects.get(pk=card.pk).balance, Decimal("40.00"))
        self.assertEqual(res.json()["payments"][-1]["gift_card_code"], card.code)

    def test_settling_asks_for_the_sales_permission_and_stays_in_the_salon(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        user = User.objects.create_user(email="sala@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Sala di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        token = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        payment = {"payments": [{"method": "cash", "amount": "60.00"}]}
        res = post_json(self.client, f"/api/sales/{sale_id}/settle", payment, **token)
        self.assertEqual(res.status_code, 403, res.content)

        other = Salon.objects.create(name="Altro", slug="altro")
        owner = User.objects.create_user(email="altro@altro.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=other, is_owner=True)
        token = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, other)['access']}"}
        res = post_json(self.client, f"/api/sales/{sale_id}/settle", payment, **token)
        self.assertEqual(res.status_code, 404, res.content)
        self.assertEqual(Sale.objects.get(pk=sale_id).amount_due, Decimal("60.00"))

    def test_the_settlement_locks_the_salon_before_the_sale(self):
        """Due postazioni che saldano insieme lo stesso conto: la seconda aspetta e lo
        rilegge già pagato (su SQLite i lock sono un no-op: qui conta l'ordine)."""
        from django.db.models.query import QuerySet

        real = QuerySet.select_for_update
        order = []

        def spy(queryset, *args, **kwargs):
            order.append(queryset.model.__name__)
            return real(queryset, *args, **kwargs)

        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        with patch.object(QuerySet, "select_for_update", spy):
            self.assertEqual(self._settle(sale_id, {"method": "cash", "amount": "60.00"}).status_code, 200)
        self.assertEqual(order[:2], ["Salon", "Sale"])


class DuesListTests(DueTestBase):
    def test_the_open_bills_of_the_client_oldest_first(self):
        first = self._bill(paid="40.00").json()["sale"]["id"]
        second = self._bill(paid="90.00").json()["sale"]["id"]
        self._bill(paid="100.00")
        res = self.client.get(f"/api/sales/dues?client_id={self.client_obj.id}", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(Decimal(body["amount_due"]), Decimal("70.00"))
        self.assertEqual([s["id"] for s in body["sales"]], [first, second])
        self.assertEqual([Decimal(s["amount_due"]) for s in body["sales"]], [Decimal("60.00"), Decimal("10.00")])

    def test_the_history_filters_the_bills_to_settle(self):
        self._bill(paid="40.00")
        self._bill(paid="100.00")
        everything = self.client.get("/api/sales/", **self.auth).json()
        self.assertEqual(everything["count"], 2)
        self.assertEqual(Decimal(everything["kpi"]["due_total"]), Decimal("60.00"))
        due = self.client.get("/api/sales/?due=1", **self.auth).json()
        self.assertEqual(due["count"], 1)
        self.assertEqual(Decimal(due["items"][0]["amount_due"]), Decimal("60.00"))
        self.assertEqual(Decimal(due["kpi"]["revenue"]), Decimal("100.00"))


class CashComesWhenItArrivesTests(DueTestBase):
    """Il riepilogo di cassa e gli insight contano il denaro il giorno in cui arriva."""

    def test_the_part_left_due_is_not_cash_of_today(self):
        self._bill(paid="40.00")
        summary = today_summary(self.salon)
        self.assertEqual(summary["total"], Decimal("100.00"))   # il venduto resta 100
        self.assertEqual(summary["due_left"], Decimal("60.00"))
        self.assertEqual(summary["settled"], Decimal("0.00"))
        self.assertEqual(summary["cash_in"], Decimal("40.00"))  # entrati davvero: 40

    def test_a_balance_settled_later_the_same_day_is_cash_of_today(self):
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        self._settle(sale_id, {"method": "cash", "amount": "60.00"})
        summary = today_summary(self.salon)
        self.assertEqual(summary["due_left"], Decimal("0.00"))
        self.assertEqual(summary["settled"], Decimal("0.00"))   # vendita di oggi: non è un saldo di prima
        self.assertEqual(summary["cash_in"], Decimal("100.00"))

    def test_the_balance_of_yesterday_enters_the_till_today(self):
        """Ieri conto da 100 pagato 40; oggi la cliente salda i 60."""
        today = timezone.localdate()
        yesterday = today - dt.timedelta(days=1)
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        self._backdate(sale_id, aware(yesterday, 11))
        self.assertEqual(self._settle(sale_id, {"method": "card", "amount": "60.00"}).status_code, 200)

        summary = today_summary(self.salon)
        self.assertEqual(summary["total"], Decimal("0.00"))     # oggi non si è venduto niente
        self.assertEqual(summary["count"], 0)
        self.assertEqual(summary["settled"], Decimal("60.00"))
        self.assertEqual(summary["cash_in"], Decimal("60.00"))

        # Ieri: venduto 100, entrati 40; i 60 arrivati oggi non sono di ieri.
        of_yesterday = kpis(self.salon, "month", date_from=yesterday, date_to=yesterday)
        self.assertEqual(of_yesterday["revenue"], Decimal("100.00"))
        self.assertEqual(of_yesterday["due_left"], Decimal("60.00"))
        self.assertEqual(of_yesterday["cash_in"], Decimal("40.00"))
        of_today = kpis(self.salon, "month", date_from=today, date_to=today)
        self.assertEqual(of_today["revenue"], Decimal("0.00"))
        self.assertEqual(of_today["settled"], Decimal("60.00"))
        self.assertEqual(of_today["cash_in"], Decimal("60.00"))
        # i due giorni insieme: 100 venduti, 100 entrati
        both = kpis(self.salon, "month", date_from=yesterday, date_to=today)
        self.assertEqual((both["revenue"], both["cash_in"]), (Decimal("100.00"), Decimal("100.00")))

    def test_a_balance_paid_with_a_gift_card_adds_no_cash(self):
        """Il saldo con una gift card è denaro entrato quando la carta fu venduta."""
        from apps.marketing.gift_cards import create_gift_card

        card = create_gift_card(self.salon, Decimal("60.00"), paid=True, paid_method="cash")
        yesterday = timezone.localdate() - dt.timedelta(days=1)
        sale_id = self._bill(paid="40.00").json()["sale"]["id"]
        self._backdate(sale_id, aware(yesterday, 11))
        self._settle(sale_id, {"method": "gift_card", "amount": "60.00", "gift_card_code": card.code})
        summary = today_summary(self.salon)
        self.assertEqual(summary["settled"], Decimal("60.00"))
        self.assertEqual(summary["gift_card_redeemed"], Decimal("60.00"))
        self.assertEqual(summary["cash_in"], Decimal("0.00"))

    def test_old_sales_without_a_due_keep_their_old_figures(self):
        """Vendite registrate prima dei conti da saldare: niente cambia nel riepilogo."""
        with patch(PATCH_LOYALTY):
            self._bill(paid="100.00")
        summary = today_summary(self.salon)
        self.assertEqual((summary["due_left"], summary["settled"]), (Decimal("0.00"), Decimal("0.00")))
        self.assertEqual(summary["cash_in"], Decimal("100.00"))
