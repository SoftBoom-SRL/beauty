"""Caparra versata fuori da beauty (bonifico, link Nexi, contanti, POS) e registrata dallo staff.

Alla prenotazione (`deposit_paid` in POST /appointments) o dopo, dal dettaglio
della visita (`amount` in POST /appointments/{id}/deposit-cashed): la caparra
diventa pagata, entra in cassa il giorno in cui si registra e nessun link di
pagamento parte verso la cliente.
"""

import json
from decimal import Decimal
from unittest.mock import patch

from apps.core.models import ActivityLog, DepositRule
from common.auth import create_staff_tokens
from common.testing import aware

from ..models import Appointment
from ..services.appointments import create_appointment
from .base import AgendaTestBase


class ManualDepositTests(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        self.role = Role.objects.create(salon=self.salon, name="Banco", scopes=["agenda", "sales"])
        Membership.objects.create(user=self.user, salon=self.salon, role=self.role)

    def auth(self):
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"}

    def post(self, url, body):
        return self.client.post(url, data=json.dumps(body, default=str), content_type="application/json", **self.auth())

    def book(self, **extra):
        body = {
            "client_id": self.client_obj.id,
            "items": [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            "start": aware(self.day, 10).isoformat(),
            **extra,
        }
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}), patch("apps.clients.services.client_facts", return_value={}):
            return self.post("/api/agenda/appointments", body)

    def deposit_sale(self, appointment_id):
        from apps.sales.models import Sale

        return Sale.objects.get(deposit_appointment_id=appointment_id)

    def test_booking_with_a_deposit_already_paid(self):
        # La regola chiederebbe 10 €: vale quello che la cliente ha versato davvero.
        DepositRule.objects.create(salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10"))
        with patch("apps.sales.stripe_service.ensure_deposit_link") as link:
            res = self.book(deposit_paid={"amount": "30", "method": "transfer"})
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual((body["deposit_status"], Decimal(body["deposit_amount"])), ("paid", Decimal("30")))
        self.assertIsNone(body["deposit_due_at"])
        link.assert_not_called()
        sale = self.deposit_sale(body["id"])
        self.assertEqual(sale.total, Decimal("30"))
        self.assertEqual(list(sale.payments.values_list("method", "amount")), [("transfer", Decimal("30.00"))])
        self.assertTrue(ActivityLog.objects.filter(salon=self.salon, type="deposit.cashed").exists())
        # Al conto si detrae tutta.
        self.assertEqual(Appointment.objects.get(pk=body["id"]).deposit_credit, Decimal("30"))

    def test_booking_deposit_needs_the_till_scope(self):
        self.role.scopes = ["agenda"]
        self.role.save()
        res = self.book(deposit_paid={"amount": "30", "method": "cash"})
        self.assertEqual(res.status_code, 403, res.content)
        self.assertFalse(Appointment.objects.exists())

    def test_booking_deposit_cannot_exceed_the_visit(self):
        res = self.book(deposit_paid={"amount": "50.01", "method": "card"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("supera il totale", res.json()["detail"])
        self.assertFalse(Appointment.objects.exists())
        res = self.book(deposit_paid={"amount": "30", "method": "assegno"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(Appointment.objects.exists())

    def test_deposit_added_later_to_a_booking_without_one(self):
        res = self.book()
        appointment_id = res.json()["id"]
        self.assertEqual(res.json()["deposit_status"], "none")
        url = f"/api/agenda/appointments/{appointment_id}/deposit-cashed"
        # senza importo non si sa quanto ha versato
        self.assertEqual(self.post(url, {"method": "transfer"}).status_code, 400)
        res = self.post(url, {"method": "transfer", "amount": "25.50"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.json()["deposit_status"], Decimal(res.json()["deposit_amount"])), ("paid", Decimal("25.50")))
        self.assertEqual(self.deposit_sale(appointment_id).payments.get().method, "transfer")
        # una seconda volta no: è già pagata
        self.assertEqual(self.post(url, {"method": "cash", "amount": "5"}).status_code, 400)

    def test_required_deposit_cashed_with_the_amount_really_paid(self):
        DepositRule.objects.create(salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10"))
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}), patch("apps.clients.services.client_facts", return_value={}):
            appointment = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                aware(self.day, 10), via="dashboard",
            )
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REQUIRED)
        res = self.post(f"/api/agenda/appointments/{appointment.id}/deposit-cashed", {"method": "card", "amount": "20"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["deposit_amount"]), Decimal("20"))
        self.assertEqual(self.deposit_sale(appointment.id).total, Decimal("20"))

    def test_no_deposit_on_a_closed_visit(self):
        res = self.book()
        Appointment.objects.filter(pk=res.json()["id"]).update(status=Appointment.Status.CLOSED)
        res = self.post(f"/api/agenda/appointments/{res.json()['id']}/deposit-cashed", {"method": "cash", "amount": "10"})
        self.assertEqual(res.status_code, 400, res.content)
