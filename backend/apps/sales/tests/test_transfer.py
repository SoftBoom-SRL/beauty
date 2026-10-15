"""Il bonifico come metodo di pagamento (anche le caparre pagate con un link di un'altra banca)."""

from decimal import Decimal

from django.test import TestCase

from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.marketing.gift_cards import create_gift_card

from ..models import Payment
from ..services import finalize_sale


class TransferTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+393331112233")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.manicure = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=45, price=Decimal("30.00")
        )

    def test_a_sale_can_be_paid_by_transfer(self):
        sale = finalize_sale(
            self.salon, kind="pos", client=self.client_obj,
            blocks=[{"lines": [{"line_type": "service", "service_id": self.manicure.id, "qty": 1, "unit_price": "30.00"}]}],
            payments=[{"method": "transfer", "amount": "30.00"}],
        )
        self.assertEqual(list(sale.payments.values_list("method", flat=True)), [Payment.Method.TRANSFER])

    def test_a_gift_card_can_be_cashed_by_transfer(self):
        card = create_gift_card(self.salon, Decimal("50"), paid=True, paid_method="transfer")
        self.assertEqual(card.paid_method, "transfer")
