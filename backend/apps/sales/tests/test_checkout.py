"""Checkout dell'appuntamento: caparra detratta, secondo incasso rifiutato, visita chiusa.

Caccia del 22/09 — storico vendite e checkout visibile all'agenda: 05-03 +
14-03 (caparre fuori dallo storico), 05-17 + 14-11 (C14, nome del servizio),
08-03 (evento d'agenda al checkout), C17 (caparra che copre tutto il conto:
`payments: []`).
"""

from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, override_settings

from apps.clients.models import Client
from apps.core.models import ActivityLog, OutboxEvent, Salon
from common.auth import create_staff_tokens

from ..models import Sale, SaleLine
from ..services import finalize_sale, record_deposit_cashed, today_summary
from .base import PATCH_LOYALTY, HistoryTestBase, _blocks


class CheckoutApiTests(TestCase):
    """I controlli del checkout, dall'HTTP: erano senza un solo test.

    Caparra detratta al netto dei rimborsi, secondo incasso rifiutato,
    appuntamento annullato rifiutato, caparra più alta del conto.
    """

    def setUp(self):
        from django.utils import timezone

        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.Appointment = Appointment
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi"
        )
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Colore")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Colore",
            duration_min=60, price=Decimal("100.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + timezone.timedelta(days=1),
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal("100.00"),
        )

    def _deposit(self, amount, *, refunded="0.00", status="paid", intent=""):
        self.appointment.deposit_amount = Decimal(amount)
        self.appointment.deposit_refunded_amount = Decimal(refunded)
        self.appointment.deposit_status = status
        self.appointment.deposit_payment_intent_id = intent
        self.appointment.save()

    def _checkout(self, price="100.00", paid="100.00", method="cash"):
        import json

        payments = [] if Decimal(paid) == 0 else [{"method": method, "amount": paid}]
        body = {
            "blocks": [
                {
                    "operator_id": self.operator.id,
                    "lines": [
                        {
                            "line_type": "service",
                            "service_id": self.service.id,
                            "qty": 1,
                            "unit_price": price,
                        }
                    ],
                }
            ],
            "payments": payments,
        }
        return self.client.post(
            f"/api/sales/checkout/{self.appointment.id}",
            json.dumps(body),
            content_type="application/json",
            **self.auth,
        )

    def test_the_deposit_is_deducted_net_of_what_was_refunded(self):
        """30 di caparra con 10 già restituiti: se ne detraggono 20, non 30."""
        self._deposit("30.00", refunded="10.00")
        response = self._checkout(paid="80.00")
        self.assertEqual(response.status_code, 200, response.content)
        sale = Sale.objects.get(appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("100.00"))
        self.assertEqual(sale.deposit_deducted, Decimal("20.00"))
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "closed")
        # la richiesta di recensione parte dopo i messaggi della visita ancora in coda
        self.assertEqual(
            OutboxEvent.objects.get(event_type="visit.completed").coalesce_key,
            f"appointment:{self.appointment.id}",
        )
        # la quota già restituita non può essere detratta di nuovo
        self.assertEqual(self._checkout(paid="80.00").status_code, 400)

    def test_paying_the_whole_bill_without_the_deposit_is_refused(self):
        self._deposit("30.00")
        response = self._checkout(paid="100.00")
        self.assertEqual(response.status_code, 422, response.content)
        self.assertFalse(Sale.objects.filter(appointment=self.appointment).exists())

    def test_a_second_checkout_is_refused(self):
        self.assertEqual(self._checkout().status_code, 200)
        response = self._checkout()
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(Sale.objects.filter(appointment=self.appointment).count(), 1)

    def test_a_cancelled_or_no_show_appointment_cannot_be_cashed(self):
        for status in ("cancelled", "no_show"):
            self.appointment.status = status
            self.appointment.save(update_fields=["status"])
            response = self._checkout()
            self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(Sale.objects.count(), 0)

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_a_deposit_bigger_than_the_bill_is_capped_and_given_back(self):
        """Servizio ridotto dopo la prenotazione: prima il conto era impossibile
        da chiudere (dovuto negativo → 422 per sempre)."""
        self._deposit("50.00", intent="pi_dep")
        with patch(
            "stripe.Refund.create", return_value={"id": "re_x", "amount": 3000, "status": "succeeded"}
        ) as refund:
            response = self._checkout(price="20.00", paid="0")
        self.assertEqual(response.status_code, 200, response.content)
        sale = Sale.objects.get(appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("20.00"))
        self.assertEqual(sale.deposit_deducted, Decimal("20.00"))
        # i 30 di troppo tornano alla cliente, non restano in cassa
        self.assertEqual(refund.call_args.kwargs["amount"], 3000)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_refunded_amount, Decimal("30.00"))
        self.assertEqual(self.appointment.deposit_status, "paid")

    def test_an_excess_that_stripe_cannot_return_is_written_down(self):
        self._deposit("50.00")  # caparra incassata in salone: nessun intent
        response = self._checkout(price="20.00", paid="0")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(
            ActivityLog.objects.filter(
                salon=self.salon, type="deposit.excess_refund_due"
            ).exists()
        )

    def test_the_checkout_does_not_overwrite_a_deposit_paid_meanwhile(self):
        """La cliente paga il link mentre la cassiera chiude il conto: il salvataggio
        finale riportava la caparra a «richiesta» e cancellava il PaymentIntent."""
        from apps.sales.api import finalize_sale as real_finalize

        def _paid_meanwhile(*args, **kwargs):
            self.Appointment.objects.filter(pk=self.appointment.pk).update(
                deposit_status="paid", deposit_payment_intent_id="pi_late"
            )
            return real_finalize(*args, **kwargs)

        with patch("apps.sales.api.finalize_sale", side_effect=_paid_meanwhile):
            response = self._checkout()
        self.assertEqual(response.status_code, 200, response.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "closed")
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_late")

    @override_settings(STRIPE_SECRET_KEY="sk_test")
    def test_closing_the_bill_closes_the_payment_link(self):
        """Il link restava pagabile a conto chiuso: 100 in salone + 30 sul link."""
        from .. import stripe_service

        self.appointment.deposit_status = "required"
        self.appointment.deposit_amount = Decimal("30.00")
        self.appointment.deposit_checkout_session_id = "cs_1"
        self.appointment.save()
        with patch.object(stripe_service, "expire_deposit_checkout") as expire:
            self.assertEqual(self._checkout().status_code, 200)
        expire.assert_called_once()

    def test_the_sale_detail_asks_for_the_sales_permission(self):
        from apps.accounts.models import Membership, Role, User

        self.assertEqual(self._checkout().status_code, 200)
        sale = Sale.objects.get(appointment=self.appointment)
        other = User.objects.create_user(email="nina@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Sala", scopes=["agenda"])
        Membership.objects.create(user=other, salon=self.salon, role=role)
        token = create_staff_tokens(other, self.salon)["access"]
        response = self.client.get(
            f"/api/sales/{sale.id}", HTTP_AUTHORIZATION=f"Bearer {token}"
        )
        self.assertEqual(response.status_code, 403, response.content)

    def test_a_negative_page_is_refused_not_a_500(self):
        response = self.client.get("/api/sales/?limit=-1", **self.auth)
        self.assertEqual(response.status_code, 422, response.content)

    def test_filtering_by_operator_counts_only_her_lines(self):
        """Una vendita da 100 con 20 di Giulia le veniva attribuita per intero."""
        import json

        from apps.staff.models import Operator

        anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="Neri")
        body = {
            "blocks": [
                {"operator_id": self.operator.id, "lines": [
                    {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "20.00"}]},
                {"operator_id": anna.id, "lines": [
                    {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "80.00"}]},
            ],
            "payments": [{"method": "cash", "amount": "100.00"}],
        }
        response = self.client.post(
            f"/api/sales/checkout/{self.appointment.id}", json.dumps(body),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(response.status_code, 200, response.content)
        listed = self.client.get(f"/api/sales/?operator_id={self.operator.id}", **self.auth)
        self.assertEqual(listed.json()["kpi"]["revenue"], "20.00")


class DepositIsCashOfItsOwnDayTests(TestCase):
    """La caparra si conta il giorno in cui arriva, non quello del conto finale."""

    def setUp(self):
        from django.utils import timezone

        from apps.agenda.models import Appointment
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=operator,
            start=timezone.now() + timezone.timedelta(days=2),
            deposit_status="required", deposit_amount=Decimal("30.00"),
        )
        self.metadata = {
            "appointment_id": str(self.appointment.id),
            "salon_id": str(self.salon.id),
            "kind": "deposit",
        }

    def test_the_deposit_paid_online_enters_the_till_that_day(self):
        from ..api import _payment_intent_succeeded

        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata)
        sale = Sale.objects.get(deposit_appointment=self.appointment)
        self.assertEqual(sale.total, Decimal("30.00"))
        self.assertEqual(sale.payments.get().method, "card")
        summary = today_summary(self.salon)
        self.assertEqual(summary["cash_in"], Decimal("30.00"))
        # È un anticipo, non un conto: denaro in cassa, ma niente venduto e
        # nessuno scontrino in più nel riepilogo.
        self.assertEqual(summary["deposit_cashed"], Decimal("30.00"))
        self.assertEqual(summary["total"], Decimal("0.00"))
        self.assertEqual(summary["count"], 0)
        # lo stesso evento ripetuto non incassa due volte
        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata)
        self.assertEqual(Sale.objects.filter(deposit_appointment=self.appointment).count(), 1)

    def test_the_same_money_is_not_counted_twice_at_the_checkout(self):
        from ..api import _payment_intent_succeeded

        _payment_intent_succeeded({"id": "pi_1", "amount_received": 3000}, self.metadata)
        self.appointment.refresh_from_db()
        with patch(PATCH_LOYALTY):
            finalize_sale(
                self.salon, kind=Sale.Kind.CHECKOUT, client=self.client_obj,
                appointment=self.appointment,
                blocks=[{"operator_id": None, "lines": [
                    {"line_type": "service", "qty": 1, "unit_price": Decimal("100.00")}]}],
                payments=[{"method": "cash", "amount": Decimal("70.00")}],
                deposit_deducted=self.appointment.deposit_credit,
            )
        summary = today_summary(self.salon)
        self.assertEqual(summary["deposit_used"], Decimal("30.00"))
        # 30 di caparra + 70 saldati: cento euro, contati una volta sola
        self.assertEqual(summary["cash_in"], Decimal("100.00"))
        # e il venduto è il conto, non conto + anticipo
        self.assertEqual(summary["total"], Decimal("100.00"))
        self.assertEqual(summary["count"], 1)

    def test_paying_the_link_after_the_bill_is_given_back(self):
        """Caparra pagata a conto già chiuso: prima diventava semplicemente
        «pagata» e il salone teneva 130 € per un conto da 100."""
        from ..api import _payment_intent_succeeded

        self.appointment.status = "closed"
        self.appointment.save(update_fields=["status"])
        Sale.objects.create(
            salon=self.salon, kind=Sale.Kind.CHECKOUT, appointment=self.appointment,
            client=self.client_obj, total=Decimal("100.00"),
        )
        _payment_intent_succeeded({"id": "pi_late", "amount_received": 3000}, self.metadata)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "refund_due")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_late")
        self.assertFalse(Sale.objects.filter(deposit_appointment=self.appointment).exists())

    def test_a_payment_from_the_account_of_its_own_link_is_accepted(self):
        """Il titolare collega Stripe mentre un link è in volo: l'evento nasce
        sull'account di prima e veniva scartato con i soldi già incassati."""
        from apps.core.models import SalonSettings

        from .. import stripe_service
        from ..api import _payment_intent_succeeded

        token = stripe_service.account_token(self.salon)  # nessun account: piattaforma
        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"stripe_account_id": "acct_nuovo"}
        )
        self.salon.refresh_from_db()
        _payment_intent_succeeded(
            {"id": "pi_1", "amount_received": 3000}, {**self.metadata, "acct": token}, ""
        )
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "paid")

    def test_an_event_from_an_unknown_account_is_still_ignored(self):
        from ..api import _payment_intent_succeeded

        _payment_intent_succeeded(
            {"id": "pi_1", "amount_received": 3000},
            {**self.metadata, "acct": "firma-inventata"},
            "acct_estraneo",
        )
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.deposit_status, "required")
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.payment_ignored").exists()
        )


class BugHunt21SeptemberTests(TestCase):
    """Difetti trovati nella caccia ai bug del 21/09/2026 (docs/BUG_HUNT_2026-09-21.md)."""

    def setUp(self):
        from django.utils import timezone

        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.staff.models import Operator

        self.Appointment = Appointment
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure",
            duration_min=60, price=Decimal("50.00"),
        )
        self.appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() + timezone.timedelta(hours=2),
            deposit_status="required", deposit_amount=Decimal("20.00"),
        )
        AppointmentService.objects.create(
            appointment=self.appointment, service=self.service, operator=self.operator,
            duration_min=60, price=Decimal("50.00"),
        )
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _checkout(self, amount="50.00"):
        import json

        return self.client.post(
            f"/api/sales/checkout/{self.appointment.id}",
            json.dumps({
                "blocks": [{"operator_id": self.operator.id, "lines": [
                    {"line_type": "service", "service_id": self.service.id, "qty": 1, "unit_price": "50.00"}
                ]}],
                "payments": [{"method": "cash", "amount": amount}],
            }),
            content_type="application/json",
            **self.auth,
        )

    # ---- B17 -------------------------------------------------------------

    def test_a_deposit_paid_while_the_checkout_runs_is_not_wiped(self):
        """La visita si chiudeva con un save() completo su un'istanza letta
        all'inizio della richiesta: il webhook della caparra pagata, arrivato
        nel frattempo, veniva riscritto all'indietro — denaro incassato su
        Stripe e PaymentIntent perso, quindi nemmeno rimborsabile."""
        from .. import api as sales_api

        real_finalize = sales_api.finalize_sale

        def interleaved(*args, **kwargs):
            # il webhook Stripe arriva mentre il checkout è in corso
            self.Appointment.objects.filter(pk=self.appointment.pk).update(
                deposit_status="paid", deposit_payment_intent_id="pi_probe_123", deposit_due_at=None
            )
            return real_finalize(*args, **kwargs)

        with patch.object(sales_api, "finalize_sale", side_effect=interleaved):
            response = self._checkout()
        self.assertEqual(response.status_code, 200, response.content)
        self.appointment.refresh_from_db()
        self.assertEqual(self.appointment.status, "closed")
        self.assertEqual(self.appointment.deposit_status, "paid")
        self.assertEqual(self.appointment.deposit_payment_intent_id, "pi_probe_123")

    def test_the_deposit_deducted_is_the_one_read_under_the_lock(self):
        """Caparra già pagata: il conto la detrae, e il pagamento chiesto alla
        cliente è il saldo."""
        self.appointment.deposit_status = "paid"
        self.appointment.save(update_fields=["deposit_status"])
        response = self._checkout(amount="30.00")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Decimal(response.json()["sale"]["deposit_deducted"]), Decimal("20.00"))

    def test_a_cancelled_appointment_is_still_refused(self):
        self.appointment.status = "cancelled"
        self.appointment.save(update_fields=["status"])
        response = self._checkout()
        self.assertEqual(response.status_code, 400, response.content)
        self.assertFalse(Sale.objects.filter(appointment=self.appointment).exists())

    def test_the_same_appointment_cannot_be_cashed_twice(self):
        self.assertEqual(self._checkout().status_code, 200)
        second = self._checkout()
        self.assertEqual(second.status_code, 400, second.content)
        self.assertEqual(Sale.objects.filter(appointment=self.appointment).count(), 1)

    # ---- B25 -------------------------------------------------------------

    def test_every_gift_card_sold_has_its_own_line(self):
        """Con una riga da tre carte ne venivano emesse tre ma una sola restava
        collegata alla vendita: le altre risultavano «mai vendute» e
        reincassabili una seconda volta dalla sezione Fedeltà."""
        from apps.marketing.models import GiftCard
        from ..services import record_gift_card_cashed

        with patch(PATCH_LOYALTY):
            sale = finalize_sale(
                self.salon,
                kind=Sale.Kind.POS,
                blocks=_blocks([{"line_type": "gift_card", "value": Decimal("50.00"), "qty": 3}]),
                payments=[{"method": "cash", "amount": Decimal("150.00")}],
                client=self.client_obj,
            )
        cards = list(GiftCard.objects.filter(salon=self.salon).order_by("id"))
        self.assertEqual(len(cards), 3)
        self.assertEqual(sale.total, Decimal("150.00"))
        lines = list(SaleLine.objects.filter(sale=sale).order_by("id"))
        self.assertEqual(len(lines), 3)
        self.assertEqual([line.qty for line in lines], [1, 1, 1])
        self.assertEqual(
            sorted(line.gift_card_id for line in lines), sorted(c.id for c in cards)
        )
        # nessuna carta può essere incassata una seconda volta
        for card in cards:
            self.assertIsNone(record_gift_card_cashed(self.salon, card, method="cash"))


class HistoryWithoutDepositsTests(HistoryTestBase):
    """05-03, 14-03: la caparra è un anticipo, non una seconda vendita."""

    def _paid_deposit_then_checkout(self):
        appointment = self._appointment(deposit_status="paid", deposit_amount=Decimal("30.00"))
        record_deposit_cashed(self.salon, appointment, method="card")
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "70.00"}],
        )
        self.assertEqual(res.status_code, 200, res.content)
        return appointment

    def test_the_history_counts_the_visit_once(self):
        self._paid_deposit_then_checkout()
        listed = self.client.get("/api/sales/", **self.auth).json()
        self.assertEqual(Decimal(listed["kpi"]["revenue"]), Decimal("100.00"))
        self.assertEqual(listed["kpi"]["count"], 1)
        self.assertEqual(listed["kpi"]["items_count"], 1)
        self.assertEqual([s["kind"] for s in listed["items"]], ["checkout"])
        # nemmeno come «vendita da banco» della cliente
        mine = self.client.get(f"/api/sales/?client_id={self.client_obj.id}&kind=pos", **self.auth).json()
        self.assertEqual(mine["count"], 0)

    def test_deposits_can_still_be_listed_on_their_own(self):
        appointment = self._paid_deposit_then_checkout()
        deposits = self.client.get("/api/sales/?kind=deposit", **self.auth).json()
        self.assertEqual(deposits["count"], 1)
        self.assertEqual(deposits["items"][0]["deposit_appointment_id"], appointment.id)
        self.assertEqual(Decimal(deposits["kpi"]["revenue"]), Decimal("30.00"))


class ServiceNameOnTheLinesTests(HistoryTestBase):
    """05-17, 14-11 (C14): la riga porta il nome del servizio."""

    def test_the_detail_names_the_service(self):
        appointment = self._appointment()
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "100.00"}],
        )
        sale_id = res.json()["sale"]["id"]
        detail = self.client.get(f"/api/sales/{sale_id}", **self.auth).json()
        self.assertEqual(detail["lines"][0]["service_name"], "Colore")
        self.assertEqual(res.json()["sale"]["lines"][0]["service_name"], "Colore")

    def test_a_line_without_service_has_an_empty_name(self):
        appointment = self._appointment(deposit_status="paid", deposit_amount=Decimal("30.00"))
        deposit = record_deposit_cashed(self.salon, appointment, method="card")
        detail = self.client.get(f"/api/sales/{deposit.id}", **self.auth).json()
        self.assertEqual(detail["lines"][0]["service_name"], "")


class CheckoutSeenByTheAgendaTests(HistoryTestBase):
    """08-03: il checkout lascia un evento che anche l'agenda riceve."""

    def test_the_checkout_writes_an_agenda_event_without_amounts(self):
        from apps.core.livefeed import allowed_prefixes

        appointment = self._appointment()
        res = self._checkout(
            appointment, [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "100.00")]}],
            [{"method": "cash", "amount": "100.00"}],
        )
        self.assertEqual(res.status_code, 200, res.content)
        log = ActivityLog.objects.get(salon=self.salon, type="appointment.closed")
        self.assertEqual(log.payload["appointment_id"], appointment.id)
        self.assertNotIn("€", log.summary)
        # l'operatrice col solo permesso agenda lo riceve dal feed live
        self.assertTrue(any(log.type.startswith(prefix) for prefix in allowed_prefixes(False, ["agenda"])))


class DepositCoversTheWholeBillTests(HistoryTestBase):
    """C17: caparra ≥ conto (anche scontato): si accetta `payments: []` e si restituisce il resto."""

    def test_no_payments_and_the_excess_goes_back(self):
        appointment = self._appointment(
            price="50.00", deposit_status="paid", deposit_amount=Decimal("30.00"),
            deposit_payment_intent_id="pi_dep",
        )
        record_deposit_cashed(self.salon, appointment, method="card")
        refunded = {"id": "re_excess", "amount": 500, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self._checkout(
                appointment,
                [{"operator_id": self.giulia.id, "lines": [self._line(self.colore, "50.00", discount_pct=50)]}],
                [],
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Decimal(res.json()["sale"]["total"]), Decimal("25.00"))
        self.assertEqual(Decimal(res.json()["sale"]["deposit_deducted"]), Decimal("25.00"))
        self.assertEqual(res.json()["sale"]["payments"], [])
        self.assertEqual(refund.call_args.kwargs["amount_cents"], 500)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, "closed")
