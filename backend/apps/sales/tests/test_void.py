"""Annullamento di un passaggio cassa chiuso per sbaglio (`POST /api/sales/{id}/void`)."""

import json
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon
from apps.inventory.models import Product, Supplier
from apps.marketing.models import LoyaltyAccount, LoyaltyProgram
from apps.staff.models import Operator
from common.testing import bearer, post_json

from ..models import Payment, Sale


class VoidSaleTests(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner = User.objects.create_user(email="titolare@theparlour.it", password="x" * 10)
        Membership.objects.create(user=self.owner, salon=self.salon, is_owner=True)
        self.auth = bearer(self.owner, self.salon)
        desk = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa di prova", scopes=["sales", "agenda"])
        Membership.objects.create(user=desk, salon=self.salon, role=role)
        self.desk = bearer(desk, self.salon)

        self.sofia = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.manicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("30.00")
        )
        supplier = Supplier.objects.create(salon=self.salon, name="Davines")
        self.shampoo = Product.objects.create(
            salon=self.salon, name="Shampoo", supplier=supplier,
            stock_qty=Decimal("5"), sale_price=Decimal("10.00"),
        )
        self.visit = Appointment.objects.create(
            salon=self.salon, client=self.sofia, operator=self.giulia,
            start=timezone.now() - timezone.timedelta(hours=1), status=Appointment.Status.IN_PROGRESS,
        )
        AppointmentService.objects.create(
            appointment=self.visit, service=self.manicure, operator=self.giulia,
            duration_min=45, price=Decimal("30.00"),
        )

    def _checkout(self, payments=None, extra_lines=()):
        lines = [
            {"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": "30.00"},
            {"line_type": "product", "product_id": self.shampoo.id, "qty": 2, "unit_price": "10.00"},
            *extra_lines,
        ]
        res = post_json(self.client, f"/api/sales/checkout/{self.visit.id}", {
            "blocks": [{"operator_id": self.giulia.id, "lines": lines}],
            "payments": payments or [{"method": "cash", "amount": "50.00"}],
        }, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return Sale.objects.get(pk=res.json()["sale"]["id"])

    def _void(self, sale, auth=None):
        return self.client.post(f"/api/sales/{sale.id}/void", **(auth or self.auth))

    def test_annulla_il_conto_rimette_il_magazzino_e_riapre_la_visita(self):
        sale = self._checkout()
        self.shampoo.refresh_from_db()
        self.assertEqual(self.shampoo.stock_qty, Decimal("3"))
        self.visit.refresh_from_db()
        self.assertEqual(self.visit.status, Appointment.Status.CLOSED)

        res = self._void(sale)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["reopened_appointment_ids"], [self.visit.id])

        self.assertFalse(Sale.objects.filter(pk=sale.id).exists())
        self.assertFalse(Payment.objects.filter(sale_id=sale.id).exists())
        self.shampoo.refresh_from_db()
        self.assertEqual(self.shampoo.stock_qty, Decimal("5"))
        self.visit.refresh_from_db()
        self.assertEqual(self.visit.status, Appointment.Status.IN_PROGRESS)
        # nel registro resta cosa c'era nel conto
        log = ActivityLog.objects.get(salon=self.salon, type="sale.voided")
        self.assertEqual(log.payload["total"], "50.00")
        self.assertEqual([p["method"] for p in log.payload["payments"]], ["cash"])
        self.assertEqual(len(log.payload["lines"]), 2)

        # e il conto si rifà da capo, giusto stavolta
        again = self._checkout(payments=[{"method": "card", "amount": "50.00"}])
        self.assertEqual(again.payments.get().method, "card")

    def test_la_visita_tolta_dall_agenda_torna_visibile(self):
        sale = self._checkout()
        Appointment.objects.filter(pk=self.visit.pk).update(removed_from_agenda_at=timezone.now())
        self.assertEqual(self._void(sale).status_code, 200)
        self.visit.refresh_from_db()
        self.assertIsNone(self.visit.removed_from_agenda_at)

    def test_toglie_i_punti_fedelta_accreditati(self):
        program = LoyaltyProgram.objects.create(
            salon=self.salon, name="Punti", type=LoyaltyProgram.Type.POINTS,
            earn_metric=LoyaltyProgram.EarnMetric.PER_EURO, earn_ratio=Decimal("1"),
            reward_type=LoyaltyProgram.RewardType.COUPON_AMOUNT, reward_value=Decimal("10"),
            threshold=1000, enrollment=LoyaltyProgram.Enrollment.AUTO,
        )
        sale = self._checkout()
        account = LoyaltyAccount.objects.get(program=program, client=self.sofia)
        self.assertEqual(account.points, 50)
        self.assertEqual(self._void(sale).status_code, 200)
        account.refresh_from_db()
        self.assertEqual(account.points, 0)

    def test_vendita_al_banco_senza_appuntamento(self):
        res = post_json(self.client, "/api/sales/pos", {
            "blocks": [{"operator_id": self.giulia.id, "lines": [
                {"line_type": "product", "product_id": self.shampoo.id, "qty": 1, "unit_price": "10.00"},
            ]}],
            "payments": [{"method": "cash", "amount": "10.00"}],
        }, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        sale = Sale.objects.get(pk=res.json()["id"])
        self.assertEqual(self._void(sale).json()["reopened_appointment_ids"], [])
        self.shampoo.refresh_from_db()
        self.assertEqual(self.shampoo.stock_qty, Decimal("5"))

    def test_solo_il_titolare(self):
        sale = self._checkout()
        res = self._void(sale, auth=self.desk)
        self.assertEqual(res.status_code, 403)
        self.assertTrue(Sale.objects.filter(pk=sale.id).exists())

    def test_vendita_di_un_altro_salone_404(self):
        from apps.accounts.models import Membership, User

        sale = self._checkout()
        other = Salon.objects.create(name="Altro", slug="altro-salone")
        boss = User.objects.create_user(email="boss@altro.it", password="x" * 10)
        Membership.objects.create(user=boss, salon=other, is_owner=True)
        self.assertEqual(self._void(sale, auth=bearer(boss, other)).status_code, 404)
        self.assertTrue(Sale.objects.filter(pk=sale.id).exists())

    def test_conto_con_gift_card_non_si_annulla_e_il_dettaglio_dice_perche(self):
        sale = self._checkout(
            payments=[{"method": "cash", "amount": "100.00"}],
            extra_lines=[{"line_type": "gift_card", "value": "50.00"}],
        )
        detail = self.client.get(f"/api/sales/{sale.id}", **self.auth).json()
        self.assertIn("gift card", detail["void_blocker"])
        res = self._void(sale)
        self.assertEqual(res.status_code, 422)
        self.assertIn("gift card", json.loads(res.content)["detail"])
        self.assertTrue(Sale.objects.filter(pk=sale.id).exists())
        self.visit.refresh_from_db()
        self.assertEqual(self.visit.status, Appointment.Status.CLOSED)

    def test_dettaglio_annullabile_senza_motivo(self):
        sale = self._checkout()
        detail = self.client.get(f"/api/sales/{sale.id}", **self.auth).json()
        self.assertEqual(detail["void_blocker"], "")
