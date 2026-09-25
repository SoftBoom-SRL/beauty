"""Gift card: emissione e riscatto, incasso in cassa, portafoglio della cliente, codici mascherati.

Caccia del 22/09 — gift card: 07-04 (incasso dal Front desk), 07-07/13-09/17-09
(contratto C21: scadute fuori dagli attivi), 10-06 (C21: codici mascherati),
07-05/16-03/17-14/16-07 (C3: `spendable` nel portafoglio).
"""

import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Salon
from common.auth import create_client_tokens, create_staff_tokens
from common.testing import client_bearer, post_json

from ..gift_cards import create_gift_card, redeem_gift_card
from ..models import Coupon, GiftCard
from .base import GiftCardTestBase, OwnerTestBase, StaffRequestsMixin, _client, _make_client


class GiftCardTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_create_gift_card_defaults(self):
        card = create_gift_card(self.salon, Decimal("100"))
        self.assertEqual(len(card.code), 12)
        self.assertEqual(card.balance, Decimal("100"))
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.UNPAID)
        self.assertEqual(card.status, GiftCard.Status.ACTIVE)

    def test_redeem_unpaid_card_is_refused(self):
        card = create_gift_card(self.salon, Decimal("50"))  # dall'app: nasce «da pagare»
        with self.assertRaises(HttpError) as caught:
            redeem_gift_card(self.salon, card.code, Decimal("50"))
        self.assertEqual(caught.exception.status_code, 422)
        self.assertIn("non ancora pagata", str(caught.exception))
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("50"))
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


class GiftCardServiceApiTests(TestCase):
    """POST /gift-cards con gift_service_id: valore = prezzo del servizio."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from apps.catalog.models import Service, ServiceCategory

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager di prova", scopes=["marketing"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        tokens = create_staff_tokens(user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

        category = ServiceCategory.objects.create(salon=self.salon, name_it="Viso")
        self.service = Service.objects.create(
            salon=self.salon,
            category=category,
            name_it="Trattamento viso",
            duration_min=60,
            price=Decimal("75.00"),
        )

    def _post(self, payload):
        return self.client.post(
            "/api/marketing/gift-cards",
            data=json.dumps(payload),
            content_type="application/json",
            **self.auth,
        )

    def test_create_treatment_gift_card_uses_service_price(self):
        # `value` volutamente diverso dal prezzo: dev'essere ignorato.
        resp = self._post({"value": "10", "gift_service_id": self.service.id})
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(Decimal(body["initial_value"]), Decimal("75.00"))
        self.assertEqual(Decimal(body["balance"]), Decimal("75.00"))
        self.assertEqual(body["gift_service_id"], self.service.id)
        self.assertEqual(body["gift_service_name"], "Trattamento viso")

        card = GiftCard.objects.get(id=body["id"])
        self.assertEqual(card.gift_service_id, self.service.id)
        self.assertEqual(card.initial_value, Decimal("75.00"))
        self.assertEqual(card.balance, Decimal("75.00"))

    def test_monetary_gift_card_unaffected(self):
        resp = self._post({"value": "50"})
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(Decimal(body["initial_value"]), Decimal("50"))
        self.assertEqual(Decimal(body["balance"]), Decimal("50"))
        self.assertIsNone(body["gift_service_id"])
        self.assertIsNone(body["gift_service_name"])

        card = GiftCard.objects.get(id=body["id"])
        self.assertIsNone(card.gift_service_id)

    def test_unknown_service_id_404(self):
        resp = self._post({"value": "75", "gift_service_id": 999999})
        self.assertEqual(resp.status_code, 404, resp.content)


class GiftCardFlowTests(StaffRequestsMixin, TestCase):
    """Flusso completo del regalo: chi la compra, chi riceve il credito, dove si
    vede (portafoglio cliente, agenda, scheda) e come entra nei conteggi."""

    def setUp(self):
        from apps.accounts.models import Membership, User
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="owner@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}
        self.buyer = _make_client(self.salon, first_name="Anna", phone="+393330001111")
        self.recipient = _make_client(self.salon, first_name="Sofia", phone="+393330002222")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Piega", duration_min=60, price=Decimal("40.00")
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="B")
        self.operator.services.add(self.service)

    def _client_auth(self, client_obj):
        return client_bearer(client_obj)

    def test_gifted_treatment_reaches_the_recipient_end_to_end(self):
        # 1) il salone vende una gift card «a trattamento», pagata subito
        res = self._post("/api/marketing/gift-cards", {
            "value": "0", "gift_service_id": self.service.id,
            "buyer_client_id": self.buyer.id, "recipient_client_id": self.recipient.id,
            "recipient_name": self.recipient.full_name, "paid": True, "paid_method": "card",
        })
        self.assertEqual(res.status_code, 200, res.content)
        card = res.json()
        # il valore è il prezzo del servizio, non quello inviato
        self.assertEqual(Decimal(card["initial_value"]), Decimal("40.00"))
        self.assertEqual(card["gift_service_name"], "Piega")
        self.assertEqual(card["buyer_name"], self.buyer.full_name)
        self.assertEqual(card["payment_status"], "paid")

        # 2) la destinataria vede il credito nel suo portafoglio, con il trattamento e da chi
        wallet = self.client.get("/api/marketing/client/wallet", **self._client_auth(self.recipient)).json()
        self.assertEqual(len(wallet["gift_cards"]), 1)
        mine = wallet["gift_cards"][0]
        self.assertEqual(Decimal(mine["balance"]), Decimal("40.00"))
        self.assertEqual(mine["gift_service_name"], "Piega")
        self.assertEqual(mine["buyer_name"], self.buyer.full_name)
        self.assertTrue(mine["received"])
        # anche l'acquirente la vede, ma come carta comprata
        bought = self.client.get("/api/marketing/client/wallet", **self._client_auth(self.buyer)).json()["gift_cards"][0]
        self.assertFalse(bought["received"])

        # 3) la destinataria prenota quel trattamento: l'agenda mostra il regalo
        from apps.agenda.services.appointments import create_appointment
        from django.utils import timezone
        import datetime as dt

        day = timezone.localdate() + dt.timedelta(days=3)
        start = timezone.make_aware(dt.datetime.combine(day, dt.time(10, 0)))
        with patch("apps.staff.services.shift_windows", return_value=[(9 * 60, 18 * 60)]):
            appointment = create_appointment(
                self.salon, self.recipient,
                [{"service_id": self.service.id, "operator_id": self.operator.id}], start, via="app",
            )
            day_view = self.client.get("/api/agenda/day", {"date": day.isoformat()}, **self.auth).json()
        out = next(a for row in day_view for a in row["appointments"] if a["id"] == appointment.id)
        self.assertEqual([g["code"] for g in out["gifts"]], [card["code"]])
        self.assertEqual(out["gifts"][0]["service_name"], "Piega")
        self.assertEqual(out["gifts"][0]["from_name"], self.buyer.full_name)

        # 4) checkout con la gift card: saldo azzerato, carta esaurita
        res = self._post(f"/api/sales/checkout/{appointment.id}", {
            "blocks": [{"operator_id": self.operator.id, "lines": [
                {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "40.00"},
            ]}],
            "payments": [{"method": "gift_card", "amount": "40.00", "gift_card_code": card["code"]}],
        })
        self.assertEqual(res.status_code, 200, res.content)
        gc = GiftCard.objects.get(code=card["code"])
        self.assertEqual(gc.balance, Decimal("0.00"))
        self.assertEqual(gc.status, GiftCard.Status.REDEEMED)

        # 5) conteggi: il regalo non conta due volte, ma i soldi della carta ci sono.
        # Prima qui si pretendeva cash_in == 0: era il difetto, non l'invariante.
        # La carta venduta «pagata subito» non generava nessuna vendita, quindi i
        # 40 € pagati con la carta di credito non comparivano da nessuna parte e
        # al riscatto venivano perfino sottratti. Ora l'incasso della carta è una
        # vendita POS da 40 € e il checkout ne vale altri 40, saldati però con
        # denaro già incassato: venduto 80, entrato oggi 40.
        summary = self.client.get("/api/sales/today-summary", **self.auth).json()
        self.assertEqual(Decimal(summary["total"]), Decimal("80.00"))
        self.assertEqual(Decimal(summary["gift_card_sold"]), Decimal("40.00"))
        self.assertEqual(Decimal(summary["gift_card_redeemed"]), Decimal("40.00"))
        self.assertEqual(Decimal(summary["cash_in"]), Decimal("40.00"))

        # 6) la scheda cliente dello staff trova la carta per client_id (acquirente o destinataria)
        listing = self.client.get("/api/marketing/gift-cards", {"client_id": self.recipient.id}, **self.auth).json()
        self.assertEqual([g["code"] for g in listing["items"]], [card["code"]])
        self.assertEqual(
            self.client.get("/api/marketing/gift-cards", {"client_id": self.buyer.id}, **self.auth).json()["items"][0]["code"],
            card["code"],
        )

    def test_unpaid_card_is_not_spendable_and_not_offered_in_the_agenda(self):
        from apps.agenda.presenters import gift_index

        res = self._post("/api/marketing/gift-cards", {
            "value": "0", "gift_service_id": self.service.id,
            "recipient_client_id": self.recipient.id, "recipient_name": self.recipient.full_name, "paid": False,
        })
        self.assertEqual(res.status_code, 200, res.content)
        code = res.json()["code"]
        # non spendibile finché non è incassata
        with self.assertRaises(HttpError) as caught:
            redeem_gift_card(self.salon, code, Decimal("10"))
        self.assertEqual(caught.exception.status_code, 422)
        # e non compare come regalo in agenda
        self.assertEqual(gift_index(self.salon, [self.recipient.id]), {})
        # una volta incassata, entrambe le cose funzionano
        card = GiftCard.objects.get(code=code)
        res = self._post(f"/api/marketing/gift-cards/{card.id}/mark-paid", {"method": "cash"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(gift_index(self.salon, [self.recipient.id])[self.recipient.id]), 1)
        redeem_gift_card(self.salon, code, Decimal("10"))
        card.refresh_from_db()
        self.assertEqual(card.balance, Decimal("30.00"))

    def test_card_without_a_client_stays_code_only(self):
        """Regalo consegnato a mano (solo il nome): nessun portafoglio, vale il codice."""
        from apps.agenda.presenters import gift_index

        res = self._post("/api/marketing/gift-cards", {
            "value": "50", "buyer_client_id": self.buyer.id, "recipient_name": "Zia Carla", "paid": True, "paid_method": "cash",
        })
        self.assertEqual(res.status_code, 200, res.content)
        code = res.json()["code"]
        # l'acquirente la vede (l'ha comprata), ma non è un regalo «a trattamento»
        wallet = self.client.get("/api/marketing/client/wallet", **self._client_auth(self.buyer)).json()
        self.assertEqual([g["code"] for g in wallet["gift_cards"]], [code])
        self.assertIsNone(wallet["gift_cards"][0]["gift_service_id"])
        self.assertEqual(gift_index(self.salon, [self.buyer.id, self.recipient.id]), {})
        # il codice però vale in cassa
        redeem_gift_card(self.salon, code, Decimal("50"))
        self.assertEqual(GiftCard.objects.get(code=code).balance, Decimal("0.00"))


class GiftCardCashInTests(OwnerTestBase):
    """Una gift card venduta «pagata subito» deve entrare in cassa."""

    def _post(self, url, body):
        return post_json(self.client, url, body, **self.auth)

    def test_selling_a_card_already_paid_records_the_sale(self):
        from apps.sales.models import Payment, Sale, SaleLine

        res = self._post(
            "/api/marketing/gift-cards",
            {"value": "40", "paid": True, "paid_method": "cash"},
        )
        self.assertEqual(res.status_code, 200, res.content)
        card = GiftCard.objects.get(id=res.json()["id"])

        sale = Sale.objects.get(salon=self.salon)
        self.assertEqual(sale.total, Decimal("40.00"))
        self.assertEqual(
            SaleLine.objects.get(sale=sale).gift_card_id, card.id
        )
        self.assertEqual(Payment.objects.get(sale=sale).method, Payment.Method.CASH)
        summary = self.client.get("/api/sales/today-summary", **self.auth).json()
        self.assertEqual(Decimal(summary["cash_in"]), Decimal("40.00"))

    def test_an_unpaid_card_records_nothing_until_it_is_cashed(self):
        from apps.sales.models import Sale

        res = self._post("/api/marketing/gift-cards", {"value": "40", "paid": False})
        card_id = res.json()["id"]
        self.assertFalse(Sale.objects.exists())

        res = self._post(f"/api/marketing/gift-cards/{card_id}/mark-paid", {"method": "card"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Sale.objects.get(salon=self.salon).total, Decimal("40.00"))

    def test_cashing_the_same_card_twice_is_refused_and_creates_one_sale(self):
        from apps.sales.models import Sale

        res = self._post("/api/marketing/gift-cards", {"value": "50", "paid": False})
        card_id = res.json()["id"]
        first = self._post(f"/api/marketing/gift-cards/{card_id}/mark-paid", {"method": "cash"})
        self.assertEqual(first.status_code, 200, first.content)
        second = self._post(f"/api/marketing/gift-cards/{card_id}/mark-paid", {"method": "cash"})
        self.assertEqual(second.status_code, 422, second.content)
        self.assertEqual(Sale.objects.filter(salon=self.salon).count(), 1)

    def test_the_payment_method_is_one_of_the_cash_desk(self):
        """Bug sospetti del 24/09, voce 12: il metodo d'incasso della carta è uno di quelli della cassa.

        Passava qualunque stringa: più lunga della colonna (20 caratteri),
        PostgreSQL rifiutava la riga con un 500; corta ma inventata
        («bonifico»), restava sulla carta mentre in cassa il pagamento
        diventava «other».
        """
        from apps.sales.models import Payment, Sale

        for method in ("x" * 21, "bonifico"):
            with self.subTest(method=method):
                res = self._post(
                    "/api/marketing/gift-cards", {"value": "40", "paid": True, "paid_method": method}
                )
                self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(GiftCard.objects.exists())

        card_id = self._post("/api/marketing/gift-cards", {"value": "40", "paid": False}).json()["id"]
        for method in ("x" * 21, "bonifico"):
            with self.subTest(method=method):
                res = self._post(f"/api/marketing/gift-cards/{card_id}/mark-paid", {"method": method})
                self.assertEqual(res.status_code, 422, res.content)
        card = GiftCard.objects.get(pk=card_id)
        self.assertEqual((card.payment_status, card.paid_method), (GiftCard.PaymentStatus.UNPAID, ""))
        self.assertFalse(Sale.objects.exists())

        # Quelli che manda la dashboard (carta, contanti, altro) passano.
        res = self._post(f"/api/marketing/gift-cards/{card_id}/mark-paid", {"method": "other"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Payment.objects.get(sale__salon=self.salon).method, Payment.Method.OTHER)

    def test_a_loyalty_reward_card_is_not_counted_as_money_sold(self):
        """I premi fedeltà nascono «pagati» col metodo loyalty: nessuno li ha
        comprati, non sono ricavi del salone."""
        create_gift_card(self.salon, Decimal("20"), paid=True, paid_method="loyalty")
        create_gift_card(self.salon, Decimal("30"), paid=True, paid_method="cash")
        create_gift_card(self.salon, Decimal("99"), paid=False)  # mai incassata

        kpi = self.client.get("/api/marketing/gift-cards", **self.auth).json()["kpi"]
        self.assertEqual(Decimal(kpi["sold_total"]), Decimal("30.00"))

    def test_expired_and_unpaid_cards_are_not_outstanding_credit(self):
        live = create_gift_card(self.salon, Decimal("30"), paid=True, paid_method="cash")
        dead = create_gift_card(self.salon, Decimal("70"), paid=True, paid_method="cash")
        dead.expires_at = timezone.now() - timedelta(days=1)
        dead.save(update_fields=["expires_at"])
        create_gift_card(self.salon, Decimal("99"), paid=False)

        kpi = self.client.get("/api/marketing/gift-cards", **self.auth).json()["kpi"]
        self.assertEqual(Decimal(kpi["outstanding"]), live.balance)


class ClientWalletTests(TestCase):
    """Il portafoglio mostra solo credito davvero spendibile."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = _make_client(self.salon, first_name="Anna", phone="+393330001111")
        self.friend = _make_client(self.salon, first_name="Sofia", phone="+393330002222")

    def _wallet(self, client_obj):
        from common.auth import create_client_tokens

        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client_obj)['access']}"}
        return self.client.get("/api/marketing/client/wallet", **auth).json()

    def test_an_expired_card_is_not_in_the_wallet(self):
        good = create_gift_card(
            self.salon, Decimal("30"), buyer_client=self.owner, paid=True, paid_method="cash"
        )
        stale = create_gift_card(
            self.salon, Decimal("70"), buyer_client=self.owner, paid=True, paid_method="cash"
        )
        stale.expires_at = timezone.now() - timedelta(days=1)
        stale.save(update_fields=["expires_at"])
        # status resta ACTIVE: EXPIRED si scrive solo al riscatto, per questo
        # la scadenza va filtrata in lettura.
        self.assertEqual(stale.status, GiftCard.Status.ACTIVE)

        codes = [g["code"] for g in self._wallet(self.owner)["gift_cards"]]
        self.assertEqual(codes, [good.code])

    def test_an_unpaid_card_stays_with_the_buyer_and_not_with_the_recipient(self):
        card = create_gift_card(
            self.salon, Decimal("50"), buyer_client=self.owner,
            recipient_client=self.friend, paid=False,
        )
        # chi l'ha comprata la vede (deve andare a pagarla in salone)
        mine = self._wallet(self.owner)["gift_cards"]
        self.assertEqual([g["code"] for g in mine], [card.code])
        self.assertEqual(mine[0]["payment_status"], "unpaid")
        # la destinataria no: sarebbe un credito che la cassa rifiuta
        self.assertEqual(self._wallet(self.friend)["gift_cards"], [])

    def test_an_expired_coupon_is_not_in_the_wallet(self):
        Coupon.objects.create(
            salon=self.salon, client=self.owner, code="SCADUTO1",
            kind=Coupon.Kind.AMOUNT, value=Decimal("10"),
            expires_at=timezone.now() - timedelta(days=1),
        )
        self.assertEqual(self._wallet(self.owner)["coupons"], [])


class ClientGiftCardLimitsTests(TestCase):
    """L'app cliente crea carte che il salone dovrà onorare: servono dei limiti."""

    def setUp(self):
        from common.auth import create_client_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = _make_client(self.salon)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"
        }

    def _buy(self, value, recipient_name=""):
        return self.client.post(
            "/api/marketing/client/gift-cards",
            data=json.dumps({"value": str(value), "recipient_name": recipient_name}),
            content_type="application/json",
            **self.auth,
        )

    def test_an_out_of_scale_value_is_refused(self):
        self.assertEqual(self._buy("99999999.99").status_code, 422)
        self.assertEqual(self._buy("0").status_code, 422)
        self.assertEqual(self._buy("-50").status_code, 422)
        self.assertFalse(GiftCard.objects.exists())
        self.assertEqual(self._buy("50").status_code, 200)

    def test_the_app_cannot_flood_the_salon_with_cards(self):
        from apps.marketing.api import CLIENT_GIFT_CARD_PER_DAY

        for _ in range(CLIENT_GIFT_CARD_PER_DAY):
            self.assertEqual(self._buy("20").status_code, 200)
        self.assertEqual(self._buy("20").status_code, 429)
        self.assertEqual(GiftCard.objects.count(), CLIENT_GIFT_CARD_PER_DAY)


class FrontDeskCashTests(GiftCardTestBase):
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


class ExpiredListsTests(GiftCardTestBase):
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


class CodeMaskingTests(GiftCardTestBase):
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


class WalletSpendableTests(GiftCardTestBase):
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
