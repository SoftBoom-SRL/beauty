"""Conto unico: più visite della stessa cliente nello stesso giorno, una sola vendita.

Mani e piedi in contemporanea con due operatrici sono due appuntamenti; il conto
è uno. La vendita si aggancia alla visita principale (`Sale.appointment`), le
altre visite la puntano con `Appointment.paid_in_sale` e contano come incassate
ovunque si controlla «già incassato».
"""

import datetime as dt
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, OutboxEvent, Salon
from apps.staff.models import Operator
from common.testing import aware, bearer, post_json

from ..models import Sale

REFUND = "apps.sales.stripe_service.refund_payment_intent"


class SingleBillBase(TestCase):
    """Sofia: manicure con Giulia e pedicure con Marta, oggi alle 10."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa di prova", scopes=["sales", "agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = bearer(self.user, self.salon)
        self.sofia = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.anna = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Neri", phone="+393331113333"
        )
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.marta = Operator.objects.create(salon=self.salon, first_name="Marta", last_name="Verdi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.manicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("30.00")
        )
        self.pedicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Pedicure", duration_min=60, price=Decimal("40.00")
        )
        self.today = timezone.localdate()
        self.mani = self._visit(self.giulia, self.manicure)
        self.piedi = self._visit(self.marta, self.pedicure)

    def _visit(self, operator, service, start=None, client=None, **fields):
        visit = Appointment.objects.create(
            salon=self.salon, client=client or self.sofia, operator=operator,
            start=start or aware(self.today, 10), **fields,
        )
        AppointmentService.objects.create(
            appointment=visit, service=service, operator=operator,
            duration_min=service.duration_min, price=service.price,
        )
        return visit

    def _lines(self, mani="30.00", piedi="40.00", **piedi_extra):
        return [
            {"operator_id": self.giulia.id, "lines": [
                {"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": mani}]},
            {"operator_id": self.marta.id, "lines": [
                {"line_type": "service", "service_id": self.pedicure.id, "qty": 1, "unit_price": piedi, **piedi_extra}]},
        ]

    def _checkout(self, main=None, extras=None, blocks=None, payments=None, **body):
        main = main or self.mani
        extras = [self.piedi] if extras is None else extras
        return post_json(self.client, f"/api/sales/checkout/{main.id}", {
            "blocks": blocks if blocks is not None else self._lines(),
            "payments": payments if payments is not None else [{"method": "card", "amount": "70.00"}],
            "extra_appointment_ids": [visit.id for visit in extras],
            **body,
        }, **self.auth)


class SingleBillTests(SingleBillBase):
    def test_one_bill_closes_both_visits(self):
        res = self._checkout()
        self.assertEqual(res.status_code, 200, res.content)
        sale = Sale.objects.get()
        self.assertEqual(sale.total, Decimal("70.00"))
        self.assertEqual(sale.appointment, self.mani)
        self.mani.refresh_from_db()
        self.piedi.refresh_from_db()
        self.assertEqual((self.mani.status, self.mani.paid_in_sale), ("closed", None))
        self.assertEqual((self.piedi.status, self.piedi.paid_in_sale), ("closed", sale))
        # ogni visita col suo evento per l'agenda, ogni operatrice col suo incasso
        closed = ActivityLog.objects.filter(type="appointment.closed")
        self.assertEqual(sorted(log.payload["appointment_id"] for log in closed), sorted([self.mani.id, self.piedi.id]))
        breakdown = {row["operator_id"]: Decimal(row["amount"]) for row in res.json()["breakdown"]}
        self.assertEqual(breakdown, {self.giulia.id: Decimal("30.00"), self.marta.id: Decimal("40.00")})
        self.assertEqual(res.json()["sale"]["covered_appointment_ids"], [self.piedi.id])
        # un solo visit.completed, sulla visita principale, con i servizi di tutto il conto
        event = OutboxEvent.objects.get(event_type="visit.completed")
        self.assertEqual(event.payload["appointment_id"], self.mani.id)
        self.assertEqual(event.payload["services"], ["Manicure", "Pedicure"])
        self.assertEqual(event.payload["total"], "70.00")

    def test_the_agenda_says_which_bill_paid_the_visit(self):
        self._checkout()
        sale = Sale.objects.get()
        res = self.client.get(f"/api/agenda/appointments/{self.piedi.id}", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["paid_in_sale_id"], sale.id)
        main = self.client.get(f"/api/agenda/appointments/{self.mani.id}", **self.auth).json()
        self.assertIsNone(main["paid_in_sale_id"])

    def test_the_deposits_of_every_visit_are_deducted(self):
        self.mani.deposit_status, self.mani.deposit_amount = "paid", Decimal("20.00")
        self.mani.save()
        self.piedi.deposit_status, self.piedi.deposit_amount = "paid", Decimal("30.00")
        self.piedi.save()
        res = self._checkout(payments=[{"method": "cash", "amount": "20.00"}])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["sale"]["deposit_deducted"]), Decimal("50.00"))
        # pagare il conto pieno ignorando la caparra della seconda visita è un errore
        other_day = self._visit(self.giulia, self.manicure, start=aware(self.today, 15))
        more = self._visit(self.marta, self.pedicure, start=aware(self.today, 15), deposit_status="paid",
                           deposit_amount=Decimal("30.00"))
        res = self._checkout(main=other_day, extras=[more], payments=[{"method": "cash", "amount": "70.00"}])
        self.assertEqual(res.status_code, 422, res.content)

    def test_the_deposit_excess_goes_back_without_refunding_a_visit_more_than_it_paid(self):
        """Conto da 10 e caparre da 20 e 30: tornano 40, 20 per caparra, mai 40 su una sola."""
        self.mani.deposit_status, self.mani.deposit_amount = "paid", Decimal("20.00")
        self.mani.deposit_payment_intent_id = "pi_mani"
        self.mani.save()
        self.piedi.deposit_status, self.piedi.deposit_amount = "paid", Decimal("30.00")
        self.piedi.deposit_payment_intent_id = "pi_piedi"
        self.piedi.save()
        refunded = lambda *args, **kwargs: {"id": f"re_{args[1]}", "amount": kwargs["amount_cents"], "status": "succeeded"}  # noqa: E731
        with patch(REFUND, side_effect=refunded) as refund:
            res = self._checkout(blocks=self._lines(mani="10.00", piedi="40.00", is_gift=True), payments=[])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["sale"]["deposit_deducted"]), Decimal("10.00"))
        # la principale per prima, fino alla sua caparra; il resto dalla seconda
        calls = [(call.args[1], call.kwargs["amount_cents"]) for call in refund.call_args_list]
        self.assertEqual(calls, [("pi_mani", 2000), ("pi_piedi", 2000)])
        self.mani.refresh_from_db()
        self.piedi.refresh_from_db()
        self.assertEqual(self.mani.deposit_refunded_amount, Decimal("20.00"))
        self.assertEqual(self.piedi.deposit_refunded_amount, Decimal("20.00"))


class AlreadyCashedTests(SingleBillBase):
    """«Già incassato» vale anche per la visita chiusa nel conto di un'altra (`paid_in_sale`)."""

    def test_a_visit_paid_in_another_bill_cannot_be_cashed_again(self):
        self.assertEqual(self._checkout().status_code, 200)
        res = post_json(self.client, f"/api/sales/checkout/{self.piedi.id}", {
            "blocks": [{"operator_id": self.marta.id, "lines": [
                {"line_type": "service", "service_id": self.pedicure.id, "qty": 1, "unit_price": "40.00"}]}],
            "payments": [{"method": "cash", "amount": "40.00"}],
        }, **self.auth)
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("conto di un'altra visita", res.json()["detail"])
        # e nemmeno come visita in più di un altro conto
        later = self._visit(self.giulia, self.manicure, start=aware(self.today, 16))
        res = self._checkout(main=later, extras=[self.piedi], blocks=self._lines(),
                             payments=[{"method": "cash", "amount": "70.00"}])
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Sale.objects.count(), 1)

    def test_a_deposit_paid_after_the_single_bill_is_given_back(self):
        from ..stripe_webhooks import on_payment_intent_succeeded

        self.piedi.deposit_status, self.piedi.deposit_amount = "required", Decimal("30.00")
        self.piedi.save()
        self.assertEqual(self._checkout().status_code, 200)
        # La chiusura del link non è arrivata a Stripe e la cliente paga lo stesso:
        # il conto unico ha già incassato la pedicure, la caparra torna indietro.
        Appointment.objects.filter(pk=self.piedi.pk).update(status="in_progress")
        on_payment_intent_succeeded(
            {"id": "pi_late", "amount_received": 3000},
            {"appointment_id": str(self.piedi.id), "salon_id": str(self.salon.id), "kind": "deposit"},
        )
        self.piedi.refresh_from_db()
        self.assertEqual(self.piedi.deposit_status, "refund_due")
        self.assertFalse(Sale.objects.filter(deposit_appointment=self.piedi).exists())

    def test_undo_cannot_bring_back_a_visit_paid_in_another_bill(self):
        from apps.agenda.services.appointments import create_appointment

        self.marta.services.add(self.pedicure)
        with patch("apps.staff.services.shift_windows", return_value=[(0, 24 * 60)]):
            piedi = create_appointment(
                self.salon, self.sofia, [{"service_id": self.pedicure.id, "operator_id": self.marta.id}],
                aware(self.today, 11), via="dashboard", actor=self.user, client_overlap_ok=True,
            )
        self.assertEqual(self._checkout(extras=[piedi], payments=[{"method": "card", "amount": "70.00"}]).status_code, 200)
        res = post_json(self.client, "/api/agenda/undo", {}, **self.auth)
        self.assertEqual(res.status_code, 409, res.content)
        self.assertTrue(Appointment.objects.filter(pk=piedi.pk).exists())
        # Anche se lo stato tornasse aperto (una correzione a mano dall'admin),
        # la vendita del conto unico basta a fermarlo.
        Appointment.objects.filter(pk=piedi.pk).update(status="confirmed")
        res = post_json(self.client, "/api/agenda/undo", {}, **self.auth)
        self.assertEqual(res.status_code, 409, res.content)
        self.assertIn("incasso", res.json()["detail"])
        self.assertTrue(Appointment.objects.filter(pk=piedi.pk).exists())


class WhichVisitsCanJoinTests(SingleBillBase):
    """Solo visite della stessa cliente, dello stesso giorno, erogate e non incassate."""

    def _refused(self, extras, status=400):
        res = self._checkout(extras=extras)
        self.assertEqual(res.status_code, status, res.content)
        self.assertFalse(Sale.objects.exists())
        self.mani.refresh_from_db()
        self.assertNotEqual(self.mani.status, "closed")
        return res.json()["detail"]

    def test_another_client_is_refused(self):
        anna = self._visit(self.marta, self.pedicure, client=self.anna)
        self.assertIn("stessa cliente", self._refused([anna]))

    def test_another_day_is_refused(self):
        tomorrow = self._visit(self.marta, self.pedicure, start=aware(self.today + dt.timedelta(days=1), 10))
        self.assertIn("stesso giorno", self._refused([tomorrow]))

    def test_a_cancelled_visit_is_refused(self):
        self.piedi.status = "cancelled"
        self.piedi.save(update_fields=["status"])
        self.assertIn("annullata", self._refused([self.piedi]))

    def test_the_main_visit_is_not_repeated(self):
        self.assertIn("principale", self._refused([self.mani]))

    def test_a_visit_of_another_salon_is_not_found(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        client = Client.objects.create(salon=other, first_name="Eva", phone="+393331114444")
        operator = Operator.objects.create(salon=other, first_name="Lia", last_name="Blu")
        stranger = Appointment.objects.create(salon=other, client=client, operator=operator, start=aware(self.today, 10))
        self._refused([stranger], status=404)

    def test_the_other_visits_to_offer_at_the_till(self):
        """La sezione «Altre visite oggi» della cassa: solo quelle che si possono unire."""
        self._visit(self.marta, self.pedicure, client=self.anna)
        self._visit(self.marta, self.pedicure, start=aware(self.today + dt.timedelta(days=1), 10))
        self._visit(self.giulia, self.manicure, start=aware(self.today, 18), status="cancelled")
        res = self.client.get(f"/api/sales/checkout/{self.mani.id}/other-visits", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([visit["id"] for visit in res.json()], [self.piedi.id])
        self.assertEqual(res.json()[0]["items"][0]["operator_id"], self.marta.id)
        self.assertEqual(self._checkout().status_code, 200)
        later = self._visit(self.giulia, self.manicure, start=aware(self.today, 17))
        res = self.client.get(f"/api/sales/checkout/{later.id}/other-visits", **self.auth)
        self.assertEqual(res.json(), [])  # le altre sono già incassate
