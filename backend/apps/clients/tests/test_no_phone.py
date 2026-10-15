"""Schede senza telefono e telefono di contatto (`Client.phone` vuoto, `contact_client`)."""

from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.core.models import Salon

from ..models import Client


class NoPhoneTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_many_clients_without_phone(self):
        Client.objects.create(salon=self.salon, first_name="Anna")
        Client.objects.create(salon=self.salon, first_name="Bea")
        self.assertEqual(Client.objects.filter(salon=self.salon, phone="").count(), 2)

    def test_same_phone_still_refused(self):
        Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Client.objects.create(salon=self.salon, first_name="Bea", phone="+393331112233")

    def test_contact_phone_falls_back_to_contact_client(self):
        mamma = Client.objects.create(salon=self.salon, first_name="Laura", phone="+393331112233")
        figlia = Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=mamma)
        self.assertEqual(figlia.contact_phone, "+393331112233")
        self.assertEqual(mamma.contact_phone, "+393331112233")
        self.assertEqual(list(mamma.dependents.all()), [figlia])

    def test_own_phone_wins_and_no_phone_is_empty(self):
        mamma = Client.objects.create(salon=self.salon, first_name="Laura", phone="+393331112233")
        figlia = Client.objects.create(
            salon=self.salon, first_name="Giulia", phone="+393334445566", contact_client=mamma
        )
        self.assertEqual(figlia.contact_phone, "+393334445566")
        sola = Client.objects.create(salon=self.salon, first_name="Sola")
        self.assertEqual(sola.contact_phone, "")


class AmountDueTests(TestCase):
    """`sales.dues`: il debito della cliente letto in un posto solo."""

    def test_sums_only_what_is_still_due(self):
        from decimal import Decimal

        from apps.sales.dues import amounts_due_by_client, client_amount_due, open_dues
        from apps.sales.models import Sale

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        anna = Client.objects.create(salon=salon, first_name="Anna", phone="+393331112233")
        bea = Client.objects.create(salon=salon, first_name="Bea", phone="+393334445566")
        Sale.objects.create(salon=salon, kind="pos", client=anna, total=Decimal("100"), amount_due=Decimal("40"))
        Sale.objects.create(salon=salon, kind="pos", client=anna, total=Decimal("50"), amount_due=Decimal("10.50"))
        Sale.objects.create(salon=salon, kind="pos", client=anna, total=Decimal("70"))
        self.assertEqual(client_amount_due(anna), Decimal("50.50"))
        self.assertEqual(client_amount_due(bea), Decimal("0.00"))
        self.assertEqual(client_amount_due(None), Decimal("0.00"))
        self.assertEqual(open_dues(anna).count(), 2)
        self.assertEqual(amounts_due_by_client(salon, [anna.id, bea.id]), {anna.id: Decimal("50.50")})
