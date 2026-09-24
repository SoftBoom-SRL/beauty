"""Caccia del 22/09 — gift card e coupon: incasso, scadute, codici, portafoglio.

07-04 (incasso dal Front desk), 07-07/13-09/17-09 (contratto C21: scadute fuori
dagli attivi), 10-06 (C21: codici mascherati), 07-05/16-03/17-14/16-07 (C3:
`spendable` nel portafoglio), 07-11/18-07 (modifica coupon su copia vecchia).
"""

import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from apps.core.models import Salon
from common.auth import create_client_tokens, create_staff_tokens

from ..models import Coupon, GiftCard
from ..services import create_gift_card, mark_coupon_redeemed


def _client(salon, first_name="Sofia", phone="+393331112233"):
    from apps.clients.models import Client

    return Client.objects.create(
        salon=salon, first_name=first_name, last_name="Ricci", phone=phone,
        consents={"privacy": True, "marketing": True, "card_charge": False},
    )


class _Base(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = self._auth(owner)
        self.sofia = _client(self.salon)

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

    def _get(self, url, params=None, auth=None):
        res = self.client.get(url, params or {}, **(auth or self.auth))
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()


class FrontDeskCashTests(_Base):
    """07-04: incassare una gift card è della cassa (`sales`), non del marketing."""

    def setUp(self):
        super().setUp()
        self.desk = self._staff("desk@parlour.it", ["agenda", "clients", "sales"])
        self.promo = self._staff("promo@parlour.it", ["marketing"])

    def test_front_desk_cashes_a_card_bought_in_the_app(self):
        from apps.sales.models import Sale

        card = create_gift_card(self.salon, Decimal("50"), buyer_client=self.sofia)  # da pagare
        res = self._post(f"/api/marketing/gift-cards/{card.id}/mark-paid",
                         {"method": "cash"}, auth=self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        card.refresh_from_db()
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.PAID)
        self.assertTrue(Sale.objects.filter(salon=self.salon, lines__gift_card=card).exists())

    def test_front_desk_sells_a_card_bound_to_the_recipient(self):
        daughter = _client(self.salon, first_name="Giulia", phone="+393334445566")
        res = self._post("/api/marketing/gift-cards", {
            "value": "80", "buyer_client_id": self.sofia.id,
            "recipient_client_id": daughter.id, "paid": True, "paid_method": "card",
        }, auth=self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["recipient_client_id"], daughter.id)
        # Chi vende la carta ne vede il codice intero: lo deve consegnare.
        card = GiftCard.objects.get(pk=res.json()["id"])
        self.assertEqual(res.json()["code"], card.code)

    def test_a_card_to_be_paid_later_is_still_a_marketing_matter(self):
        res = self._post("/api/marketing/gift-cards", {"value": "80", "paid": False}, auth=self.desk)
        self.assertEqual(res.status_code, 403, res.content)
        res = self._post("/api/marketing/gift-cards", {"value": "80", "paid": False}, auth=self.promo)
        self.assertEqual(res.status_code, 200, res.content)

    def test_marketing_alone_does_not_take_money(self):
        card = create_gift_card(self.salon, Decimal("50"), buyer_client=self.sofia)
        res = self._post(f"/api/marketing/gift-cards/{card.id}/mark-paid",
                         {"method": "cash"}, auth=self.promo)
        self.assertEqual(res.status_code, 403, res.content)
        res = self._post("/api/marketing/gift-cards",
                         {"value": "80", "paid": True, "paid_method": "cash"}, auth=self.promo)
        self.assertEqual(res.status_code, 403, res.content)
        card.refresh_from_db()
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.UNPAID)


class ExpiredListsTests(_Base):
    """C21: con status=active gli elenchi staff escludono le scadute."""

    def setUp(self):
        from apps.catalog.models import Service, ServiceCategory

        super().setUp()
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.piega = Service.objects.create(salon=self.salon, category=category, name_it="Piega",
                                            duration_min=45, price=Decimal("45.00"))
        past = timezone.now() - timedelta(days=7)
        self.expired = create_gift_card(self.salon, Decimal("45"), gift_service=self.piega,
                                        recipient_client=self.sofia, paid=True, paid_method="cash")
        GiftCard.objects.filter(pk=self.expired.pk).update(expires_at=past)
        self.marked = create_gift_card(self.salon, Decimal("20"), recipient_client=self.sofia,
                                       paid=True, paid_method="cash")
        GiftCard.objects.filter(pk=self.marked.pk).update(status="expired", expires_at=past)
        self.valid = create_gift_card(self.salon, Decimal("45"), gift_service=self.piega,
                                      recipient_client=self.sofia, paid=True, paid_method="cash")
        GiftCard.objects.filter(pk=self.valid.pk).update(
            expires_at=timezone.now() + timedelta(days=30))

    def _cards(self, **params):
        body = self._get("/api/marketing/gift-cards", params)
        return {row["id"]: row["status"] for row in body["items"]}

    def test_an_expired_card_is_not_offered_as_an_active_gift(self):
        # La stessa richiesta di NewApptModal per i regali della cliente.
        active = self._cards(client_id=self.sofia.id, status="active", payment_status="paid")
        self.assertEqual(active, {self.valid.id: "active"})

    def test_expired_cards_are_listed_under_expired_and_shown_as_such(self):
        self.assertEqual(self._cards(status="expired"),
                         {self.expired.id: "expired", self.marked.id: "expired"})
        self.assertEqual(self._cards()[self.expired.id], "expired")

    def test_the_same_holds_for_coupons(self):
        past = timezone.now() - timedelta(days=1)
        stale = Coupon.objects.create(salon=self.salon, client=self.sofia, code="SCADUTO1",
                                      kind="amount", value=Decimal("10"), expires_at=past)
        fresh = Coupon.objects.create(salon=self.salon, client=self.sofia, code="VALIDO01",
                                      kind="amount", value=Decimal("10"))
        active = self._get("/api/marketing/coupons", {"status": "active"})["items"]
        self.assertEqual([row["id"] for row in active], [fresh.id])
        expired = self._get("/api/marketing/coupons", {"status": "expired"})["items"]
        self.assertEqual([(row["id"], row["status"]) for row in expired], [(stale.id, "expired")])


class CodeMaskingTests(_Base):
    """10-06 (C21): i codici sono al portatore, li legge intero solo marketing o cassa."""

    def setUp(self):
        super().setUp()
        self.card = create_gift_card(self.salon, Decimal("100"), recipient_client=self.sofia,
                                     paid=True, paid_method="cash")
        self.coupon = Coupon.objects.create(salon=self.salon, client=self.sofia, code="ABCD2345",
                                            kind="amount", value=Decimal("10"))
        self.operator = self._staff("op@parlour.it", ["agenda", "clients"])

    def test_an_operator_without_marketing_or_sales_sees_masked_codes(self):
        cards = self._get("/api/marketing/gift-cards", auth=self.operator)["items"]
        self.assertEqual(cards[0]["code"], "••••" + self.card.code[-4:])
        coupons = self._get("/api/marketing/coupons", auth=self.operator)["items"]
        self.assertEqual(coupons[0]["code"], "••••2345")
        # il resto della riga resta leggibile
        self.assertEqual(Decimal(cards[0]["balance"]), Decimal("100"))

    def test_masked_viewers_cannot_probe_codes_through_the_search(self):
        piece = self.card.code[2:6]
        self.assertEqual(
            self._get("/api/marketing/gift-cards", {"q": piece}, auth=self.operator)["items"], [])
        self.assertEqual(
            self._get("/api/marketing/coupons", {"q": "CD23"}, auth=self.operator)["items"], [])
        # per nome la ricerca funziona ancora
        by_name = self._get("/api/marketing/coupons", {"q": "Sofia"}, auth=self.operator)["items"]
        self.assertEqual([row["id"] for row in by_name], [self.coupon.id])

    def test_marketing_sales_and_owner_read_the_full_code(self):
        for auth in (self.auth, self._staff("promo@parlour.it", ["marketing"]),
                     self._staff("desk@parlour.it", ["sales"])):
            self.assertEqual(self._get("/api/marketing/gift-cards", auth=auth)["items"][0]["code"],
                             self.card.code)
            self.assertEqual(self._get("/api/marketing/coupons", auth=auth)["items"][0]["code"],
                             self.coupon.code)
        found = self._get("/api/marketing/gift-cards", {"q": self.card.code[2:6]})["items"]
        self.assertEqual([row["id"] for row in found], [self.card.id])

    def test_the_client_still_reads_her_own_codes_in_the_app(self):
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.sofia)['access']}"}
        wallet = self._get("/api/marketing/client/wallet", auth=auth)
        self.assertEqual([c["code"] for c in wallet["gift_cards"]], [self.card.code])
        self.assertEqual([c["code"] for c in wallet["coupons"]], [self.coupon.code])


class WalletSpendableTests(_Base):
    """C3: `spendable` = spendibile da questa cliente in salone, come gift_index."""

    def setUp(self):
        super().setUp()
        self.mother = _client(self.salon, first_name="Anna", phone="+393334445566")

    def _wallet(self, client):
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client)['access']}"}
        return {c["id"]: c["spendable"]
                for c in self._get("/api/marketing/client/wallet", auth=auth)["gift_cards"]}

    def test_the_spendable_flag_follows_the_recipient_rule(self):
        for_herself = create_gift_card(self.salon, Decimal("30"), buyer_client=self.mother,
                                       paid=True, paid_method="cash")
        for_daughter = create_gift_card(self.salon, Decimal("50"), buyer_client=self.mother,
                                        recipient_client=self.sofia, paid=True, paid_method="cash")
        for_maria = create_gift_card(self.salon, Decimal("40"), buyer_client=self.mother,
                                     recipient_name="Maria", paid=True, paid_method="cash")
        unpaid = create_gift_card(self.salon, Decimal("60"), buyer_client=self.mother)
        reward = create_gift_card(self.salon, Decimal("45"), recipient_client=self.mother,
                                  recipient_name=self.mother.full_name, paid=True,
                                  paid_method="loyalty", cash_in=False)
        self.assertEqual(self._wallet(self.mother), {
            for_herself.id: True,
            for_daughter.id: False,   # il credito è della figlia
            for_maria.id: False,      # «per Maria»: non è della compratrice
            unpaid.id: False,         # da pagare in salone
            reward.id: True,
        })
        self.assertEqual(self._wallet(self.sofia), {for_daughter.id: True})


class CouponUpdateRaceTests(_Base):
    """07-11 + 18-07: la modifica non resuscita un coupon consumato nel frattempo."""

    def _sale(self):
        from apps.sales.models import Sale

        return Sale.objects.create(salon=self.salon, kind="pos", client=self.sofia,
                                   total=Decimal("45"))

    def test_editing_does_not_resurrect_a_coupon_redeemed_meanwhile(self):
        from apps.marketing import api as marketing_api

        coupon = Coupon.objects.create(salon=self.salon, code="ABCD2345", kind="amount",
                                       value=Decimal("10"))
        stale = Coupon.objects.get(pk=coupon.pk)  # letto a inizio PUT
        sale = self._sale()
        self.assertTrue(mark_coupon_redeemed(coupon, sale))  # la cassa lo consuma ora

        def stale_get(model, ctx, pk):
            return stale if model is Coupon else model.objects.get(pk=pk)

        with patch.object(marketing_api, "salon_get", stale_get):
            res = self.client.put(
                f"/api/marketing/coupons/{coupon.pk}",
                data=json.dumps({"kind": "amount", "value": "15", "expires_at": None}),
                content_type="application/json", **self.auth,
            )
        self.assertEqual(res.status_code, 422, res.content)
        coupon.refresh_from_db()
        self.assertEqual((coupon.status, coupon.sale_id, coupon.value),
                         ("redeemed", sale.id, Decimal("10")))

    def test_a_normal_edit_still_works(self):
        coupon = Coupon.objects.create(salon=self.salon, code="ABCD2345", kind="amount",
                                       value=Decimal("10"))
        res = self.client.put(
            f"/api/marketing/coupons/{coupon.pk}",
            data=json.dumps({"kind": "percent", "value": "20", "client_id": self.sofia.id}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        coupon.refresh_from_db()
        self.assertEqual((coupon.kind, coupon.value, coupon.client_id, coupon.status),
                         ("percent", Decimal("20"), self.sofia.id, "active"))
