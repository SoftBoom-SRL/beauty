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
from common.auth import create_client_tokens

from ..credits import create_package_credits
from ..gift_cards import create_gift_card, redeem_gift_card
from ..models import GiftCard
from .base import GiftCardTestBase, _make_client


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


class StaffCreditsApiTests(GiftCardTestBase):
    """POST /gift-cards dallo staff: regalo o già pagato, con le sedute di un trattamento."""

    def setUp(self):
        super().setUp()
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.mani = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("40")
        )
        self.anna = _make_client(self.salon, first_name="Anna", phone="+393330009999")

    def _create(self, **body):
        return self._post("/api/marketing/gift-cards", {"value": "1", "paid": False, **body})

    def test_three_prepaid_sessions_are_one_card_worth_the_three_treatments(self):
        from apps.sales.models import Sale

        res = self._create(
            gift_service_id=self.mani.id, recipient_client_id=self.sofia.id,
            kind="prepaid", sessions=3, paid=True, paid_method="cash",
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        # il valore è il listino per le sedute, non quello inviato
        self.assertEqual(Decimal(body["initial_value"]), Decimal("120.00"))
        self.assertEqual(body["kind"], "prepaid")
        self.assertEqual((body["sessions_total"], body["sessions_left"]), (3, 3))
        self.assertEqual(Decimal(body["session_value"]), Decimal("40.00"))
        self.assertIsNone(body["package_id"])
        # già pagato: chi paga e chi farà il trattamento sono la stessa cliente
        self.assertEqual((body["buyer_client_id"], body["recipient_client_id"]), (self.sofia.id, self.sofia.id))
        self.assertEqual(body["recipient_name"], self.sofia.full_name)
        # l'incasso è in cassa, per tutte e tre le sedute
        self.assertEqual(Sale.objects.get(salon=self.salon).total, Decimal("120.00"))

    def test_prepaid_belongs_to_one_client(self):
        res = self._create(gift_service_id=self.mani.id, kind="prepaid")
        self.assertEqual(res.status_code, 422, res.content)
        res = self._create(
            gift_service_id=self.mani.id, kind="prepaid",
            buyer_client_id=self.anna.id, recipient_client_id=self.sofia.id,
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(GiftCard.objects.exists())
        # basta indicarne una: l'altra è la stessa
        res = self._create(gift_service_id=self.mani.id, kind="prepaid", buyer_client_id=self.anna.id)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["recipient_client_id"], self.anna.id)

    def test_a_gift_can_cover_more_sessions(self):
        res = self._create(
            gift_service_id=self.mani.id, kind="gift", sessions=2,
            buyer_client_id=self.anna.id, recipient_client_id=self.sofia.id,
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["kind"], Decimal(body["initial_value"])), ("gift", Decimal("80.00")))
        self.assertEqual((body["buyer_client_id"], body["recipient_client_id"]), (self.anna.id, self.sofia.id))

    def test_sessions_and_kinds_that_the_mask_cannot_create(self):
        refused = [
            {"value": "100", "sessions": 2},                         # sedute senza trattamento
            {"gift_service_id": self.mani.id, "sessions": 0},
            {"gift_service_id": self.mani.id, "sessions": 101},
            {"gift_service_id": self.mani.id, "kind": "package"},    # nasce solo dalla cassa
            {"gift_service_id": self.mani.id, "kind": "abbonamento"},
        ]
        for body in refused:
            with self.subTest(body=body):
                res = self._create(recipient_client_id=self.sofia.id, **body)
                self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(GiftCard.objects.exists())

    def test_a_monetary_credit_already_paid_by_the_client(self):
        res = self._create(value="150", kind="prepaid", recipient_client_id=self.sofia.id)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["kind"], Decimal(body["initial_value"])), ("prepaid", Decimal("150")))
        self.assertIsNone(body["gift_service_id"])


class CreditListAndKpiTests(GiftCardTestBase):
    """Elenco dello staff: filtro per tipo, sedute e pacchetto, KPI coerenti con le sedute."""

    def setUp(self):
        super().setUp()
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.mani = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("40")
        )
        self.package = Package.objects.create(
            salon=self.salon, name="Mani perfette", price=Decimal("150"), validity_days=180
        )
        PackageItem.objects.create(package=self.package, service=self.mani, qty=5)
        self.gift = create_gift_card(self.salon, Decimal("50"), paid=True, paid_method="cash")
        self.prepaid = create_gift_card(
            self.salon, Decimal("120"), gift_service=self.mani, buyer_client=self.sofia,
            recipient_client=self.sofia, paid=True, paid_method="cash",
            kind=GiftCard.Kind.PREPAID, sessions=3,
        )
        [self.sessions] = create_package_credits(
            self.salon, package=self.package, client=self.sofia, amount=Decimal("150"), paid_method="card"
        )

    def _list(self, **params):
        return self._get("/api/marketing/gift-cards", params)

    def _kpi(self, **params):
        kpi = self._list(**params)["kpi"]
        return [Decimal(kpi[k]) for k in ("sold_total", "redeemed_total", "outstanding")]

    def test_the_list_says_kind_sessions_and_package(self):
        rows = {row["id"]: row for row in self._list()["items"]}
        package = rows[self.sessions.id]
        self.assertEqual(package["kind"], "package")
        self.assertEqual((package["sessions_total"], package["sessions_left"]), (5, 5))
        self.assertEqual(Decimal(package["session_value"]), Decimal("30.00"))
        self.assertEqual((package["package_id"], package["package_name"]), (self.package.id, "Mani perfette"))
        # le sedute sono intestate per nome, come le carte della maschera
        self.assertEqual(package["recipient_name"], self.sofia.full_name)
        gift = rows[self.gift.id]
        self.assertEqual((gift["kind"], gift["sessions_total"], gift["package_name"]), ("gift", 1, None))

    def test_filter_by_kind_and_search_by_treatment_or_package(self):
        self.assertEqual([r["id"] for r in self._list(kind="package")["items"]], [self.sessions.id])
        self.assertEqual([r["id"] for r in self._list(kind="prepaid")["items"]], [self.prepaid.id])
        self.assertEqual([r["id"] for r in self._list(kind="gift")["items"]], [self.gift.id])
        self.assertEqual([r["id"] for r in self._list(q="perfette")["items"]], [self.sessions.id])
        found = {r["id"] for r in self._list(q="manicure")["items"]}
        self.assertEqual(found, {self.prepaid.id, self.sessions.id})

    def test_kpis_follow_the_sessions(self):
        self.assertEqual(self._kpi(kind="prepaid"), [Decimal("120"), Decimal("0"), Decimal("120")])
        redeem_gift_card(self.salon, self.prepaid.code, self.prepaid.session_value)
        self.assertEqual(self._kpi(kind="prepaid"), [Decimal("120"), Decimal("40"), Decimal("80")])
        # l'ultima seduta chiude la carta anche se scala meno: tutto riscattato,
        # niente più da onorare
        redeem_gift_card(self.salon, self.prepaid.code, Decimal("30"), sessions=2)
        self.assertEqual(self._kpi(kind="prepaid"), [Decimal("120"), Decimal("120"), Decimal("0")])
        # il pacchetto venduto in cassa conta per quanto è stato pagato
        self.assertEqual(self._kpi(kind="package"), [Decimal("150"), Decimal("0"), Decimal("150")])


class WalletCreditsTests(GiftCardTestBase):
    """Il portafoglio della cliente: trattamenti già pagati con sedute, pacchetto e scadenza."""

    def setUp(self):
        super().setUp()
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.mani = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("40")
        )
        self.package = Package.objects.create(
            salon=self.salon, name="Mani perfette", price=Decimal("150"), validity_days=90
        )
        PackageItem.objects.create(package=self.package, service=self.mani, qty=5)
        self.mother = _make_client(self.salon, first_name="Carla", phone="+393330008888")

    def _wallet(self, client=None):
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client or self.sofia)['access']}"}
        return {c["id"]: c for c in self._get("/api/marketing/client/wallet", auth=auth)["gift_cards"]}

    def test_her_package_sessions_with_the_package_name_and_expiry(self):
        [card] = create_package_credits(
            self.salon, package=self.package, client=self.sofia, amount=Decimal("150")
        )
        redeem_gift_card(self.salon, card.code, card.session_value)
        mine = self._wallet()[card.id]
        self.assertEqual(mine["kind"], "package")
        self.assertEqual((mine["sessions_total"], mine["sessions_left"]), (5, 4))
        self.assertEqual(Decimal(mine["session_value"]), Decimal("30.00"))
        self.assertEqual(mine["package_name"], "Mani perfette")
        self.assertIsNotNone(mine["expires_at"])
        self.assertTrue(mine["spendable"])
        # le sedute le ha pagate lei: nessun «regalo di»
        self.assertEqual(mine["from_name"], "")

    def test_a_free_package_is_still_hers_to_use(self):
        [card] = create_package_credits(self.salon, package=self.package, client=self.sofia, amount=0)
        mine = self._wallet()[card.id]
        self.assertEqual(Decimal(mine["balance"]), Decimal("0.00"))
        self.assertTrue(mine["spendable"])

    def test_who_gave_it_is_said_only_for_a_real_gift(self):
        gift = create_gift_card(
            self.salon, Decimal("40"), gift_service=self.mani, buyer_client=self.mother,
            recipient_client=self.sofia, paid=True, paid_method="cash",
        )
        prepaid = create_gift_card(
            self.salon, Decimal("80"), gift_service=self.mani, buyer_client=self.sofia,
            recipient_client=self.sofia, paid=True, paid_method="cash",
            kind=GiftCard.Kind.PREPAID, sessions=2,
        )
        wallet = self._wallet()
        self.assertEqual(wallet[gift.id]["from_name"], self.mother.full_name)
        self.assertEqual((wallet[prepaid.id]["kind"], wallet[prepaid.id]["from_name"]), ("prepaid", ""))

    def test_used_up_or_expired_sessions_leave_the_wallet(self):
        [card] = create_package_credits(
            self.salon, package=self.package, client=self.sofia, amount=Decimal("150")
        )
        redeem_gift_card(self.salon, card.code, Decimal("150"), sessions=5)
        self.assertEqual(self._wallet(), {})
        [late] = create_package_credits(
            self.salon, package=self.package, client=self.sofia, amount=Decimal("150"),
            expires_at=timezone.now() - timedelta(days=1),
        )
        self.assertNotIn(late.id, self._wallet())


class ConsentWithoutPhoneTests(TestCase):
    """Consenso marketing di una scheda senza telefono: a Yourang solo se il contatto esiste."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _events(self):
        from apps.core.models import OutboxEvent
        from apps.marketing.consent import CONSENT_EVENT

        return OutboxEvent.objects.filter(event_type=CONSENT_EVENT).count()

    def test_no_phone_and_no_yourang_contact_sends_nothing(self):
        from apps.clients.models import Client
        from apps.marketing.consent import marketing_consent_changed

        figlia = Client.objects.create(salon=self.salon, first_name="Giulia")
        marketing_consent_changed(figlia, accepted=False)
        self.assertEqual(self._events(), 0)

    def test_a_known_yourang_contact_is_still_told(self):
        from apps.clients.models import Client
        from apps.marketing.consent import marketing_consent_changed

        ex = Client.objects.create(salon=self.salon, first_name="Bea", yourang_contact_id="yr-1")
        marketing_consent_changed(ex, accepted=False)
        self.assertEqual(self._events(), 1)
        con_numero = _make_client(self.salon, first_name="Anna", phone="+393334445566")
        marketing_consent_changed(con_numero, accepted=True)
        self.assertEqual(self._events(), 2)
