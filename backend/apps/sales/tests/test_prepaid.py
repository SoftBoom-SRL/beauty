"""Pacchetti e trattamenti pagati in anticipo venduti in cassa, e le sedute scalate al conto.

Una riga «package» vende un pacchetto di listino: nascono le sedute della
cliente (una carta «package» per servizio, `marketing.credits`). Una riga
«gift_card» con un trattamento e più sedute vende un trattamento già pagato
(«prepaid», per la cliente stessa) o regalato. Al conto, la carta a sedute paga
le righe del suo servizio e ne scala una seduta per riga.
"""

from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.catalog.models import Package, PackageItem, Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.insights.services import kpis
from apps.marketing.gift_cards import create_gift_card
from apps.marketing.models import GiftCard
from apps.staff.models import Operator
from common.testing import bearer, post_json

from ..models import Sale, SaleLine
from ..reports import today_summary


class PrepaidTestBase(TestCase):
    """Pacchetto «Mani e piedi» (5 manicure da 40 e 5 pedicure da 60) a 450 €."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa di prova", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = bearer(user, self.salon)
        self.sofia = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.manicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("40.00")
        )
        self.pedicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Pedicure", duration_min=60, price=Decimal("60.00")
        )
        self.package = Package.objects.create(
            salon=self.salon, name="Mani e piedi", price=Decimal("450.00"), validity_days=180
        )
        PackageItem.objects.create(package=self.package, service=self.manicure, qty=5)
        PackageItem.objects.create(package=self.package, service=self.pedicure, qty=5)

    def _pos(self, lines, paid, client="sofia", **body):
        payments = [{"method": "card", "amount": paid}] if Decimal(paid) else []
        return post_json(self.client, "/api/sales/pos", {
            "client_id": self.sofia.id if client == "sofia" else client,
            "blocks": [{"operator_id": self.giulia.id, "lines": lines}],
            "payments": payments,
            **body,
        }, **self.auth)

    def _package_line(self, **extra):
        return {"line_type": "package", "package_id": self.package.id, "qty": 1, **extra}


class PackageLineTests(PrepaidTestBase):
    def test_a_package_line_creates_the_sessions_of_the_client(self):
        res = self._pos([self._package_line()], "450.00")
        self.assertEqual(res.status_code, 200, res.content)
        sale = Sale.objects.get()
        line = sale.lines.get()
        # senza prezzo vale il listino del pacchetto
        self.assertEqual((line.line_type, line.package, line.amount), ("package", self.package, Decimal("450.00")))
        self.assertEqual(res.json()["lines"][0]["package_name"], "Mani e piedi")
        cards = list(GiftCard.objects.filter(salon=self.salon).order_by("id"))
        self.assertEqual(len(cards), 2)
        for card, service in zip(cards, (self.manicure, self.pedicure)):
            self.assertEqual(card.kind, GiftCard.Kind.PACKAGE)
            self.assertEqual((card.gift_service, card.sessions_total, card.sessions_left), (service, 5, 5))
            self.assertEqual((card.recipient_client, card.package, card.package_line), (self.sofia, self.package, line))
            self.assertEqual(card.paid_method, "card")
            self.assertIsNotNone(card.expires_at)
        # le sedute valgono esattamente quanto pagato (listino 200 + 300: 180 e 270)
        self.assertEqual([c.balance for c in cards], [Decimal("180.00"), Decimal("270.00")])

    def test_two_packages_are_two_lines_and_the_discount_counts(self):
        res = self._pos([self._package_line(qty=2, discount_pct=10)], "810.00")
        self.assertEqual(res.status_code, 200, res.content)
        lines = list(SaleLine.objects.filter(line_type="package").order_by("id"))
        self.assertEqual([(line.qty, line.amount) for line in lines], [(1, Decimal("405.00"))] * 2)
        cards = GiftCard.objects.filter(kind=GiftCard.Kind.PACKAGE)
        self.assertEqual(cards.count(), 4)
        self.assertEqual(sum(c.balance for c in cards), Decimal("810.00"))
        self.assertEqual({c.package_line_id for c in cards}, {line.id for line in lines})

    def test_a_package_given_as_a_present_has_zero_value_sessions(self):
        res = self._pos([self._package_line(is_gift=True)], "0")
        self.assertEqual(res.status_code, 200, res.content)
        cards = GiftCard.objects.filter(kind=GiftCard.Kind.PACKAGE)
        self.assertEqual([c.balance for c in cards], [Decimal("0.00"), Decimal("0.00")])
        self.assertEqual([c.sessions_left for c in cards], [5, 5])

    def test_a_package_needs_a_client(self):
        res = self._pos([self._package_line()], "450.00", client=None)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertIn("cliente", res.json()["detail"])
        self.assertFalse(Sale.objects.exists())
        self.assertFalse(GiftCard.objects.exists())

    def test_only_packages_of_the_salon_still_on_sale(self):
        self.package.active = False
        self.package.save()
        res = self._pos([self._package_line()], "450.00")
        self.assertEqual(res.status_code, 422, res.content)
        self.assertIn("non è più in vendita", res.json()["detail"])
        other = Salon.objects.create(name="Altro", slug="altro")
        foreign = Package.objects.create(salon=other, name="Altrui", price=Decimal("10.00"))
        res = self._pos([{"line_type": "package", "package_id": foreign.id}], "10.00")
        self.assertEqual(res.status_code, 404, res.content)
        res = self._pos([{"line_type": "package", "unit_price": "10.00"}], "10.00")
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Sale.objects.exists())

    def test_the_packages_sold_are_in_the_summary_and_in_the_insights(self):
        self._pos([self._package_line()], "450.00")
        self.assertEqual(today_summary(self.salon)["package_sold"], Decimal("450.00"))
        today = timezone.localdate()
        self.assertEqual(kpis(self.salon, "month", date_from=today, date_to=today)["package_sold"], Decimal("450.00"))


class PrepaidTreatmentTests(PrepaidTestBase):
    def _treatment(self, **extra):
        return {
            "line_type": "gift_card", "value": "180.00", "gift_service_id": self.manicure.id,
            "sessions": 5, "kind": "prepaid", **extra,
        }

    def test_a_prepaid_treatment_is_the_clients_own_card(self):
        res = self._pos([self._treatment()], "180.00")
        self.assertEqual(res.status_code, 200, res.content)
        card = GiftCard.objects.get()
        self.assertEqual(card.kind, GiftCard.Kind.PREPAID)
        self.assertEqual((card.buyer_client, card.recipient_client), (self.sofia, self.sofia))
        self.assertEqual((card.gift_service, card.sessions_total, card.balance), (self.manicure, 5, Decimal("180.00")))
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.PAID)
        self.assertEqual(SaleLine.objects.get().gift_card, card)

    def test_a_treatment_given_as_a_present_goes_to_someone_else(self):
        res = self._pos([self._treatment(kind="gift", recipient_name="Giada", sessions=1, value="40.00")], "40.00")
        self.assertEqual(res.status_code, 200, res.content)
        card = GiftCard.objects.get()
        self.assertEqual((card.kind, card.recipient_client, card.recipient_name), ("gift", None, "Giada"))
        self.assertEqual(card.gift_service, self.manicure)

    def test_a_prepaid_treatment_needs_a_client(self):
        res = self._pos([self._treatment()], "180.00", client=None)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(GiftCard.objects.exists())

    def test_sessions_need_a_treatment_and_the_kind_must_be_known(self):
        res = self._pos([{"line_type": "gift_card", "value": "100.00", "sessions": 3}], "100.00")
        self.assertEqual(res.status_code, 422, res.content)
        res = self._pos([self._treatment(kind="package")], "180.00")
        self.assertEqual(res.status_code, 422, res.content)
        other = Salon.objects.create(name="Altro", slug="altro")
        foreign = Service.objects.create(
            salon=other, category=ServiceCategory.objects.create(salon=other, name_it="Altro"),
            name_it="Altrui", duration_min=30, price=Decimal("10.00"),
        )
        res = self._pos([self._treatment(gift_service_id=foreign.id)], "180.00")
        self.assertEqual(res.status_code, 404, res.content)
        self.assertFalse(GiftCard.objects.exists())


class PayingWithSessionsTests(PrepaidTestBase):
    """Al conto la carta a sedute paga le righe del suo servizio, una seduta per riga."""

    def setUp(self):
        super().setUp()
        self.card = create_gift_card(
            self.salon, Decimal("180.00"), gift_service=self.manicure, buyer_client=self.sofia,
            recipient_client=self.sofia, paid=True, paid_method="cash", kind=GiftCard.Kind.PREPAID, sessions=5,
        )

    def _pay_with_card(self, lines, amount, sessions):
        return self._pos(lines, "0", payments=[
            {"method": "gift_card", "amount": amount, "gift_card_code": self.card.code, "sessions": sessions},
        ])

    def test_two_lines_of_the_treatment_take_two_sessions(self):
        line = {"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": "36.00"}
        res = self._pay_with_card([line, line], "72.00", 2)
        self.assertEqual(res.status_code, 200, res.content)
        self.card.refresh_from_db()
        self.assertEqual((self.card.sessions_left, self.card.balance), (3, Decimal("108.00")))
        self.assertEqual(Sale.objects.get().payments.get().gift_card, self.card)
        summary = today_summary(self.salon)
        # il trattamento era già pagato: venduto 72, ma in cassa oggi non entra niente
        self.assertEqual((summary["total"], summary["gift_card_redeemed"]), (Decimal("72.00"), Decimal("72.00")))
        self.assertEqual(summary["cash_in"], Decimal("0.00"))

    def test_more_sessions_than_left_are_refused(self):
        line = {"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": "36.00"}
        res = self._pay_with_card([line] * 6, "216.00", 6)
        self.assertEqual(res.status_code, 422, res.content)
        self.card.refresh_from_db()
        self.assertEqual(self.card.sessions_left, 5)
        self.assertFalse(Sale.objects.exists())

    def test_the_last_session_empties_the_card(self):
        line = {"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": "36.00"}
        res = self._pay_with_card([line] * 5, "180.00", 5)
        self.assertEqual(res.status_code, 200, res.content)
        self.card.refresh_from_db()
        self.assertEqual((self.card.sessions_left, self.card.balance, self.card.status), (0, Decimal("0.00"), "redeemed"))

    def test_a_session_of_a_free_package_is_paid_with_zero_euros(self):
        """Pacchetto in omaggio: la seduta vale 0, il conto è 0, ma la carta va scalata.

        Il pagamento da 0 € con la gift card non va scartato: è l'unico modo
        di togliere la seduta fatta (lo ammette solo una carta a trattamento).
        """
        free = create_gift_card(
            self.salon, Decimal("0"), gift_service=self.manicure, buyer_client=self.sofia,
            recipient_client=self.sofia, paid=True, paid_method="cash", kind=GiftCard.Kind.PACKAGE, sessions=5,
        )
        line = {"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": "0.00"}
        res = self._pos([line], "0", payments=[
            {"method": "gift_card", "amount": "0.00", "gift_card_code": free.code},
        ])
        self.assertEqual(res.status_code, 200, res.content)
        free.refresh_from_db()
        self.assertEqual((free.sessions_left, free.balance), (4, Decimal("0.00")))
        payment = Sale.objects.get().payments.get()
        self.assertEqual((payment.amount, payment.gift_card), (Decimal("0.00"), free))
