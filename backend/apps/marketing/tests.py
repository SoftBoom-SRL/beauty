from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import OutboxEvent, Salon

from .models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram
from .services import (
    accrue_loyalty,
    create_gift_card,
    redeem_gift_card,
    send_communication,
    validate_coupon,
)


def _make_client(salon, first_name="Sofia", phone="+393331112233", marketing=True):
    from apps.clients.models import Client  # lazy: app di un altro agente

    return Client.objects.create(
        salon=salon,
        first_name=first_name,
        last_name="Ricci",
        phone=phone,
        consents={"privacy": True, "marketing": marketing, "card_charge": False},
    )


class GiftCardTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_create_gift_card_defaults(self):
        card = create_gift_card(self.salon, Decimal("100"))
        self.assertEqual(len(card.code), 12)
        self.assertEqual(card.balance, Decimal("100"))
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.UNPAID)
        self.assertEqual(card.status, GiftCard.Status.ACTIVE)

    def test_redeem_scales_balance_and_blocks_over_balance(self):
        card = create_gift_card(self.salon, Decimal("100"), paid=True, paid_method="cash")
        redeem_gift_card(self.salon, card.code, Decimal("40"))
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("60"))
        self.assertEqual(card.status, GiftCard.Status.ACTIVE)

        with self.assertRaises(HttpError) as caught:
            redeem_gift_card(self.salon, card.code, Decimal("70"))
        self.assertEqual(caught.exception.status_code, 422)
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("60"))  # saldo intatto

        redeem_gift_card(self.salon, card.code, Decimal("60"))
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("0"))
        self.assertEqual(card.status, GiftCard.Status.REDEEMED)

    def test_redeem_expired_card(self):
        card = create_gift_card(self.salon, Decimal("50"))
        card.expires_at = timezone.now() - timedelta(days=1)
        card.save(update_fields=["expires_at"])
        with self.assertRaises(HttpError) as caught:
            redeem_gift_card(self.salon, card.code, Decimal("10"))
        self.assertEqual(caught.exception.status_code, 422)
        card.refresh_from_db()
        self.assertEqual(card.status, GiftCard.Status.EXPIRED)


class LoyaltyTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = _make_client(self.salon)
        self.program = LoyaltyProgram.objects.create(
            salon=self.salon,
            name="Punti Parlour",
            type=LoyaltyProgram.Type.POINTS,
            earn_metric=LoyaltyProgram.EarnMetric.PER_EURO,
            earn_ratio=Decimal("1"),
            reward_type=LoyaltyProgram.RewardType.COUPON_AMOUNT,
            reward_value=Decimal("10"),
            threshold=80,
            enrollment=LoyaltyProgram.Enrollment.AUTO,
        )

    def _sale(self, total, client=None):
        from apps.sales.models import Sale  # lazy: app di un altro agente

        return Sale.objects.create(
            salon=self.salon, kind="pos", client=client, total=Decimal(total)
        )

    def test_accrue_threshold_creates_loyalty_coupon(self):
        accrue_loyalty(self._sale("100", client=self.client_obj))

        account = LoyaltyAccount.objects.get(program=self.program, client=self.client_obj)
        self.assertEqual(account.points, 20)  # 100 accreditati − 80 di soglia

        coupon = Coupon.objects.get(salon=self.salon, origin=Coupon.Origin.LOYALTY)
        self.assertEqual(coupon.client_id, self.client_obj.id)
        self.assertEqual(coupon.kind, Coupon.Kind.AMOUNT)
        self.assertEqual(coupon.value, Decimal("10"))
        self.assertEqual(len(coupon.code), 8)

        event = OutboxEvent.objects.get(salon=self.salon, event_type="loyalty.reward")
        self.assertEqual(event.payload["coupon_code"], coupon.code)

    def test_accrue_below_threshold_no_coupon(self):
        accrue_loyalty(self._sale("30", client=self.client_obj))
        account = LoyaltyAccount.objects.get(program=self.program, client=self.client_obj)
        self.assertEqual(account.points, 30)
        self.assertFalse(Coupon.objects.exists())

    def test_accrue_noop_without_client(self):
        accrue_loyalty(self._sale("100", client=None))
        self.assertFalse(LoyaltyAccount.objects.exists())
        self.assertFalse(Coupon.objects.exists())

    def test_no_auto_enroll_when_enrollment_request(self):
        self.program.enrollment = LoyaltyProgram.Enrollment.REQUEST
        self.program.save(update_fields=["enrollment"])
        accrue_loyalty(self._sale("100", client=self.client_obj))
        self.assertFalse(LoyaltyAccount.objects.exists())


class CouponTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_validate_coupon_expired(self):
        coupon = Coupon.objects.create(
            salon=self.salon,
            code="ABCD2345",
            kind=Coupon.Kind.AMOUNT,
            value=Decimal("10"),
            expires_at=timezone.now() - timedelta(days=1),
        )
        with self.assertRaises(HttpError) as caught:
            validate_coupon(self.salon, "ABCD2345")
        self.assertEqual(caught.exception.status_code, 422)
        coupon.refresh_from_db()
        self.assertEqual(coupon.status, Coupon.Status.EXPIRED)

    def test_validate_coupon_not_found_and_client_bound(self):
        with self.assertRaises(HttpError) as caught:
            validate_coupon(self.salon, "MANCANTE")
        self.assertEqual(caught.exception.status_code, 404)

        owner = _make_client(self.salon, first_name="Anna", phone="+393334445566")
        other = _make_client(self.salon, first_name="Marta", phone="+393337778899")
        Coupon.objects.create(
            salon=self.salon,
            client=owner,
            code="XYZ98765",
            kind=Coupon.Kind.PERCENT,
            value=Decimal("15"),
        )
        self.assertEqual(validate_coupon(self.salon, "XYZ98765", client=owner).code, "XYZ98765")
        with self.assertRaises(HttpError) as caught:
            validate_coupon(self.salon, "XYZ98765", client=other)
        self.assertEqual(caught.exception.status_code, 422)


class CommunicationTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_send_resolves_labels_and_marketing_consent(self):
        from apps.clients.models import ClientCategory  # lazy: app di un altro agente

        category = ClientCategory.objects.create(
            salon=self.salon, name="VIP", color="#F59E0B", order=0
        )
        with_consent = _make_client(self.salon, first_name="Sofia", phone="+393331112233")
        without_consent = _make_client(
            self.salon, first_name="Marta", phone="+393334445566", marketing=False
        )
        with_consent.categories.add(category)
        without_consent.categories.add(category)

        comm = Communication.objects.create(
            salon=self.salon,
            title="Promo estate",
            body="Sconto 20% su tutti i trattamenti viso",
            audience_type=Communication.AudienceType.LABELS,
            audience=[category.id],
        )
        send_communication(comm)

        comm.refresh_from_db()
        self.assertEqual(comm.status, Communication.Status.SENT)
        self.assertIsNotNone(comm.sent_at)

        event = OutboxEvent.objects.get(salon=self.salon, event_type="communication.send")
        self.assertEqual(event.payload["client_ids"], [with_consent.id])
        self.assertEqual(event.payload["langs"], {str(with_consent.id): with_consent.lang})
        self.assertNotIn("scheduled_at", event.payload)

    def test_send_scheduled_emits_event_immediately(self):
        client = _make_client(self.salon)
        when = timezone.now() + timedelta(days=2)
        comm = Communication.objects.create(
            salon=self.salon,
            title="Auguri",
            body="Buone feste!",
            audience_type=Communication.AudienceType.CLIENTS,
            audience=[client.id],
        )
        send_communication(comm, scheduled_at=when)

        comm.refresh_from_db()
        self.assertEqual(comm.status, Communication.Status.SCHEDULED)
        self.assertIsNone(comm.sent_at)

        event = OutboxEvent.objects.get(salon=self.salon, event_type="communication.send")
        self.assertEqual(event.payload["scheduled_at"], when.isoformat())
        self.assertEqual(event.payload["client_ids"], [client.id])
