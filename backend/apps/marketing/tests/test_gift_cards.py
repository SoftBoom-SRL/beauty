import json
from datetime import timedelta
from decimal import Decimal

from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import OutboxEvent, Salon
from common.auth import create_staff_tokens

from ..models import Communication, Coupon, GiftCard, LoyaltyAccount, LoyaltyProgram
from ..services import (
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
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["marketing"])
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


class ClientIdFilterApiTests(TestCase):
    """GET /coupons e /gift-cards: filtro opzionale client_id (staff, per singolo cliente)."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["marketing"])
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


class GiftCardFlowTests(TestCase):
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

    def _post(self, url, body, auth=None):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **(auth or self.auth))

    def _client_auth(self, client_obj):
        from common.auth import create_client_tokens

        return {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client_obj)['access']}"}

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
        from apps.agenda.services import create_appointment
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
        from apps.agenda.api import gift_index

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
        from apps.agenda.api import gift_index

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


class LoyaltyRewardIssueTests(TestCase):
    """Ogni tipo di premio offerto dall'interfaccia deve essere emettibile.

    Il «servizio omaggio» diventava un coupon da 0 €, senza traccia del servizio:
    la cliente raggiungeva la soglia, perdeva i punti e riceveva un buono che non
    scontava niente.
    """

    def setUp(self):
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure",
            duration_min=30, price=Decimal("30.00"),
        )

    def _sell(self):
        from apps.sales.services import finalize_sale

        return finalize_sale(
            self.salon,
            kind="pos",
            client=self.client_obj,
            blocks=[{"lines": [
                {"line_type": "service", "service_id": self.service.id,
                 "unit_price": "30.00", "qty": 1},
            ]}],
            payments=[{"method": "cash", "amount": "30.00"}],
        )

    def _program(self, **fields):
        return LoyaltyProgram.objects.create(
            salon=self.salon, name="Fedeltà", threshold=1,
            earn_metric="per_visit", earn_ratio=1, **fields,
        )

    def test_a_free_service_reward_issues_a_card_for_that_service(self):
        self._program(reward_type="free_service", reward_service=self.service, reward_value=0)
        self._sell()
        card = GiftCard.objects.get(salon=self.salon)
        self.assertEqual(card.gift_service_id, self.service.id)
        self.assertEqual(card.initial_value, Decimal("30.00"))
        self.assertEqual(card.balance, Decimal("30.00"))
        self.assertEqual(card.recipient_client_id, self.client_obj.id)
        # Pagata: è un premio, non una carta venduta da incassare.
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.PAID)
        self.assertFalse(Coupon.objects.filter(salon=self.salon).exists())

    def test_a_reward_card_is_not_written_down_as_money_taken(self):
        """Le carte premio nascono pagate — è così che il banco le riscatta —
        ma nessuno ha versato quel denaro: il registro attività riportava
        «Incasso gift card €30,00 (loyalty)» per un incasso mai avvenuto."""
        from apps.core.models import ActivityLog

        self._program(reward_type="free_service", reward_service=self.service, reward_value=0)
        self._sell()
        card = GiftCard.objects.get(salon=self.salon)
        self.assertEqual(card.payment_status, GiftCard.PaymentStatus.PAID)
        self.assertFalse(
            ActivityLog.objects.filter(salon=self.salon, type="giftcard.paid").exists()
        )
        # l'emissione resta tracciata, come premio
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="giftcard.created").exists()
        )
        reward = ActivityLog.objects.get(salon=self.salon, type="loyalty.reward")
        self.assertIn(card.code, reward.summary)

    def test_a_gift_card_sold_at_the_till_is_still_written_down_as_money_taken(self):
        from apps.core.models import ActivityLog
        from apps.marketing.services import create_gift_card

        create_gift_card(self.salon, Decimal("40.00"), paid=True, paid_method="cash")
        taken = ActivityLog.objects.get(salon=self.salon, type="giftcard.paid")
        self.assertIn("Incasso gift card", taken.summary)

    def test_a_gift_card_reward_issues_a_card_of_that_value(self):
        self._program(reward_type="gift_card", reward_value=Decimal("20.00"))
        self._sell()
        card = GiftCard.objects.get(salon=self.salon)
        self.assertEqual(card.initial_value, Decimal("20.00"))
        self.assertIsNone(card.gift_service_id)

    def test_a_coupon_reward_still_issues_a_coupon(self):
        self._program(reward_type="coupon_amount", reward_value=Decimal("15.00"))
        self._sell()
        coupon = Coupon.objects.get(salon=self.salon)
        self.assertEqual(coupon.kind, Coupon.Kind.AMOUNT)
        self.assertEqual(coupon.value, Decimal("15.00"))

    def test_a_reward_that_cannot_be_issued_does_not_burn_the_points(self):
        program = self._program(reward_type="free_service", reward_service=None, reward_value=0)
        self._sell()
        self.assertFalse(GiftCard.objects.filter(salon=self.salon).exists())
        self.assertFalse(Coupon.objects.filter(salon=self.salon).exists())
        account = LoyaltyAccount.objects.get(program=program, client=self.client_obj)
        self.assertEqual(account.points, 1)  # il punto resta alla cliente

    def test_the_api_refuses_a_reward_the_till_cannot_honour(self):
        from apps.accounts.models import Membership, User

        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        token = create_staff_tokens(user, self.salon)["access"]
        response = self.client.post(
            "/api/marketing/loyalty-programs",
            json.dumps({
                "name": "Prodotto omaggio", "threshold": 5,
                "reward_type": "free_product", "reward_value": "0",
            }),
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Bearer {token}",
        )
        self.assertEqual(response.status_code, 422, response.content)

    def test_a_single_sale_cannot_issue_an_unbounded_number_of_rewards(self):
        """Tetto ai premi per vendita.

        Con 100 punti per euro e soglia 1, un incasso da 30 € valeva 3.000 premi:
        novemila insert e tremila messaggi WhatsApp mentre la cassiera aspettava.
        Ora se ne emettono al massimo MAX_REWARDS_PER_SALE e i punti avanzati
        restano alla cliente — non si perde niente, arriveranno dopo.
        """
        from ..services import MAX_REWARDS_PER_SALE

        program = self._program(
            reward_type="coupon_amount", reward_value=Decimal("5.00"),
        )
        program.earn_metric = "per_euro"
        program.earn_ratio = Decimal("100")
        program.save(update_fields=["earn_metric", "earn_ratio"])
        self._sell()  # 30 € -> 3000 punti, soglia 1

        self.assertEqual(Coupon.objects.filter(salon=self.salon).count(), MAX_REWARDS_PER_SALE)
        account = LoyaltyAccount.objects.get(program=program, client=self.client_obj)
        self.assertEqual(account.points, 3000 - MAX_REWARDS_PER_SALE)


class LoyaltyConcurrencyTests(TestCase):
    """Il saldo punti si legge e si scrive sotto lock, e l'iscrizione non fa
    esplodere la vendita quando esiste già."""

    def setUp(self):
        from apps.clients.models import Client

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112233"
        )
        self.program = LoyaltyProgram.objects.create(
            salon=self.salon, name="Punti", threshold=100,
            earn_metric=LoyaltyProgram.EarnMetric.PER_EURO, earn_ratio=Decimal("1"),
            reward_type=LoyaltyProgram.RewardType.COUPON_AMOUNT, reward_value=Decimal("10"),
        )

    def _sale(self, total):
        from apps.sales.models import Sale

        return Sale.objects.create(
            salon=self.salon, kind="pos", client=self.client_obj, total=Decimal(total)
        )

    def test_points_are_incremented_in_sql_not_overwritten(self):
        """L'incremento è un UPDATE con F(): una scrittura concorrente avvenuta
        nel frattempo non viene cancellata dal nostro save."""
        accrue_loyalty(self._sale("10"))
        account = LoyaltyAccount.objects.get(program=self.program, client=self.client_obj)
        self.assertEqual(account.points, 10)

        # Qualcun altro accredita 50 punti dopo che la nostra vendita è nata.
        LoyaltyAccount.objects.filter(pk=account.pk).update(points=60)
        accrue_loyalty(self._sale("10"))
        account.refresh_from_db()
        self.assertEqual(account.points, 70)  # 60 + 10, non 20

    def test_enrollment_race_does_not_kill_the_sale(self):
        """Se il conto nasce fra la lettura e la creazione, la vendita prosegue.

        Prima era una create secca: l'IntegrityError sulla unique arrivava dentro
        l'atomic di finalize_sale e la cassiera si vedeva annullare lo scontrino.
        """
        from django.db.models.query import QuerySet

        original_first = QuerySet.first
        raced = {"done": False}

        def fake_first(qs):
            # La prima lettura del conto non lo trova; nel frattempo un'altra
            # cassa lo crea. Con la create secca di prima, l'insert successivo
            # sbatteva sulla unique e portava giù l'intero scontrino.
            if qs.model is LoyaltyAccount and not raced["done"]:
                raced["done"] = True
                LoyaltyAccount.objects.create(program=self.program, client=self.client_obj)
                return None
            return original_first(qs)

        with patch.object(QuerySet, "first", fake_first):
            accrue_loyalty(self._sale("25"))

        self.assertTrue(raced["done"])
        account = LoyaltyAccount.objects.get(program=self.program, client=self.client_obj)
        self.assertEqual(account.points, 25)
        self.assertEqual(
            LoyaltyAccount.objects.filter(program=self.program, client=self.client_obj).count(), 1
        )


class LoyaltyProgramValidationTests(TestCase):
    """I campi del programma fedeltà arrivavano a database senza controlli."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

    def _post(self, **fields):
        payload = {
            "name": "Fedeltà", "threshold": 10,
            "reward_type": "coupon_amount", "reward_value": "10",
        }
        payload.update(fields)
        return self.client.post(
            "/api/marketing/loyalty-programs",
            json.dumps(payload),
            content_type="application/json",
            **self.auth,
        )

    def test_a_valid_program_is_still_accepted(self):
        self.assertEqual(self._post().status_code, 200)

    def test_typos_and_out_of_scale_numbers_are_refused(self):
        # "per_euro " con lo spazio cadeva nel ramo «per servizio» senza dire niente
        self.assertEqual(self._post(earn_metric="per_euro ").status_code, 422)
        self.assertEqual(self._post(type="livelli").status_code, 422)
        # enrollment sbagliato = nessuna iscrizione automatica, punti fermi in silenzio
        self.assertEqual(self._post(enrollment="automatica").status_code, 422)
        # soglia 0 = punti che non diventano mai un premio
        self.assertEqual(self._post(threshold=0).status_code, 422)
        self.assertEqual(self._post(threshold=-1).status_code, 422)
        self.assertEqual(self._post(earn_ratio="1000000").status_code, 422)
        self.assertEqual(self._post(earn_ratio="0").status_code, 422)
        self.assertEqual(self._post(points_expiry_months=99999).status_code, 422)
        self.assertEqual(self._post(color="rosso").status_code, 422)
        self.assertEqual(
            self._post(reward_type="discount_pct", reward_value="500").status_code, 422
        )
        self.assertFalse(LoyaltyProgram.objects.filter(salon=self.salon).exists())


class GiftCardCashInTests(TestCase):
    """Una gift card venduta «pagata subito» deve entrare in cassa."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

    def _post(self, url, body):
        return self.client.post(
            url, data=json.dumps(body), content_type="application/json", **self.auth
        )

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


class MarketingConsentTests(TestCase):
    """GDPR art. 7.3: il consenso dev'essere revocabile come è stato dato."""

    def setUp(self):
        from common.auth import create_client_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = _make_client(self.salon, marketing=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"
        }

    def _set(self, accepted):
        return self.client.post(
            "/api/marketing/client/marketing-consent",
            data=json.dumps({"accepted": accepted}),
            content_type="application/json",
            **self.auth,
        )

    def test_revoking_excludes_the_client_from_the_next_send(self):
        comm = Communication.objects.create(
            salon=self.salon, title="Promo", body="…",
            audience_type=Communication.AudienceType.CLIENTS,
            audience=[self.client_obj.id],
        )
        self.assertEqual(self._set(False).status_code, 200)
        self.client_obj.refresh_from_db()
        self.assertFalse(self.client_obj.consents["marketing"])
        self.assertTrue(self.client_obj.consents["marketing_revoked_at"])

        send_communication(comm)
        event = OutboxEvent.objects.get(salon=self.salon, event_type="communication.send")
        self.assertEqual(event.payload["client_ids"], [])

    def test_the_consent_can_be_given_back(self):
        self._set(False)
        self.assertEqual(self._set(True).status_code, 200)
        self.client_obj.refresh_from_db()
        self.assertTrue(self.client_obj.consents["marketing"])
        self.assertNotIn("marketing_revoked_at", self.client_obj.consents)


class CommunicationScheduleTests(TestCase):
    """Una comunicazione programmata non si rinvia all'infinito, e modificarla o
    eliminarla ferma l'invio in coda."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }
        self.target = _make_client(self.salon)
        self.comm = Communication.objects.create(
            salon=self.salon, title="Promo estate", body="Sconto 20%",
            audience_type=Communication.AudienceType.CLIENTS,
            audience=[self.target.id],
        )

    def _send(self, body):
        return self.client.post(
            f"/api/marketing/communications/{self.comm.id}/send",
            data=json.dumps(body), content_type="application/json", **self.auth,
        )

    def _pending(self):
        # Gli invii annullati restano a registro come «superseded» (caccia del
        # 22/09): qui contano solo quelli che possono ancora partire.
        return OutboxEvent.objects.filter(
            salon=self.salon, event_type="communication.send"
        ).exclude(status=OutboxEvent.Status.SUPERSEDED).count()

    def test_a_scheduled_communication_cannot_be_sent_again(self):
        when = (timezone.now() + timedelta(days=2)).isoformat()
        self.assertEqual(self._send({"scheduled_at": when}).status_code, 200)
        self.assertEqual(self._pending(), 1)
        # Ogni rinvio accodava un invio in più: la stessa promozione arrivava
        # due, tre, dieci volte alla stessa cliente.
        again = self._send({"scheduled_at": when})
        self.assertEqual(again.status_code, 422, again.content)
        self.assertEqual(self._pending(), 1)

    def test_editing_a_scheduled_communication_cancels_the_queued_send(self):
        when = (timezone.now() + timedelta(days=2)).isoformat()
        self._send({"scheduled_at": when})
        self.assertEqual(self._pending(), 1)

        res = self.client.put(
            f"/api/marketing/communications/{self.comm.id}",
            data=json.dumps({
                "title": "Promo autunno", "body": "Sconto 30%",
                "audience_type": "clients", "audience": [self.target.id],
            }),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._pending(), 0)  # il vecchio testo non parte più
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.status, Communication.Status.DRAFT)
        # e ora si può riprogrammare, una volta sola
        self.assertEqual(self._send({"scheduled_at": when}).status_code, 200)
        self.assertEqual(self._pending(), 1)

    def test_deleting_a_communication_cancels_the_queued_send(self):
        when = (timezone.now() + timedelta(days=2)).isoformat()
        self._send({"scheduled_at": when})
        res = self.client.delete(
            f"/api/marketing/communications/{self.comm.id}", **self.auth
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._pending(), 0)

    def test_send_now_wins_over_a_saved_schedule(self):
        """`scheduled_at: null` esplicito = invia adesso, anche se a database
        c'è una data: prima il None veniva rimpiazzato dalla data salvata e
        «Invia subito» era impossibile via API."""
        self.comm.scheduled_at = timezone.now() + timedelta(days=5)
        self.comm.save(update_fields=["scheduled_at"])

        res = self._send({"scheduled_at": None})
        self.assertEqual(res.status_code, 200, res.content)
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.status, Communication.Status.SENT)

    def test_an_invented_audience_type_is_refused(self):
        """Un refuso su «labels» faceva leggere gli id etichetta come id cliente:
        la promozione per le VIP partiva a due persone a caso."""
        res = self.client.post(
            "/api/marketing/communications",
            data=json.dumps({
                "title": "Promo", "body": "…",
                "audience_type": "label", "audience": [1],
            }),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 422, res.content)


class CouponApiTests(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

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
