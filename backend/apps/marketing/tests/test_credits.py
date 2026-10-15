"""Trattamenti già pagati a sedute: carte a trattamento con più sedute e pacchetti venduti.

Una carta «a trattamento» copre un servizio; con `sessions_total` > 1 ne copre
più sedute (pacchetto o trattamenti pagati in anticipo). Ogni riscatto toglie
una seduta e il valore di una seduta dal saldo; l'ultima porta il saldo a zero.
"""

from datetime import timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.catalog.models import Package, PackageItem, Service, ServiceCategory
from apps.core.models import Salon

from ..credits import create_package_credits
from ..gift_cards import create_gift_card, redeem_gift_card
from ..models import GiftCard
from .base import _make_client


class SessionCardTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.mani = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("40")
        )
        self.client_ = _make_client(self.salon)

    def _card(self, value="100", sessions=3, **kwargs):
        return create_gift_card(
            self.salon,
            Decimal(value),
            gift_service=self.mani,
            buyer_client=self.client_,
            recipient_client=self.client_,
            paid=True,
            paid_method="cash",
            kind=GiftCard.Kind.PREPAID,
            sessions=sessions,
            **kwargs,
        )

    def test_defaults_are_one_session_gift(self):
        card = create_gift_card(self.salon, Decimal("50"))
        self.assertEqual(card.kind, GiftCard.Kind.GIFT)
        self.assertEqual((card.sessions_total, card.sessions_left), (1, 1))
        self.assertEqual(card.session_value, Decimal("50"))

    def test_session_value_rounds_down_and_last_session_takes_the_rest(self):
        card = self._card("100", sessions=3)
        self.assertEqual(card.session_value, Decimal("33.33"))
        redeem_gift_card(self.salon, card.code, card.session_value)
        card.refresh_from_db()
        self.assertEqual((card.sessions_left, card.balance), (2, Decimal("66.67")))
        self.assertEqual(card.session_value, Decimal("33.33"))
        redeem_gift_card(self.salon, card.code, card.session_value)
        card.refresh_from_db()
        self.assertEqual(card.session_value, Decimal("33.34"))
        redeem_gift_card(self.salon, card.code, card.session_value)
        card.refresh_from_db()
        self.assertEqual((card.sessions_left, card.balance), (0, Decimal("0.00")))
        self.assertEqual(card.status, GiftCard.Status.REDEEMED)

    def test_last_session_zeroes_the_balance_even_if_charged_less(self):
        card = self._card("80", sessions=2)
        redeem_gift_card(self.salon, card.code, Decimal("40"))
        redeem_gift_card(self.salon, card.code, Decimal("30"))
        card.refresh_from_db()
        self.assertEqual((card.sessions_left, card.balance), (0, Decimal("0.00")))
        self.assertEqual(card.status, GiftCard.Status.REDEEMED)

    def test_single_session_card_keeps_the_old_money_rules(self):
        card = self._card("40", sessions=1)
        redeem_gift_card(self.salon, card.code, Decimal("10"))
        card.refresh_from_db()
        self.assertEqual((card.status, card.balance), (GiftCard.Status.ACTIVE, Decimal("30")))
        redeem_gift_card(self.salon, card.code, Decimal("30"))
        card.refresh_from_db()
        self.assertEqual((card.status, card.sessions_left), (GiftCard.Status.REDEEMED, 0))

    def test_more_sessions_than_left_are_refused(self):
        card = self._card("100", sessions=2)
        with self.assertRaises(HttpError) as caught:
            redeem_gift_card(self.salon, card.code, Decimal("100"), sessions=3)
        self.assertEqual(caught.exception.status_code, 422)
        card.refresh_from_db()
        self.assertEqual((card.sessions_left, card.balance), (2, Decimal("100")))

    def test_two_sessions_in_one_payment(self):
        card = self._card("120", sessions=3)
        redeem_gift_card(self.salon, card.code, Decimal("80"), sessions=2)
        card.refresh_from_db()
        self.assertEqual((card.sessions_left, card.balance), (1, Decimal("40")))

    def test_sessions_need_a_service(self):
        with self.assertRaises(HttpError):
            create_gift_card(self.salon, Decimal("100"), sessions=2)

    def test_zero_value_only_for_a_treatment(self):
        with self.assertRaises(HttpError):
            create_gift_card(self.salon, Decimal("0"))
        free = self._card("0", sessions=2)
        redeem_gift_card(self.salon, free.code, Decimal("0"))
        free.refresh_from_db()
        self.assertEqual(free.sessions_left, 1)
        money = create_gift_card(self.salon, Decimal("30"), paid=True, paid_method="cash")
        with self.assertRaises(HttpError):
            redeem_gift_card(self.salon, money.code, Decimal("0"))

    def test_unknown_kind_is_refused(self):
        with self.assertRaises(HttpError):
            create_gift_card(self.salon, Decimal("10"), kind="abbonamento")


class PackageCreditsTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.mani = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("40")
        )
        self.piedi = Service.objects.create(
            salon=self.salon, category=category, name_it="Pedicure", duration_min=60, price=Decimal("60")
        )
        self.package = Package.objects.create(
            salon=self.salon, name="Mani e piedi", price=Decimal("500"), validity_days=90
        )
        PackageItem.objects.create(package=self.package, service=self.mani, qty=5)
        PackageItem.objects.create(package=self.package, service=self.piedi, qty=5)
        self.client_ = _make_client(self.salon)

    def test_one_card_per_service_with_its_sessions_and_share(self):
        cards = create_package_credits(
            self.salon, package=self.package, client=self.client_, amount=Decimal("400"), paid_method="card"
        )
        self.assertEqual(len(cards), 2)
        mani, piedi = cards
        # listino 5×40 = 200 e 5×60 = 300: il pagato (400) si divide 2/5 e 3/5
        self.assertEqual((mani.gift_service, mani.sessions_total, mani.balance), (self.mani, 5, Decimal("160.00")))
        self.assertEqual((piedi.gift_service, piedi.sessions_total, piedi.balance), (self.piedi, 5, Decimal("240.00")))
        for card in cards:
            self.assertEqual(card.kind, GiftCard.Kind.PACKAGE)
            self.assertEqual(card.package, self.package)
            self.assertEqual(card.recipient_client, self.client_)
            self.assertEqual(card.payment_status, GiftCard.PaymentStatus.PAID)
            self.assertAlmostEqual(
                card.expires_at, timezone.now() + timedelta(days=90), delta=timedelta(minutes=1)
            )
        self.assertEqual(sum(c.balance for c in cards), Decimal("400"))

    def test_shares_always_sum_to_the_amount(self):
        cards = create_package_credits(
            self.salon, package=self.package, client=self.client_, amount=Decimal("99.99")
        )
        self.assertEqual(sum(c.balance for c in cards), Decimal("99.99"))

    def test_free_package_gives_zero_value_sessions(self):
        cards = create_package_credits(self.salon, package=self.package, client=self.client_, amount=0)
        self.assertEqual([c.balance for c in cards], [Decimal("0.00"), Decimal("0.00")])
        redeem_gift_card(self.salon, cards[0].code, Decimal("0"))
        cards[0].refresh_from_db()
        self.assertEqual(cards[0].sessions_left, 4)

    def test_needs_a_client_and_services(self):
        with self.assertRaises(HttpError):
            create_package_credits(self.salon, package=self.package, client=None, amount=Decimal("10"))
        empty = Package.objects.create(salon=self.salon, name="Vuoto", price=Decimal("10"))
        with self.assertRaises(HttpError):
            create_package_credits(self.salon, package=empty, client=self.client_, amount=Decimal("10"))

    def test_no_validity_means_no_expiry(self):
        self.package.validity_days = None
        self.package.save()
        cards = create_package_credits(self.salon, package=self.package, client=self.client_, amount=Decimal("10"))
        self.assertTrue(all(c.expires_at is None for c in cards))
