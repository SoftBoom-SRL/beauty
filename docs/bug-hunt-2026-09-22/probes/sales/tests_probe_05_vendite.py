"""PROBE TEMPORANEO revisore 05 — da cancellare a fine revisione."""

import json
from decimal import Decimal
from unittest.mock import Mock, patch

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.inventory.models import Product, Supplier
from apps.staff.models import Operator
from common.auth import create_staff_tokens

from .models import Sale
from .services import today_summary


class Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales", "agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.user = user
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi"
        )
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.service = Service.objects.create(
            salon=self.salon, category=cat, name_it="Colore", duration_min=60,
            price=Decimal("100.00"),
        )
        self.service2 = Service.objects.create(
            salon=self.salon, category=cat, name_it="Piega", duration_min=30,
            price=Decimal("20.00"),
        )

    def _appt(self, prices=("100.00",), **kw):
        a = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + timezone.timedelta(days=2), **kw,
        )
        for i, p in enumerate(prices):
            AppointmentService.objects.create(
                appointment=a, service=self.service if i == 0 else self.service2,
                operator=self.operator, duration_min=30, price=Decimal(p), order=i,
            )
        return a

    def _meta(self, a):
        return {"appointment_id": str(a.id), "salon_id": str(self.salon.id), "kind": "deposit"}

    def _checkout(self, a, price, paid, method="cash"):
        payments = [] if Decimal(paid) == 0 else [{"method": method, "amount": paid}]
        body = {
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": price}
            ]}],
            "payments": payments,
        }
        return self.client.post(
            f"/api/sales/checkout/{a.id}", json.dumps(body),
            content_type="application/json", **self.auth,
        )


class HistoryKpiProbe(Base):
    def test_history_revenue_counts_the_deposit_twice(self):
        from .api import _payment_intent_succeeded

        a = self._appt(deposit_status="required", deposit_amount=Decimal("30.00"))
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self._meta(a))
        a.refresh_from_db()
        self.assertEqual(a.deposit_status, "paid")
        r = self._checkout(a, "100.00", "70.00")
        self.assertEqual(r.status_code, 200, r.content)
        listed = self.client.get("/api/sales/", **self.auth).json()
        print("\nPROBE history kpi:", listed["kpi"], "count", listed["count"])
        s = today_summary(self.salon)
        print("PROBE today total", s["total"], "cash_in", s["cash_in"])
        # venduto reale 100, incassato 100
        self.assertEqual(Decimal(listed["kpi"]["revenue"]), Decimal("130.00"))


class ShrinkThenRefundProbe(Base):
    def test_refunding_the_excess_after_a_shrink_zeroes_the_deposit(self):
        from apps.agenda.services import shrink_deposit_to_total

        from .api import _charge_refunded, _payment_intent_succeeded

        # Caparra fissa 50 su una visita da 100+20; pagata online.
        a = self._appt(prices=("100.00", "20.00"), deposit_status="required",
                       deposit_amount=Decimal("50.00"))
        _payment_intent_succeeded({"id": "pi_dep", "amount_received": 5000}, self._meta(a))
        a.refresh_from_db()
        self.assertEqual(a.deposit_status, "paid")
        # La visita scende a 20 (resta solo la piega): caparra ridotta a 20,
        # nel registro «30 da rimborsare».
        a.items.filter(service=self.service).delete()
        shrink_deposit_to_total(a)
        a.refresh_from_db()
        self.assertEqual(a.deposit_amount, Decimal("20.00"))
        # Il titolare restituisce i 30 dalla dashboard Stripe: arrivano gli eventi.
        _charge_refunded({"id": "re_1", "payment_intent": "pi_dep", "amount": 3000,
                          "status": "succeeded"}, "refund.created")
        _charge_refunded({"payment_intent": "pi_dep", "amount": 5000, "amount_refunded": 3000,
                          "refunded": False}, "charge.refunded")
        a.refresh_from_db()
        print("\nPROBE after excess refund:", a.deposit_status, a.deposit_refunded_amount,
              a.deposit_credit)
        self.assertEqual(a.deposit_status, "refunded")
        self.assertEqual(a.deposit_credit, Decimal("0.00"))
        # al checkout si incassano di nuovo 20: la cliente ha già lasciato 20 su Stripe
        body = {
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "service", "service_id": self.service2.id, "qty": 1, "unit_price": "20.00"}
            ]}],
            "payments": [{"method": "cash", "amount": "20.00"}],
        }
        r = self.client.post(f"/api/sales/checkout/{a.id}", json.dumps(body),
                             content_type="application/json", **self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        sale = Sale.objects.get(appointment=a)
        print("PROBE checkout total", sale.total, "deducted", sale.deposit_deducted)
        self.assertEqual(sale.deposit_deducted, Decimal("0.00"))


class StaleLinkOverpaymentProbe(Base):
    def test_old_link_amount_is_accepted_and_the_excess_vanishes(self):
        from apps.agenda.services import shrink_deposit_to_total

        from .api import _payment_intent_succeeded

        a = self._appt(prices=("100.00", "20.00"), deposit_status="required",
                       deposit_amount=Decimal("30.00"),
                       deposit_payment_link="https://checkout.stripe.test/old",
                       deposit_checkout_session_id="cs_old")
        a.items.filter(service=self.service).delete()
        shrink_deposit_to_total(a)
        a.refresh_from_db()
        self.assertEqual(a.deposit_amount, Decimal("20.00"))
        self.assertEqual(a.deposit_payment_link, "https://checkout.stripe.test/old")
        # la cliente paga il link vecchio: 30 €
        _payment_intent_succeeded({"id": "pi_old", "amount_received": 3000}, self._meta(a))
        a.refresh_from_db()
        dep = Sale.objects.get(deposit_appointment=a)
        from apps.core.models import ActivityLog
        types = list(ActivityLog.objects.filter(salon=self.salon).values_list("type", flat=True))
        print("\nPROBE stale link:", a.deposit_status, "deposit sale", dep.total, "credit",
              a.deposit_credit, types)
        self.assertEqual(dep.total, Decimal("20.00"))
        self.assertEqual(a.deposit_credit, Decimal("20.00"))


class RoundingProbe(Base):
    def test_pos_with_frontend_rounding_is_rejected(self):
        supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        p1 = Product.objects.create(salon=self.salon, name="A", supplier=supplier,
                                    stock_qty=Decimal("10"), sale_price=Decimal("9.50"))
        p2 = Product.objects.create(salon=self.salon, name="B", supplier=supplier,
                                    stock_qty=Decimal("10"), sale_price=Decimal("10.50"))
        # CartTab: sconto globale 15% → lineAmount frontend 8.07 + 8.92 = 16.99
        body = {
            "client_id": None,
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "product", "product_id": p1.id, "qty": 1, "unit_price": "9.50",
                 "discount_pct": 15, "is_gift": False},
                {"line_type": "product", "product_id": p2.id, "qty": 1, "unit_price": "10.50",
                 "discount_pct": 15, "is_gift": False},
            ]}],
            "payments": [{"method": "cash", "amount": "16.99"}],
        }
        r = self.client.post("/api/sales/pos", json.dumps(body),
                             content_type="application/json", **self.auth)
        print("\nPROBE rounding:", r.status_code, r.content[:200])
        self.assertEqual(r.status_code, 422)


@override_settings(STRIPE_SECRET_KEY="sk_test")
class RefundNotInCashProbe(Base):
    def test_a_refunded_deposit_stays_in_cash_in(self):
        from apps.agenda.services import cancel_appointment

        from .api import _payment_intent_succeeded

        a = self._appt(deposit_status="required", deposit_amount=Decimal("30.00"))
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self._meta(a))
        stripe = Mock()
        stripe.Refund.create.return_value = {"id": "re_1", "amount": 3000, "status": "succeeded"}
        with patch("apps.sales.stripe_service._client", return_value=stripe):
            cancel_appointment(a, reason="", actor=self.user, by_client=False)
        a.refresh_from_db()
        s = today_summary(self.salon)
        print("\nPROBE refunded deposit:", a.status, a.deposit_status, "summary", s)
        self.assertEqual(a.deposit_status, "refunded")
        self.assertEqual(s["cash_in"], Decimal("30.00"))
        self.assertEqual(s["deposit_cashed"], Decimal("30.00"))


class OutOfOrderRefundProbe(Base):
    def test_a_late_pending_event_undoes_a_succeeded_refund(self):
        from .api import _charge_refunded

        a = self._appt(deposit_status="paid", deposit_amount=Decimal("30.00"),
                       deposit_payment_intent_id="pi_dep")
        _charge_refunded({"id": "re_1", "payment_intent": "pi_dep", "amount": 3000,
                          "status": "succeeded"}, "refund.updated")
        a.refresh_from_db()
        self.assertEqual(a.deposit_status, "refunded")
        # arriva in ritardo l'evento di creazione, con lo stato di allora
        _charge_refunded({"id": "re_1", "payment_intent": "pi_dep", "amount": 3000,
                          "status": "pending"}, "refund.created")
        a.refresh_from_db()
        print("\nPROBE out of order:", a.deposit_status, a.deposit_refunded_amount)
        self.assertEqual(a.deposit_status, "refunding")
        self.assertEqual(a.deposit_refunded_amount, Decimal("0.00"))


class ClientStatsProbe(Base):
    def test_the_deposit_sale_is_a_visit(self):
        from apps.agenda.services import compute_deposit
        from apps.core.models import DepositRule
        from apps.clients.services import client_facts, client_stats

        from .api import _payment_intent_succeeded

        DepositRule.objects.create(
            salon=self.salon, name="Prima visita", active=True,
            conditions={"op": "and", "rules": [{"field": "visits", "cmp": "lt", "value": 1}]},
            amount_type="fixed", amount=Decimal("20.00"),
        )
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))
        a = self._appt(deposit_status="required", deposit_amount=Decimal("20.00"))
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 2000}, self._meta(a))
        stats = client_stats(self.client_obj)
        print("\nPROBE client stats after deposit only:", stats, client_facts(self.client_obj)["visits"])
        self.assertEqual(stats["visits"], 1)
        # seconda prenotazione, mai venuta in salone: niente più caparra
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("0.00"))
        r = self._checkout(a, "100.00", "80.00")
        self.assertEqual(r.status_code, 200, r.content)
        stats = client_stats(self.client_obj)
        print("PROBE client stats after checkout:", stats)
        self.assertEqual(stats["visits"], 2)
        self.assertEqual(stats["total_spent"], Decimal("120.00"))


@override_settings(STRIPE_SECRET_KEY="sk_test")
class AccountSwitchProbe(Base):
    def test_refund_after_connect_goes_to_the_new_account(self):
        from apps.agenda.services import cancel_appointment
        from apps.core.models import SalonSettings

        from .api import _payment_intent_succeeded

        a = self._appt(deposit_status="required", deposit_amount=Decimal("30.00"))
        # pagata sull'account della piattaforma (evento senza account)
        _payment_intent_succeeded({"id": "pi_platform", "amount_received": 3000}, self._meta(a))
        # il titolare collega il proprio Stripe
        s, _ = SalonSettings.objects.get_or_create(salon=self.salon)
        s.stripe_account_id = "acct_new"
        s.save()
        self.salon.refresh_from_db()
        a = Appointment.objects.select_related("salon", "salon__settings").get(pk=a.pk)
        stripe = Mock()
        stripe.StripeError = Exception
        stripe.Refund.create.side_effect = Exception("No such payment_intent: 'pi_platform'")
        with patch("apps.sales.stripe_service._client", return_value=stripe):
            cancel_appointment(a, reason="", actor=self.user, by_client=False)
        print("\nPROBE account switch refund kwargs:", stripe.Refund.create.call_args)
        a.refresh_from_db()
        print("PROBE deposit after cancel:", a.deposit_status)
        self.assertEqual(stripe.Refund.create.call_args.kwargs.get("stripe_account"), "acct_new")
        self.assertEqual(a.deposit_status, "refund_due")


class FloorThenFailedProbe(Base):
    def test_a_failure_after_charge_refunded_keeps_refunded(self):
        from .api import _charge_refunded

        a = self._appt(deposit_status="paid", deposit_amount=Decimal("30.00"),
                       deposit_payment_intent_id="pi_dep")
        _charge_refunded({"payment_intent": "pi_dep", "amount": 3000, "amount_refunded": 3000,
                          "refunded": True}, "charge.refunded")
        a.refresh_from_db()
        self.assertEqual(a.deposit_status, "refunded")
        _charge_refunded({"id": "re_1", "payment_intent": "pi_dep", "amount": 3000,
                          "status": "failed"}, "charge.refund.updated")
        a.refresh_from_db()
        print("\nPROBE floor then failed:", a.deposit_status, a.deposit_refunded_amount, a.deposit_credit)
        self.assertEqual(a.deposit_status, "refunded")


@override_settings(STRIPE_SECRET_KEY="sk_test")
class LinkLifetimeProbe(Base):
    def test_link_expiry_versus_hold(self):
        from . import stripe_service

        stripe = Mock()
        stripe.StripeError = Exception
        stripe.checkout.Session.create.return_value = {"id": "cs_1", "url": "https://checkout.test/1"}
        # scadenza caparra «Mai» (default): nessun expires_at → Stripe chiude dopo 24 h
        a = self._appt(deposit_status="required", deposit_amount=Decimal("30.00"))
        with patch.object(stripe_service, "_client", return_value=stripe):
            stripe_service.create_deposit_checkout(a)
        print("\nPROBE hold 0 expires_at:", stripe.checkout.Session.create.call_args.kwargs.get("expires_at"))
        self.assertNotIn("expires_at", stripe.checkout.Session.create.call_args.kwargs)
        # scadenza 20 minuti (preset consigliato): nessun expires_at → link vivo 24 h dopo il rilascio
        b = self._appt(deposit_status="required", deposit_amount=Decimal("30.00"),
                       deposit_due_at=timezone.now() + timezone.timedelta(minutes=20))
        with patch.object(stripe_service, "_client", return_value=stripe):
            stripe_service.create_deposit_checkout(b)
        print("PROBE hold 20 expires_at:", stripe.checkout.Session.create.call_args.kwargs.get("expires_at"))
        self.assertNotIn("expires_at", stripe.checkout.Session.create.call_args.kwargs)

    def test_the_client_gets_back_the_stored_link_forever(self):
        from . import stripe_service

        a = self._appt(deposit_status="required", deposit_amount=Decimal("30.00"),
                       deposit_payment_link="https://checkout.test/expired",
                       deposit_checkout_session_id="cs_old")
        from common.auth import create_client_tokens

        token = create_client_tokens(self.client_obj)["access"]
        stripe = Mock()
        stripe.StripeError = Exception
        with patch.object(stripe_service, "_client", return_value=stripe):
            r = self.client.post(f"/api/sales/client/appointments/{a.id}/deposit-link",
                                 "{}", content_type="application/json",
                                 HTTP_AUTHORIZATION=f"Bearer {token}")
        print("\nPROBE client link:", r.status_code, r.content[:200],
              "Session.create calls", stripe.checkout.Session.create.call_count)
        self.assertEqual(r.json()["url"], "https://checkout.test/expired")
        self.assertEqual(stripe.checkout.Session.create.call_count, 0)


@override_settings(STRIPE_SECRET_KEY="sk_test")
class UndoCreateWithDepositProbe(Base):
    def test_undo_leaves_the_payment_link_alive_and_the_payment_is_lost(self):
        from apps.core.models import ActivityLog, DepositRule, OutboxEvent

        from . import stripe_service
        from .api import _payment_intent_succeeded

        self.service.operators.add(self.operator)
        DepositRule.objects.create(salon=self.salon, name="Sempre", active=True,
                                   conditions={}, amount_type="fixed", amount=Decimal("20.00"))
        self.client_obj.deposit_always = True
        self.client_obj.save()
        stripe = Mock()
        stripe.StripeError = Exception
        stripe.checkout.Session.create.return_value = {"id": "cs_1", "url": "https://checkout.test/1"}
        start = (timezone.now() + timezone.timedelta(days=3)).replace(hour=10, minute=0, second=0, microsecond=0)
        with patch.object(stripe_service, "_client", return_value=stripe):
            r = self.client.post("/api/agenda/appointments", json.dumps({
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.service.id, "operator_id": self.operator.id}],
                "start": start.isoformat(), "force": True,
            }), content_type="application/json", **self.auth)
            self.assertEqual(r.status_code, 200, r.content)
            appt_id = r.json()["id"]
            links = list(OutboxEvent.objects.filter(event_type="deposit.payment_link").values_list("status", "next_attempt_at"))
            print("\nPROBE undo-create: deposit", r.json()["deposit_status"], r.json()["deposit_amount"], "link events", links)
            u = self.client.post("/api/agenda/undo", "{}", content_type="application/json", **self.auth)
            print("PROBE undo:", u.status_code, u.content[:160])
            self.assertEqual(u.status_code, 200, u.content)
        self.assertFalse(Appointment.objects.filter(pk=appt_id).exists())
        print("PROBE Session.expire called:", stripe.checkout.Session.expire.called,
              "link events after undo", list(OutboxEvent.objects.filter(event_type="deposit.payment_link").values_list("status", flat=True)))
        before = ActivityLog.objects.count()
        _payment_intent_succeeded({"id": "pi_x", "amount_received": 2000}, {
            "appointment_id": str(appt_id), "salon_id": str(self.salon.id), "kind": "deposit"})
        print("PROBE after payment on deleted appt: new logs", ActivityLog.objects.count() - before,
              "sales", Sale.objects.count())
        self.assertEqual(ActivityLog.objects.count(), before)
        self.assertEqual(Sale.objects.count(), 0)
        self.assertFalse(stripe.checkout.Session.expire.called)


@override_settings(STRIPE_SECRET_KEY="sk_test")
class HoldWithoutLinkProbe(Base):
    def test_link_creation_fails_but_the_slot_is_released_anyway(self):
        from apps.agenda.services import process_deposit_holds
        from apps.core.models import DepositRule, OutboxEvent, SalonSettings

        from . import stripe_service

        s, _ = SalonSettings.objects.get_or_create(salon=self.salon)
        s.deposit_hold_minutes = 20
        s.save()
        self.salon.refresh_from_db()
        self.service.operators.add(self.operator)
        DepositRule.objects.create(salon=self.salon, name="Sempre", active=True,
                                   conditions={}, amount_type="fixed", amount=Decimal("20.00"))
        self.client_obj.deposit_always = True
        self.client_obj.save()

        class StripeError(Exception):
            pass

        stripe = Mock()
        stripe.StripeError = StripeError
        stripe.checkout.Session.create.side_effect = StripeError("Your account cannot currently make live charges.")
        start = (timezone.now() + timezone.timedelta(days=3)).replace(hour=10, minute=0, second=0, microsecond=0)
        with patch.object(stripe_service, "_client", return_value=stripe):
            r = self.client.post("/api/agenda/appointments", json.dumps({
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.service.id, "operator_id": self.operator.id}],
                "start": start.isoformat(), "force": True,
            }), content_type="application/json", **self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        a = Appointment.objects.get(pk=r.json()["id"])
        print("\nPROBE hold without link: due", a.deposit_due_at, "link", repr(a.deposit_payment_link))
        res = process_deposit_holds(self.salon, now=timezone.now() + timezone.timedelta(minutes=21))
        a.refresh_from_db()
        print("PROBE after hold:", res, a.status, a.auto_released,
              list(OutboxEvent.objects.values_list("event_type", flat=True)))
        self.assertEqual(a.status, "cancelled")
        self.assertEqual(a.deposit_payment_link, "")


class CouponOperatorRevenueProbe(Base):
    def test_operator_revenue_ignores_the_coupon(self):
        from apps.marketing.models import Coupon

        Coupon.objects.create(salon=self.salon, code="BUONO20", kind="amount", value=Decimal("20.00"))
        a = self._appt()
        body = {
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "100.00"}
            ]}],
            "payments": [{"method": "cash", "amount": "80.00"}],
            "coupon_code": "BUONO20",
        }
        r = self.client.post(f"/api/sales/checkout/{a.id}", json.dumps(body),
                             content_type="application/json", **self.auth)
        self.assertEqual(r.status_code, 200, r.content)
        all_ = self.client.get("/api/sales/", **self.auth).json()["kpi"]
        mine = self.client.get(f"/api/sales/?operator_id={self.operator.id}", **self.auth).json()["kpi"]
        print("\nPROBE coupon: unfiltered", all_, "operator", mine, "breakdown", r.json()["breakdown"])
        self.assertEqual(Decimal(all_["revenue"]), Decimal("80.00"))
        self.assertEqual(Decimal(mine["revenue"]), Decimal("100.00"))


class LoyaltyPerVisitProbe(Base):
    def test_buying_a_gift_card_is_a_visit(self):
        from apps.marketing.models import LoyaltyAccount, LoyaltyProgram

        LoyaltyProgram.objects.create(salon=self.salon, name="Timbri", type="stamps",
                                      earn_metric="per_visit", earn_ratio=Decimal("1"),
                                      reward_type="coupon_amount", reward_value=Decimal("10"),
                                      threshold=10)
        for _ in range(3):
            body = {"client_id": self.client_obj.id,
                    "blocks": [{"operator_id": None, "lines": [{"line_type": "gift_card", "value": "5.00"}]}],
                    "payments": [{"method": "cash", "amount": "5.00"}]}
            r = self.client.post("/api/sales/pos", json.dumps(body), content_type="application/json", **self.auth)
            self.assertEqual(r.status_code, 200, r.content)
        acc = LoyaltyAccount.objects.get(client=self.client_obj)
        print("\nPROBE per-visit stamps after 3 gift card purchases:", acc.points)
        self.assertEqual(acc.points, 3)
