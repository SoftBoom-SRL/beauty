"""Probe temporanei del revisore 07 (marketing). Da cancellare a fine revisione.

Ogni test afferma il comportamento CORRETTO: se fallisce, il difetto è confermato.
"""

import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.core.models import OutboxEvent, Salon
from common.auth import create_client_tokens, create_staff_tokens

from .models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram


def _client(salon, first_name="Sofia", phone="+393331112233", marketing=True):
    from apps.clients.models import Client

    return Client.objects.create(
        salon=salon, first_name=first_name, last_name="Ricci", phone=phone,
        consents={"privacy": True, "marketing": marketing, "card_charge": False},
    )


class _Resp:
    status_code = 200
    text = "ok"


class _Http:
    def post(self, *a, **k):
        return _Resp()

    def close(self):
        pass


class _Base(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User
        from apps.catalog.models import Service, ServiceCategory

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.client_obj = _client(self.salon)
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.service = Service.objects.create(
            salon=self.salon, category=cat, name_it="Piega", duration_min=45, price=Decimal("45.00")
        )

    def _post(self, url, body, auth=None):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **(auth or self.auth))

    def _put(self, url, body):
        return self.client.put(url, data=json.dumps(body), content_type="application/json", **self.auth)

    def _sell_service(self, price="45.00"):
        from apps.sales.services import finalize_sale

        return finalize_sale(
            self.salon, kind="pos", client=self.client_obj,
            blocks=[{"lines": [{"line_type": "service", "service_id": self.service.id,
                                "unit_price": price, "qty": 1}]}],
            payments=[{"method": "cash", "amount": price}],
        )


class StampsProgramProbe(_Base):
    def test_stamps_program_as_the_ui_builds_it_gives_one_stamp_per_visit(self):
        # Payload identico a LoyaltyEditModal.buildPayload() dopo aver scelto
        # «A timbri» sul modello vuoto di LoyaltySub.blank(): il selettore della
        # metrica è nascosto (isPts=false) e resta earn_metric='per_euro'.
        res = self._post("/api/marketing/loyalty-programs", {
            "name": "Tessera pieghe", "type": "stamps", "earn_metric": "per_euro",
            "earn_ratio": "1.00", "reward_type": "coupon_amount", "reward_value": "10.00",
            "reward_service_id": None, "threshold": 10, "enrollment": "auto",
            "points_expiry_months": 0, "bonus": {}, "color": "#6366F1", "active": True,
        })
        self.assertEqual(res.status_code, 200, res.content)
        self._sell_service("45.00")  # una piega da 45 €
        coupons = Coupon.objects.filter(salon=self.salon, origin="loyalty").count()
        account = LoyaltyAccount.objects.get(client=self.client_obj)
        # Atteso: 1 timbro, nessun premio. Osservato: 45 «timbri», 4 buoni da 10 €.
        self.assertEqual((account.points, coupons), (1, 0))


@override_settings(YOURANG_API_URL="https://yourang.invalid/events")
class ScheduledCommunicationProbe(_Base):
    def setUp(self):
        super().setUp()
        self.comm = Communication.objects.create(
            salon=self.salon, title="Promo estate", body="Testo con refuso",
            audience_type="clients", audience=[self.client_obj.id],
        )

    def _deliver_all(self):
        from apps.core.management.commands.flush_outbox import _claim, deliver_event

        for event in OutboxEvent.objects.filter(status="pending").select_related("salon"):
            if _claim(event):
                deliver_event(event, client=_Http())

    def _live_sends(self):
        return OutboxEvent.objects.filter(
            salon=self.salon, event_type="communication.send",
            status__in=["pending", "sending", "sent"],
            payload__communication_id=self.comm.id,
        ).count()

    def test_rescheduling_after_the_worker_delivered_does_not_send_twice(self):
        when = (timezone.now() + timedelta(days=3)).isoformat()
        self.assertEqual(self._post(f"/api/marketing/communications/{self.comm.id}/send", {"scheduled_at": when}).status_code, 200)
        self._deliver_all()  # il worker gira ogni 5 s: l'evento è già da Yourang
        # «Modifica per riprogrammare», come dice la card
        res = self._put(f"/api/marketing/communications/{self.comm.id}", {
            "title": "Promo estate", "body": "Testo corretto", "audience_type": "clients",
            "audience": [self.client_obj.id], "scheduled_at": when,
        })
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._post(f"/api/marketing/communications/{self.comm.id}/send", {"scheduled_at": when}).status_code, 200)
        # Atteso: un solo invio vivo (o un annullamento del primo). Osservato: 2.
        cancels = OutboxEvent.objects.filter(salon=self.salon, event_type__icontains="cancel").count()
        self.assertTrue(self._live_sends() == 1 or cancels >= 1, (self._live_sends(), cancels))

    def test_deleting_after_delivery_tells_yourang(self):
        when = (timezone.now() + timedelta(days=3)).isoformat()
        self._post(f"/api/marketing/communications/{self.comm.id}/send", {"scheduled_at": when})
        self._deliver_all()
        self.assertEqual(self.client.delete(f"/api/marketing/communications/{self.comm.id}", **self.auth).status_code, 200)
        cancels = OutboxEvent.objects.filter(salon=self.salon).exclude(event_type="communication.send").count()
        self.assertGreaterEqual(cancels, 1, "nessun evento di annullamento: l'invio già consegnato parte comunque")

    def test_revocation_after_scheduling_is_honoured(self):
        when = (timezone.now() + timedelta(days=3)).isoformat()
        self._post(f"/api/marketing/communications/{self.comm.id}/send", {"scheduled_at": when})
        client_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        self.assertEqual(self._post("/api/marketing/client/marketing-consent", {"accepted": False}, auth=client_auth).status_code, 200)
        live = OutboxEvent.objects.filter(
            salon=self.salon, event_type="communication.send", status__in=["pending", "sent"]
        )
        still_targeted = [e.id for e in live if self.client_obj.id in (e.payload.get("client_ids") or [])]
        # Atteso: la revoca toglie la cliente dall'invio del giorno dopo. Osservato: resta.
        self.assertEqual(still_targeted, [])


class PerVisitProbe(_Base):
    def test_buying_a_gift_card_at_the_pos_is_not_a_visit(self):
        from apps.sales.services import finalize_sale

        LoyaltyProgram.objects.create(
            salon=self.salon, name="Timbri", type="stamps", threshold=10,
            earn_metric="per_visit", earn_ratio=1, reward_type="coupon_amount", reward_value=10,
        )
        finalize_sale(
            self.salon, kind="pos", client=self.client_obj,
            blocks=[{"lines": [{"line_type": "gift_card", "value": "50.00"}]}],
            payments=[{"method": "cash", "amount": "50.00"}],
        )
        account = LoyaltyAccount.objects.filter(client=self.client_obj).first()
        self.assertEqual(account.points if account else 0, 0)


class FreeServiceRewardProbe(_Base):
    def test_a_free_reward_service_does_not_block_the_checkout(self):
        from apps.catalog.models import Service
        from ninja.errors import HttpError

        free = Service.objects.create(
            salon=self.salon, category=self.service.category, name_it="Consulenza",
            duration_min=15, price=Decimal("0.00"),
        )
        LoyaltyProgram.objects.create(
            salon=self.salon, name="Omaggio", type="stamps", threshold=1,
            earn_metric="per_visit", earn_ratio=1, reward_type="free_service", reward_service=free,
        )
        try:
            self._sell_service("45.00")
        except HttpError as exc:  # 422 «Valore della gift card non valido»
            self.fail(f"checkout bloccato: {exc.status_code} {exc}")


class CouponUpdateRaceProbe(_Base):
    def test_editing_does_not_resurrect_a_coupon_redeemed_meanwhile(self):
        from apps.marketing import api as mapi
        from apps.marketing.services import mark_coupon_redeemed

        coupon = Coupon.objects.create(salon=self.salon, code="ABCD2345", kind="amount", value=Decimal("10"))
        stale = Coupon.objects.get(pk=coupon.pk)  # letto a inizio richiesta PUT
        sale = self._sell_service("45.00")
        self.assertTrue(mark_coupon_redeemed(coupon, sale))  # la cassa lo consuma nel frattempo
        with patch.object(mapi, "salon_get", lambda model, ctx, pk: stale if model is Coupon else model.objects.get(pk=pk)):
            res = self._put(f"/api/marketing/coupons/{coupon.pk}", {"kind": "amount", "value": "10", "expires_at": None})
        coupon.refresh_from_db()
        self.assertEqual(coupon.status, "redeemed", (res.status_code, coupon.status, coupon.sale_id))


class FrontDeskCashProbe(_Base):
    def test_front_desk_can_cash_an_app_gift_card(self):
        from apps.accounts.models import Membership, Role, User
        from apps.marketing.services import create_gift_card

        desk = User.objects.create_user(email="desk@parlour.it", password="segretissima")
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda", "clients", "sales"])
        Membership.objects.create(user=desk, salon=self.salon, role=role)
        desk_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(desk, self.salon)['access']}"}
        card = create_gift_card(self.salon, Decimal("50"), buyer_client=self.client_obj)  # dall'app: da pagare
        res = self._post(f"/api/marketing/gift-cards/{card.id}/mark-paid", {"method": "cash"}, auth=desk_auth)
        self.assertEqual(res.status_code, 200, res.content)


class ExpiredStillActiveProbe(_Base):
    def test_expired_treatment_card_is_not_listed_as_active(self):
        from apps.marketing.services import create_gift_card

        card = create_gift_card(self.salon, Decimal("45"), gift_service=self.service,
                                recipient_client=self.client_obj, paid=True, paid_method="cash")
        card.expires_at = timezone.now() - timedelta(days=2)
        card.save(update_fields=["expires_at"])
        # la stessa query di NewApptModal
        res = self.client.get("/api/marketing/gift-cards", {"client_id": self.client_obj.id,
                              "status": "active", "payment_status": "paid"}, **self.auth).json()
        self.assertEqual([g["code"] for g in res["items"]], [])
