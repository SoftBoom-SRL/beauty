"""Caccia del 22/09 — caparra lato agenda: riduzioni, scadenze, rimborsi."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone

from apps.core.models import ActivityLog

from .models import Appointment
from .services import create_appointment
from .tests import AgendaTestBase, _aware


class PaidDepositOnAShorterVisitTests(AgendaTestBase):
    """02-01, 05-06: ridurre la visita non fa perdere quello che la cliente ha versato."""

    def _paid_visit(self, deposit):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=deposit,
            deposit_payment_intent_id="pi_dep",
        )
        appointment.refresh_from_db()
        return appointment

    def _split_first(self, appointment):
        from .services import split_appointment

        first = appointment.items.order_by("order").first()  # il servizio da 50
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, _created = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        return original

    def test_the_checkout_still_sees_the_whole_excess(self):
        original = self._split_first(self._paid_visit(Decimal("70.00")))  # visita ora da 30
        self.assertEqual(original.deposit_amount, Decimal("70.00"))
        self.assertEqual(original.deposit_credit, Decimal("70.00"))
        # al conto si detraggono 30, i 40 in più tornano alla cliente
        self.assertEqual(original.deposit_credit - min(original.deposit_credit, original.total_price), Decimal("40.00"))
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.excess")
        self.assertEqual(log.payload["amount"], "40.00")

    def test_refunding_the_excess_by_hand_does_not_eat_the_credit_twice(self):
        from .services import record_deposit_refund

        original = self._split_first(self._paid_visit(Decimal("70.00")))
        # il titolare restituisce i 40 dalla dashboard Stripe
        record_deposit_refund(original, refund_id="re_excess", cents=4000, status="succeeded")
        original.refresh_from_db()
        # versati 70, tornati 40: in cassa ne restano 30, quanto la visita
        self.assertEqual(original.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(original.deposit_credit, Decimal("30.00"))

    def test_the_checkout_gives_the_excess_back(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        original = self._split_first(self._paid_visit(Decimal("70.00")))
        user = User.objects.create_user(email="cassa22@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa22", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        item = original.items.get()
        body = {
            "blocks": [{"operator_id": self.op1.id, "lines": [
                {"line_type": "service", "service_id": item.service_id, "qty": 1, "unit_price": str(item.price)},
            ]}],
            "payments": [],
        }
        refunded = {"id": "re_ex", "amount": 4000, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self.client.post(
                f"/api/sales/checkout/{original.id}", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["sale"]["deposit_deducted"], "30.00")
        self.assertEqual(refund.call_args.kwargs["amount_cents"], 4000)
        original.refresh_from_db()
        self.assertEqual(original.deposit_refunded_amount, Decimal("40.00"))
