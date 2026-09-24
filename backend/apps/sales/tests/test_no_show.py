"""Addebito del no-show sulla carta salvata: uno solo per appuntamento, al netto della caparra."""

from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings
from ninja.errors import HttpError

from apps.clients.models import Client
from apps.core.models import Salon
from common.auth import create_staff_tokens

from ..models import Sale
from ..services import today_summary


@override_settings(STRIPE_SECRET_KEY="sk_test_x")
class ChargeNoShowTests(TestCase):
    """Un solo addebito no-show per appuntamento, con idempotency key verso Stripe."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            consents={"card_charge": True}, stripe_customer_id="cus_1", stripe_payment_method_id="pm_1",
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=60, price=Decimal("50.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() - timezone.timedelta(hours=3), status="no_show",
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=service, operator=operator, duration_min=60, price=Decimal("50.00"),
        )

    def test_second_charge_is_refused_and_stripe_is_called_once(self):
        from .. import stripe_service

        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns_1"}) as create:
            intent, amount = stripe_service.charge_full_amount(self.appointment)
            with self.assertRaises(HttpError) as caught:
                stripe_service.charge_full_amount(self.appointment)
        self.assertEqual(intent["id"], "pi_ns_1")
        self.assertEqual(amount, Decimal("50.00"))
        self.assertEqual(caught.exception.status_code, 409)
        create.assert_called_once()
        # La carta entra nella chiave: un addebito rifiutato non deve bruciare
        # per 24 h il ritentativo con un'altra carta.
        self.assertEqual(
            create.call_args.kwargs["idempotency_key"],
            f"no-show-{self.salon.id}-{self.appointment.id}-pm_1",
        )
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.no_show_payment_intent_id, "pi_ns_1")

    def test_only_no_show_appointments_can_be_charged(self):
        from .. import stripe_service

        self.appointment.status = "confirmed"
        self.appointment.save(update_fields=["status"])
        with patch("stripe.PaymentIntent.create") as create:
            with self.assertRaises(HttpError) as caught:
                stripe_service.charge_full_amount(self.appointment)
        self.assertEqual(caught.exception.status_code, 400)
        create.assert_not_called()


class NoShowAmountTests(TestCase):
    """L'importo comunicato deve essere quello chiesto alla carta."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            consents={"card_charge": True}, stripe_customer_id="cus_1",
            stripe_payment_method_id="pm_1",
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore",
            duration_min=60, price=Decimal("100.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() - timezone.timedelta(hours=3), status="no_show",
            deposit_status="forfeited", deposit_amount=Decimal("30.00"),
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=service, operator=operator,
            duration_min=60, price=Decimal("100.00"),
        )

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_the_charge_and_the_reported_amount_are_the_same(self):
        from apps.accounts.models import Membership, User
        from apps.core.models import ActivityLog

        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        token = create_staff_tokens(user, self.salon)["access"]
        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns"}) as create:
            response = self.client.post(
                f"/api/sales/appointments/{self.appointment.id}/charge-no-show",
                "{}",
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {token}",
            )
        self.assertEqual(response.status_code, 200, response.content)
        # 100 € di servizio meno i 30 già trattenuti: 70, ovunque.
        self.assertEqual(create.call_args.kwargs["amount"], 7000)
        self.assertEqual(Decimal(response.json()["amount"]), Decimal("70.00"))
        logged = ActivityLog.objects.get(salon=self.salon, type="sale.no_show_charged")
        self.assertEqual(Decimal(logged.payload["amount"]), Decimal("70.00"))

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_partly_refunded_deposit_no_longer_covers_the_whole_charge(self):
        """Con 10 € già restituiti su 30, in cassa ne restano 20: l'addebito
        deve scendere di 20, non di 30, altrimenti il salone ci perde 10."""
        from .. import stripe_service

        self.appointment.deposit_refunded_amount = Decimal("10.00")
        self.appointment.save(update_fields=["deposit_refunded_amount"])
        self.assertEqual(
            stripe_service.no_show_charge_amount(self.appointment), Decimal("80.00")
        )

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_the_no_show_charge_becomes_money_in_the_till(self):
        """Prima restava solo una riga nel registro: riepilogo e KPI a zero."""
        from apps.accounts.models import Membership, User

        user = User.objects.create_user(email="ada@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        token = create_staff_tokens(user, self.salon)["access"]
        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns"}):
            response = self.client.post(
                f"/api/sales/appointments/{self.appointment.id}/charge-no-show",
                "{}",
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {token}",
            )
        self.assertEqual(response.status_code, 200, response.content)
        sale = Sale.objects.get(appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("70.00"))
        self.assertEqual(sale.payments.get().method, "card")
        self.assertEqual(today_summary(self.salon)["cash_in"], Decimal("70.00"))
