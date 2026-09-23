"""Caccia del 22/09 — fedeltà: timbri, visite, premi spesi, iscrizione staff.

07-01/14-01 (timbri per euro), 05-19/07-08 (gift card come visita), 07-09
(premio speso che fa punti), 07-10 (servizio omaggio a 0 €), 07-13 (iscrizione
«Su richiesta»), 07-06/14-06 (pagine stabili dei conti).
"""

import json
from decimal import Decimal
from importlib import import_module

from django.apps import apps as django_apps
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext

from apps.core.models import ActivityLog, Salon
from common.auth import create_staff_tokens

from .models import Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram
from .services import accrue_loyalty, create_gift_card


def _client(salon, first_name="Sofia", phone="+393331112233"):
    from apps.clients.models import Client

    return Client.objects.create(
        salon=salon, first_name=first_name, last_name="Ricci", phone=phone,
        consents={"privacy": True, "marketing": True, "card_charge": False},
    )


class _Base(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User
        from apps.catalog.models import Service, ServiceCategory

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=self.owner, salon=self.salon, is_owner=True)
        self.auth = self._auth(self.owner)
        self.client_obj = _client(self.salon)
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.piega = Service.objects.create(
            salon=self.salon, category=category, name_it="Piega",
            duration_min=45, price=Decimal("45.00"),
        )
        self.manicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure",
            duration_min=30, price=Decimal("30.00"),
        )

    def _auth(self, user):
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _staff(self, email, scopes):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email=email, password="segretissima")
        role = Role.objects.create(salon=self.salon, name=email, scopes=scopes)
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return self._auth(user)

    def _post(self, url, body, auth=None):
        return self.client.post(
            url, data=json.dumps(body), content_type="application/json", **(auth or self.auth)
        )

    def _program(self, **fields):
        defaults = {
            "salon": self.salon, "name": "Tessera", "threshold": 100,
            "reward_type": "coupon_amount", "reward_value": Decimal("10"),
        }
        defaults.update(fields)
        return LoyaltyProgram.objects.create(**defaults)

    def _sell(self, lines, payments, coupon_code=""):
        from apps.sales.services import finalize_sale

        return finalize_sale(
            self.salon, kind="pos", client=self.client_obj,
            blocks=[{"lines": lines}], payments=payments, coupon_code=coupon_code,
        )

    def _service_line(self, service):
        return {"line_type": "service", "service_id": service.id,
                "unit_price": str(service.price), "qty": 1}

    def _points(self, program):
        account = LoyaltyAccount.objects.filter(program=program, client=self.client_obj).first()
        return account.points if account else 0

    def _reward_card(self, service=None, value=None):
        """Carta premio come la emette _issue_reward (pagata, metodo «loyalty»)."""
        return create_gift_card(
            self.salon, value or service.price, gift_service=service,
            recipient_client=self.client_obj, recipient_name=self.client_obj.full_name,
            paid=True, paid_method="loyalty", cash_in=False,
        )


class StampsProgramTests(_Base):
    """07-01 + 14-01: una tessera a timbri dà un timbro per visita, mai per euro."""

    PAYLOAD = {
        # Il corpo che LoyaltyEditModal mandava scegliendo «A timbri» sul
        # modello vuoto: la metrica «per euro» restava nascosta nel payload.
        "name": "Tessera pieghe", "type": "stamps", "earn_metric": "per_euro",
        "earn_ratio": "1.00", "reward_type": "coupon_amount", "reward_value": "10.00",
        "reward_service_id": None, "threshold": 10, "enrollment": "auto",
        "points_expiry_months": 0, "bonus": {}, "color": "#6366F1", "active": True,
    }

    def test_stamps_per_euro_is_refused_by_the_api(self):
        res = self._post("/api/marketing/loyalty-programs", self.PAYLOAD)
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(LoyaltyProgram.objects.filter(salon=self.salon).exists())

    def test_stamps_per_euro_is_refused_on_update_too(self):
        program = self._program(type="stamps", earn_metric="per_visit", threshold=10)
        res = self.client.put(
            f"/api/marketing/loyalty-programs/{program.id}",
            data=json.dumps(self.PAYLOAD), content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        program.refresh_from_db()
        self.assertEqual(program.earn_metric, "per_visit")

    def test_a_stamps_card_per_visit_gives_one_stamp_for_a_45_euro_visit(self):
        res = self._post(
            "/api/marketing/loyalty-programs",
            {**self.PAYLOAD, "earn_metric": "per_visit", "earn_ratio": "3.00"},
        )
        self.assertEqual(res.status_code, 200, res.content)
        # Il rapporto per i timbri non si sceglie: resta 1, e la scheda lo dice.
        self.assertEqual(Decimal(res.json()["earn_ratio"]), Decimal("1"))
        self._sell([self._service_line(self.piega)], [{"method": "cash", "amount": "45.00"}])
        program = LoyaltyProgram.objects.get(pk=res.json()["id"])
        self.assertEqual(self._points(program), 1)
        self.assertFalse(Coupon.objects.filter(salon=self.salon, origin="loyalty").exists())

    def test_a_stamps_program_saved_per_euro_elsewhere_still_counts_visits(self):
        """Programmi scritti da un'altra via (admin, dati vecchi): mai un timbro per euro."""
        program = self._program(
            type="stamps", earn_metric="per_euro", earn_ratio=Decimal("1"), threshold=10
        )
        self._sell([self._service_line(self.piega)], [{"method": "cash", "amount": "45.00"}])
        self.assertEqual(self._points(program), 1)
        self.assertFalse(Coupon.objects.filter(salon=self.salon, origin="loyalty").exists())

    def test_stamps_per_service_count_services_and_ignore_a_leftover_ratio(self):
        # 0,5 rimasto da «Punti»: floor(0,5 × 2) dava 1 timbro per due servizi.
        program = self._program(
            type="stamps", earn_metric="per_service", earn_ratio=Decimal("0.5"), threshold=10
        )
        self._sell(
            [self._service_line(self.piega), self._service_line(self.manicure)],
            [{"method": "cash", "amount": "75.00"}],
        )
        self.assertEqual(self._points(program), 2)

    def test_points_programs_keep_their_ratio(self):
        program = self._program(type="points", earn_metric="per_euro", earn_ratio=Decimal("2"))
        self._sell([self._service_line(self.piega)], [{"method": "cash", "amount": "45.00"}])
        self.assertEqual(self._points(program), 90)


class StampsMigrationTests(_Base):
    """La migrazione 0004 corregge le tessere a timbri salvate «per euro»."""

    def _migrate(self):
        module = import_module("apps.marketing.migrations.0004_caccia22_marketing_timbri_per_visita")
        module.forwards(django_apps, None)

    def test_broken_stamp_cards_become_per_visit_and_runaway_balances_are_capped(self):
        broken = self._program(
            name="10 timbri = piega", type="stamps", earn_metric="per_euro", threshold=10
        )
        other = _client(self.salon, first_name="Marta", phone="+393334445566")
        third = _client(self.salon, first_name="Giulia", phone="+393337778899")
        runaway = LoyaltyAccount.objects.create(program=broken, client=self.client_obj, points=50)
        at_threshold = LoyaltyAccount.objects.create(program=broken, client=other, points=10)
        below = LoyaltyAccount.objects.create(program=broken, client=third, points=5)
        points = self._program(name="Punti", type="points", earn_metric="per_euro",
                               earn_ratio=Decimal("2"))
        points_account = LoyaltyAccount.objects.create(
            program=points, client=self.client_obj, points=500
        )
        odd_ratio = self._program(name="Timbri servizio", type="stamps",
                                  earn_metric="per_service", earn_ratio=Decimal("2"))
        # I premi già emessi restano dove sono.
        reward = Coupon.objects.create(salon=self.salon, client=self.client_obj, code="PREMIO01",
                                       kind="amount", value=Decimal("10"), origin="loyalty")

        self._migrate()

        broken.refresh_from_db()
        self.assertEqual((broken.earn_metric, broken.earn_ratio), ("per_visit", Decimal("1")))
        for account, expected in ((runaway, 9), (at_threshold, 9), (below, 5)):
            account.refresh_from_db()
            self.assertEqual(account.points, expected)
        points.refresh_from_db()
        points_account.refresh_from_db()
        self.assertEqual((points.earn_metric, points.earn_ratio), ("per_euro", Decimal("2")))
        self.assertEqual(points_account.points, 500)
        odd_ratio.refresh_from_db()
        self.assertEqual((odd_ratio.earn_metric, odd_ratio.earn_ratio), ("per_service", Decimal("1")))
        reward.refresh_from_db()
        self.assertEqual(reward.status, "active")
        log = ActivityLog.objects.get(salon=self.salon, type="loyalty_program.updated")
        self.assertIn("10 timbri = piega", log.summary)
        self.assertEqual(log.payload["capped_accounts"], 2)


class GiftCardOnlySaleTests(_Base):
    """05-19 + 07-08: comprare una gift card al banco non è una visita."""

    def test_a_gift_card_only_sale_gives_no_stamp_and_no_visit_point(self):
        stamps = self._program(type="stamps", earn_metric="per_visit", threshold=10)
        visits = self._program(name="Visite", type="points", earn_metric="per_visit",
                               earn_ratio=Decimal("5"))
        for _ in range(3):
            self._sell([{"line_type": "gift_card", "value": "5.00"}],
                       [{"method": "cash", "amount": "5.00"}])
        self.assertEqual(self._points(stamps), 0)
        self.assertEqual(self._points(visits), 0)

    def test_a_visit_that_also_buys_a_gift_card_still_counts_once(self):
        stamps = self._program(type="stamps", earn_metric="per_visit", threshold=10)
        self._sell(
            [self._service_line(self.piega), {"line_type": "gift_card", "value": "50.00"}],
            [{"method": "cash", "amount": "95.00"}],
        )
        self.assertEqual(self._points(stamps), 1)


class RewardSpentTests(_Base):
    """07-09: il premio speso non fa guadagnare altri punti o timbri."""

    def test_a_free_service_paid_with_the_reward_card_earns_no_points(self):
        points = self._program(type="points", earn_metric="per_euro")
        card = self._reward_card(self.piega)
        self._sell([self._service_line(self.piega)],
                   [{"method": "gift_card", "amount": "45.00", "gift_card_code": card.code}])
        self.assertEqual(self._points(points), 0)

    def test_only_the_money_actually_paid_earns_points(self):
        points = self._program(type="points", earn_metric="per_euro")
        card = self._reward_card(self.piega)
        self._sell(
            [self._service_line(self.piega), self._service_line(self.manicure)],
            [{"method": "gift_card", "amount": "45.00", "gift_card_code": card.code},
             {"method": "cash", "amount": "30.00"}],
        )
        self.assertEqual(self._points(points), 30)

    def test_a_monetary_reward_card_is_not_money_spent_either(self):
        points = self._program(type="points", earn_metric="per_euro")
        card = self._reward_card(value=Decimal("20.00"))
        self._sell([self._service_line(self.piega)],
                   [{"method": "gift_card", "amount": "20.00", "gift_card_code": card.code},
                    {"method": "cash", "amount": "25.00"}])
        self.assertEqual(self._points(points), 25)

    def test_the_free_service_is_not_a_stamp_per_service(self):
        stamps = self._program(type="stamps", earn_metric="per_service", threshold=10)
        card = self._reward_card(self.piega)
        self._sell([self._service_line(self.piega)],
                   [{"method": "gift_card", "amount": "45.00", "gift_card_code": card.code}])
        self.assertEqual(self._points(stamps), 0)
        # Omaggio più un servizio pagato: conta solo quello pagato.
        card = self._reward_card(self.piega)
        self._sell(
            [self._service_line(self.piega), self._service_line(self.manicure)],
            [{"method": "gift_card", "amount": "45.00", "gift_card_code": card.code},
             {"method": "cash", "amount": "30.00"}],
        )
        self.assertEqual(self._points(stamps), 1)

    def test_a_visit_paid_entirely_by_the_reward_is_not_a_stamp_per_visit(self):
        stamps = self._program(type="stamps", earn_metric="per_visit", threshold=10)
        card = self._reward_card(self.piega)
        self._sell([self._service_line(self.piega)],
                   [{"method": "gift_card", "amount": "45.00", "gift_card_code": card.code}])
        self.assertEqual(self._points(stamps), 0)

    def test_a_loyalty_coupon_covering_the_whole_bill_is_not_a_stamp(self):
        stamps = self._program(type="stamps", earn_metric="per_visit", threshold=10)
        coupon = Coupon.objects.create(
            salon=self.salon, client=self.client_obj, code="OMAGGIO1",
            kind="percent", value=Decimal("100"), origin="loyalty",
        )
        self._sell([self._service_line(self.piega)], [], coupon_code=coupon.code)
        self.assertEqual(self._points(stamps), 0)

    def test_a_paid_gift_card_bought_by_someone_else_still_earns(self):
        """Solo i premi sono esclusi: la carta regalata da un'amica è denaro vero."""
        points = self._program(type="points", earn_metric="per_euro")
        card = create_gift_card(self.salon, Decimal("45.00"), recipient_client=self.client_obj,
                                paid=True, paid_method="cash")
        self._sell([self._service_line(self.piega)],
                   [{"method": "gift_card", "amount": "45.00", "gift_card_code": card.code}])
        self.assertEqual(self._points(points), 45)


class FreeServiceZeroPriceTests(_Base):
    """07-10: un servizio omaggio a 0 € non blocca più la cassa della cliente."""

    def test_the_api_refuses_a_zero_price_service_as_reward(self):
        from apps.catalog.models import Service

        free = Service.objects.create(salon=self.salon, category=self.piega.category,
                                      name_it="Consulenza", duration_min=15, price=Decimal("0"))
        res = self._post("/api/marketing/loyalty-programs", {
            "name": "Omaggio", "type": "points", "earn_metric": "per_visit", "threshold": 1,
            "reward_type": "free_service", "reward_service_id": free.id,
        })
        self.assertEqual(res.status_code, 422, res.content)

    def test_a_reward_service_whose_price_dropped_to_zero_does_not_block_the_sale(self):
        program = self._program(type="stamps", earn_metric="per_visit", threshold=1,
                                reward_type="free_service", reward_service=self.manicure,
                                reward_value=Decimal("0"))
        self.manicure.price = Decimal("0")
        self.manicure.save(update_fields=["price"])
        # Prima: 422 «Valore della gift card non valido» e scontrino annullato.
        self._sell([self._service_line(self.piega)], [{"method": "cash", "amount": "45.00"}])
        self.assertFalse(GiftCard.objects.filter(salon=self.salon).exists())
        # I timbri non si consumano per un premio che non si può emettere.
        self.assertEqual(self._points(program), 1)
        self.assertTrue(ActivityLog.objects.filter(
            salon=self.salon, type="loyalty.reward_misconfigured").exists())


class StaffEnrollmentTests(_Base):
    """07-13 (contratto C16): iscrizione dallo staff ai programmi non automatici."""

    def _url(self, program):
        return f"/api/marketing/loyalty-programs/{program.id}/accounts"

    def test_staff_enrolls_a_client_in_an_on_request_program(self):
        program = self._program(enrollment="request", earn_metric="per_euro")
        res = self._post(self._url(program), {"client_id": self.client_obj.id})
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["client_id"], self.client_obj.id)
        self.assertEqual(body["client_name"], self.client_obj.full_name)
        self.assertEqual(body["points"], 0)
        self.assertTrue({"id", "joined_at"} <= set(body))
        listed = self.client.get(self._url(program), **self.auth).json()
        self.assertEqual([row["id"] for row in listed["items"]], [body["id"]])
        # e da qui in poi la cliente matura punti
        self._sell([self._service_line(self.piega)], [{"method": "cash", "amount": "45.00"}])
        self.assertEqual(self._points(program), 45)

    def test_enrolling_twice_is_a_400(self):
        program = self._program(enrollment="paid")
        self.assertEqual(self._post(self._url(program), {"client_id": self.client_obj.id}).status_code, 200)
        again = self._post(self._url(program), {"client_id": self.client_obj.id})
        self.assertEqual(again.status_code, 400, again.content)
        self.assertEqual(LoyaltyAccount.objects.filter(program=program).count(), 1)

    def test_enrollment_needs_the_marketing_scope(self):
        program = self._program(enrollment="request")
        desk = self._staff("desk@parlour.it", ["agenda", "clients", "sales"])
        res = self._post(self._url(program), {"client_id": self.client_obj.id}, auth=desk)
        self.assertEqual(res.status_code, 403, res.content)
        self.assertFalse(LoyaltyAccount.objects.exists())

    def test_a_client_of_another_salon_cannot_be_enrolled(self):
        program = self._program(enrollment="request")
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        stranger = _client(other_salon, phone="+393339990000")
        res = self._post(self._url(program), {"client_id": stranger.id})
        self.assertEqual(res.status_code, 404, res.content)

    def test_a_disabled_program_does_not_take_new_members(self):
        program = self._program(enrollment="request", active=False)
        res = self._post(self._url(program), {"client_id": self.client_obj.id})
        self.assertEqual(res.status_code, 400, res.content)


class AccountsPagingTests(_Base):
    """07-06 + 14-06: il filtro per cliente esiste, e le pagine sono stabili."""

    def test_the_client_filter_returns_only_that_account(self):
        program = self._program()
        other = _client(self.salon, first_name="Marta", phone="+393334445566")
        mine = LoyaltyAccount.objects.create(program=program, client=self.client_obj, points=3)
        LoyaltyAccount.objects.create(program=program, client=other, points=3)
        res = self.client.get(
            f"/api/marketing/loyalty-programs/{program.id}/accounts",
            {"client_id": self.client_obj.id}, **self.auth,
        ).json()
        self.assertEqual([row["id"] for row in res["items"]], [mine.id])

    def test_accounts_with_the_same_points_are_ordered_by_id(self):
        program = self._program()
        # Clienti create in un ordine, conti in un altro: senza spareggio l'ordine
        # dei pari merito lo decide il piano di esecuzione (qui l'indice unico
        # programma+cliente), e fra una pagina e l'altra può cambiare.
        clients = [_client(self.salon, first_name=f"C{i}", phone=f"+39333000000{i}")
                   for i in range(5)]
        accounts = [LoyaltyAccount.objects.create(program=program, client=c, points=4)
                    for c in reversed(clients)]
        top = LoyaltyAccount.objects.create(
            program=program, client=_client(self.salon, first_name="Top", phone="+393330000009"),
            points=9,
        )
        seen = []
        with CaptureQueriesContext(connection) as queries:
            for offset in (0, 2, 4):
                page = self.client.get(
                    f"/api/marketing/loyalty-programs/{program.id}/accounts",
                    {"limit": 2, "offset": offset}, **self.auth,
                ).json()
                seen += [row["id"] for row in page["items"]]
        self.assertEqual(seen, [top.id] + sorted(a.id for a in accounts))
        # SQLite restituisce i pari merito in un ordine fisso anche senza
        # spareggio; PostgreSQL no. Si controlla quindi anche la query.
        ordered = [q["sql"] for q in queries.captured_queries
                   if "marketing_loyaltyaccount" in q["sql"] and "ORDER BY" in q["sql"]]
        self.assertTrue(ordered)
        for sql in ordered:
            self.assertRegex(sql, r'ORDER BY .*"points" DESC, .*"id" ASC')


class AccrueWithoutSaleLinesTests(_Base):
    """Le vendite senza righe (quelle dei test storici) restano visite."""

    def test_a_sale_without_lines_is_still_a_visit(self):
        from apps.sales.models import Sale

        program = self._program(type="points", earn_metric="per_visit", earn_ratio=Decimal("2"))
        accrue_loyalty(Sale.objects.create(salon=self.salon, kind="pos",
                                           client=self.client_obj, total=Decimal("30")))
        self.assertEqual(self._points(program), 2)
