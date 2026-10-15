"""La «permanenza» della cliente: i suoi appuntamenti dello stesso giorno, uno dopo l'altro."""

import json
from decimal import Decimal

from common.auth import create_staff_tokens

from ..models import Appointment
from ..services.appointments import create_appointment
from ..services.stay import stay_of
from .base import AgendaTestBase, _aware


class StayTests(AgendaTestBase):
    def setUp(self):
        self.op2.services.add(self.svc60, self.svc30)
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}

    def book(self, op, service, hour, minute=0):
        with self._windows(self.wide):
            return create_appointment(
                self.salon, self.client_obj, [{"service_id": service.id, "operator_id": op.id}],
                _aware(self.day, hour, minute), via="dashboard", force=True, client_overlap_ok=True,
            )

    def test_one_after_the_other_is_one_stay_a_morning_and_an_evening_are_two(self):
        hands = self.book(self.op1, self.svc60, 10)          # 10:00–11:00
        feet = self.book(self.op2, self.svc30, 11)           # 11:00–11:30, attaccati
        brows = self.book(self.op1, self.svc30, 11, 50)      # 20' dopo: stessa permanenza
        evening = self.book(self.op2, self.svc60, 17)        # la sera: un'altra
        cancelled = self.book(self.op2, self.svc30, 12, 15)
        Appointment.objects.filter(pk=cancelled.pk).update(status=Appointment.Status.CANCELLED)
        self.assertEqual([a.pk for a in stay_of(feet)], [hands.pk, feet.pk, brows.pk])
        self.assertEqual([a.pk for a in stay_of(evening)], [evening.pk])
        self.assertEqual([a.pk for a in stay_of(Appointment.objects.get(pk=cancelled.pk))], [cancelled.pk])

    def test_the_endpoint_lists_the_stay_and_what_is_already_billed(self):
        from apps.accounts.models import Membership, User
        from apps.sales.models import Sale

        hands = self.book(self.op1, self.svc60, 10)
        feet = self.book(self.op2, self.svc30, 11)
        sale = Sale.objects.create(salon=self.salon, kind="checkout", appointment=hands, client=self.client_obj, total=Decimal("80"))
        Appointment.objects.filter(pk=feet.pk).update(paid_in_sale=sale, status=Appointment.Status.CLOSED)
        user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        res = self.client.get(
            f"/api/agenda/appointments/{feet.id}/stay",
            HTTP_AUTHORIZATION=f"Bearer {create_staff_tokens(user, self.salon)['access']}",
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = json.loads(res.content)
        self.assertEqual([(v["id"], v["bill_id"]) for v in body], [(hands.id, sale.id), (feet.id, sale.id)])
        self.assertEqual(body[1]["items"][0]["operator_id"], self.op2.id)
