"""Coupon: validazione, consumo una volta sola, elenchi dello staff filtrati per cliente.

Caccia del 22/09: 07-11/18-07 (modifica coupon su copia vecchia).
"""

import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..coupons import mark_coupon_redeemed, validate_coupon
from ..gift_cards import create_gift_card
from ..models import Coupon
from .base import GiftCardTestBase, OwnerTestBase, _make_client


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


class ClientIdFilterApiTests(TestCase):
    """GET /coupons e /gift-cards: filtro opzionale client_id (staff, per singolo cliente)."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager di prova", scopes=["marketing"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        tokens = create_staff_tokens(user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

        self.sofia = _make_client(self.salon, first_name="Sofia", phone="+393331110001")
        self.giulia = _make_client(self.salon, first_name="Giulia", phone="+393331110002")

    def test_list_coupons_filters_by_client_id(self):
        mine = Coupon.objects.create(
            salon=self.salon,
            client=self.sofia,
            code="MINE0001",
            kind=Coupon.Kind.AMOUNT,
            value=Decimal("10"),
        )
        Coupon.objects.create(
            salon=self.salon,
            client=self.giulia,
            code="OTHR0001",
            kind=Coupon.Kind.AMOUNT,
            value=Decimal("5"),
        )
        Coupon.objects.create(
            salon=self.salon,
            code="NOCLI001",
            kind=Coupon.Kind.PERCENT,
            value=Decimal("15"),
        )

        resp = self.client.get("/api/marketing/coupons", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["count"], 3)  # invariato senza il filtro

        resp = self.client.get(
            f"/api/marketing/coupons?client_id={self.sofia.id}", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["items"][0]["id"], mine.id)

    def test_list_gift_cards_filters_by_buyer_or_recipient(self):
        bought = create_gift_card(self.salon, Decimal("50"), buyer_client=self.sofia)
        received = create_gift_card(self.salon, Decimal("30"))
        received.recipient_client = self.sofia
        received.save(update_fields=["recipient_client"])
        create_gift_card(self.salon, Decimal("20"), buyer_client=self.giulia)

        resp = self.client.get("/api/marketing/gift-cards", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(resp.json()["items"]), 3)  # invariato senza il filtro

        resp = self.client.get(
            f"/api/marketing/gift-cards?client_id={self.sofia.id}", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        ids = {item["id"] for item in resp.json()["items"]}
        self.assertEqual(ids, {bought.id, received.id})

    def test_loyalty_accounts_filter_by_client_id(self):
        """Senza il filtro la scheda di una cliente si trovava solo scorrendo
        tutte le pagine dei conti del programma."""
        from ..models import LoyaltyAccount, LoyaltyProgram

        program = LoyaltyProgram.objects.create(salon=self.salon, name="Punti", threshold=100)
        mine = LoyaltyAccount.objects.create(program=program, client=self.sofia, points=40)
        LoyaltyAccount.objects.create(program=program, client=self.giulia, points=10)

        url = f"/api/marketing/loyalty-programs/{program.id}/accounts"
        resp = self.client.get(url, **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(resp.json()["items"]), 2)  # invariato senza il filtro

        resp = self.client.get(f"{url}?client_id={self.sofia.id}", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        items = resp.json()["items"]
        self.assertEqual([item["id"] for item in items], [mine.id])
        self.assertEqual(items[0]["points"], 40)


class CouponApiTests(OwnerTestBase):
    def _create(self, **fields):
        payload = {"kind": "amount", "value": "10"}
        payload.update(fields)
        return self.client.post(
            "/api/marketing/coupons", data=json.dumps(payload),
            content_type="application/json", **self.auth,
        )

    def test_a_coupon_must_discount_something_and_not_more_than_everything(self):
        self.assertEqual(self._create(value="0").status_code, 422)
        self.assertEqual(self._create(value="-20").status_code, 422)   # aumentava il conto
        self.assertEqual(self._create(kind="percent", value="500").status_code, 422)
        self.assertEqual(self._create(value="999999999").status_code, 422)
        self.assertFalse(Coupon.objects.exists())
        self.assertEqual(self._create(kind="percent", value="20").status_code, 200)

    def test_a_coupon_is_consumed_only_once(self):
        coupon = Coupon.objects.create(
            salon=self.salon, code="UNAVOLTA", kind=Coupon.Kind.AMOUNT, value=Decimal("10")
        )
        url = f"/api/marketing/coupons/{coupon.id}/redeem"
        first = self.client.post(url, data="{}", content_type="application/json", **self.auth)
        self.assertEqual(first.status_code, 200, first.content)
        second = self.client.post(url, data="{}", content_type="application/json", **self.auth)
        self.assertEqual(second.status_code, 422, second.content)
        coupon.refresh_from_db()
        self.assertEqual(coupon.status, Coupon.Status.REDEEMED)

    def test_a_coupon_already_redeemed_elsewhere_loses_the_race(self):
        """Il consumo è un UPDATE ... WHERE status='active': se un altro banco
        ha battuto lo stesso codice un istante prima, qui si risponde 422 invece
        di scalarlo una seconda volta."""
        from django.db.models.query import QuerySet

        coupon = Coupon.objects.create(
            salon=self.salon, code="INCORSA1", kind=Coupon.Kind.AMOUNT, value=Decimal("10")
        )
        original_update = QuerySet.update

        def fake_update(qs, **fields):
            # Zero righe aggiornate = qualcun altro l'ha già consumato.
            if qs.model is Coupon and fields.get("status") == Coupon.Status.REDEEMED:
                return 0
            return original_update(qs, **fields)

        with patch.object(QuerySet, "update", fake_update):
            res = self.client.post(
                f"/api/marketing/coupons/{coupon.id}/redeem",
                data="{}", content_type="application/json", **self.auth,
            )
        self.assertEqual(res.status_code, 422, res.content)
        coupon.refresh_from_db()
        self.assertEqual(coupon.status, Coupon.Status.ACTIVE)

    def test_a_named_coupon_does_not_pass_on_an_anonymous_sale(self):
        """Il controllo saltava quando la vendita non aveva cliente — cioè quasi
        sempre al banco: chiunque presentasse il codice di un'altra otteneva lo
        sconto."""
        owner = _make_client(self.salon, first_name="Anna", phone="+393330001111")
        Coupon.objects.create(
            salon=self.salon, client=owner, code="SOLOANNA",
            kind=Coupon.Kind.PERCENT, value=Decimal("15"),
        )
        with self.assertRaises(HttpError) as caught:
            validate_coupon(self.salon, "SOLOANNA")  # vendita anonima
        self.assertEqual(caught.exception.status_code, 422)
        # intestata alla sua cliente passa
        self.assertEqual(validate_coupon(self.salon, "SOLOANNA", client=owner).code, "SOLOANNA")

    def test_a_named_coupon_is_not_tied_to_the_sale_of_another_client(self):
        """Bug sospetti del 24/09, voce 11: il riscatto manuale guarda la cliente della vendita.

        La cassa rifiuta il buono intestato a un'altra (`validate_coupon`), il
        riscatto manuale con `sale_id` no: il buono di Maria risultava usato
        nella vendita di Anna, e lo storico del buono e quello della vendita
        non tornavano più.
        """
        from apps.sales.models import Sale

        maria = _make_client(self.salon, first_name="Maria", phone="+393330002222")
        anna = _make_client(self.salon, first_name="Anna", phone="+393330001111")
        coupon = Coupon.objects.create(
            salon=self.salon, client=maria, code="SOLOMARIA", kind=Coupon.Kind.AMOUNT, value=Decimal("10")
        )
        url = f"/api/marketing/coupons/{coupon.id}/redeem"

        def redeem(sale):
            return self.client.post(
                url, data=json.dumps({"sale_id": sale.id}), content_type="application/json", **self.auth
            )

        of_anna = Sale.objects.create(salon=self.salon, kind="pos", client=anna, total=Decimal("45"))
        res = redeem(of_anna)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], "Coupon riservato a un altro cliente: intestalo alla vendita")
        coupon.refresh_from_db()
        self.assertEqual((coupon.status, coupon.sale_id), (Coupon.Status.ACTIVE, None))
        # la vendita della sua cliente va bene
        of_maria = Sale.objects.create(salon=self.salon, kind="pos", client=maria, total=Decimal("45"))
        res = redeem(of_maria)
        self.assertEqual(res.status_code, 200, res.content)
        coupon.refresh_from_db()
        self.assertEqual((coupon.status, coupon.sale_id), (Coupon.Status.REDEEMED, of_maria.id))

    def test_a_named_coupon_is_not_tied_to_an_anonymous_sale_either(self):
        """Bug sospetti del 24/09, voce 11: come in cassa, anche la vendita senza cliente.

        La cassa rifiuta il buono intestato su una vendita anonima
        (`validate_coupon`): il riscatto manuale con `sale_id` lo accettava, e
        il buono di Maria risultava usato in una vendita che non dice di chi è.
        """
        from apps.sales.models import Sale

        maria = _make_client(self.salon, first_name="Maria", phone="+393330002222")
        coupon = Coupon.objects.create(
            salon=self.salon, client=maria, code="SOLOMARIA", kind=Coupon.Kind.AMOUNT, value=Decimal("10")
        )
        anonymous = Sale.objects.create(salon=self.salon, kind="pos", total=Decimal("45"))
        res = self.client.post(
            f"/api/marketing/coupons/{coupon.id}/redeem", data=json.dumps({"sale_id": anonymous.id}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], "Coupon riservato a un altro cliente: intestalo alla vendita")
        coupon.refresh_from_db()
        self.assertEqual((coupon.status, coupon.sale_id), (Coupon.Status.ACTIVE, None))


class CouponUpdateRaceTests(GiftCardTestBase):
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
