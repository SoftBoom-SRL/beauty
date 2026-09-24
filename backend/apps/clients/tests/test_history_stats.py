"""Storico, visite e spesa della cliente, e i permessi che servono a leggerli.

client_facts e client_stats (senza vendite né appuntamenti degradano a 0/[]
senza eccezioni), gli appuntamenti e lo storico con note, schede e incassi,
il costo in query dello storico.
"""

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Salon
from common.testing import bearer, staff_context

from ..api import client_history, get_client, list_client_appointments, list_notes, list_sheets
from ..models import Client, ClientCategory, ClientNote, TechnicalSheet
from ..services import client_facts, client_stats
from .base import ClientsTestCase, _staff_http


class ClientFactsTests(ClientsTestCase):
    """client_facts deve degradare a 0/[] senza eccezioni quando sales/agenda
    non sono installate (come in questo ambiente di sviluppo/test)."""

    def test_client_facts_minimal_data_no_exceptions(self):
        client = self.make_client(reliability=80, deposit_always=True)
        facts = client_facts(client)
        self.assertEqual(
            facts,
            {
                "reliability": 80,
                "categories": [],
                "total_spent": Decimal("0"),
                "visits": 0,
                "noshow_count": 0,
                "latecancel_count": 0,
                "deposit_always": True,
            },
        )

    def test_client_facts_includes_category_names(self):
        client = self.make_client()
        cat = ClientCategory.objects.create(salon=self.salon, name="VIP")
        client.categories.add(cat)
        facts = client_facts(client)
        self.assertEqual(facts["categories"], ["VIP"])

    def test_client_stats_degrades_to_zero_without_sales_app(self):
        client = self.make_client()
        stats = client_stats(client)
        self.assertEqual(stats, {"visits": 0, "total_spent": Decimal("0"), "last_visit": None})


class ClientAppointmentsApiTests(TestCase):
    """GET /api/clients/{id}/appointments: storico appuntamenti del cliente (staff)."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        self.auth = bearer(user, self.salon)

        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi", color="#AACCEE"
        )
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+391112223333"
        )

    def _appointment(self, client, start):
        from apps.agenda.models import Appointment

        return Appointment.objects.create(
            salon=self.salon, client=client, operator=self.operator, start=start
        )

    def test_returns_past_and_future_ordered_by_start(self):
        past = self._appointment(self.client_obj, timezone.now() - dt.timedelta(days=10))
        future = self._appointment(self.client_obj, timezone.now() + dt.timedelta(days=5))
        resp = self.client.get(
            f"/api/clients/{self.client_obj.id}/appointments", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        ids = [a["id"] for a in resp.json()]
        self.assertEqual(ids, [past.id, future.id])

    def test_only_returns_appointments_of_that_client(self):
        other_client = Client.objects.create(
            salon=self.salon, first_name="Altra", last_name="Persona", phone="+399998887777"
        )
        mine = self._appointment(self.client_obj, timezone.now())
        self._appointment(other_client, timezone.now())
        resp = self.client.get(
            f"/api/clients/{self.client_obj.id}/appointments", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual([a["id"] for a in resp.json()], [mine.id])

    def test_unknown_client_404(self):
        resp = self.client.get("/api/clients/999999/appointments", **self.auth)
        self.assertEqual(resp.status_code, 404)

    def test_client_of_other_salon_404(self):
        """Isolamento multi-tenant: un cliente di un altro salone non è raggiungibile."""
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        foreign_client = Client.objects.create(
            salon=other_salon, first_name="Estranea", last_name="Cliente", phone="+390001112222"
        )
        resp = self.client.get(
            f"/api/clients/{foreign_client.id}/appointments", **self.auth
        )
        self.assertEqual(resp.status_code, 404)


class ClientHistoryApiTests(TestCase):
    def setUp(self):
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients", "agenda"])
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+391112223333")

    def test_history_groups_notes_and_sheets_under_the_visit(self):
        from apps.agenda.models import Appointment

        now = timezone.now()
        past = Appointment.objects.create(salon=self.salon, client=self.client_obj, operator=self.operator, start=now - dt.timedelta(days=10))
        future = Appointment.objects.create(salon=self.salon, client=self.client_obj, operator=self.operator, start=now + dt.timedelta(days=3))
        ClientNote.objects.create(client=self.client_obj, appointment=past, text="Nota di trattamento", author=self.user)
        ClientNote.objects.create(client=self.client_obj, text="Nota libera")
        TechnicalSheet.objects.create(client=self.client_obj, appointment=past, category="nail", treatment="Gel")

        res = self.client.get(f"/api/clients/{self.client_obj.id}/history", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        kinds = [e["kind"] for e in data["entries"]]
        self.assertEqual(kinds.count("visit"), 2)
        self.assertEqual(kinds.count("note"), 1)  # solo quella non legata a una visita
        self.assertEqual(kinds.count("sheet"), 0)  # la scheda sta dentro la visita
        visits = [e for e in data["entries"] if e["kind"] == "visit"]
        self.assertTrue(visits[0]["upcoming"])
        self.assertEqual(visits[0]["appointment"]["id"], future.id)
        past_entry = visits[1]
        self.assertEqual(len(past_entry["notes"]), 1)
        self.assertEqual(past_entry["notes"][0]["author_name"], self.user.email)
        self.assertEqual(len(past_entry["sheets"]), 1)
        self.assertEqual(past_entry["operator_name"], "Giulia Bianchi")
        self.assertEqual(data["counts"], {"visits": 1, "upcoming": 1, "notes": 2, "sheets": 1, "sales": 0})

    def test_history_of_other_salon_client_is_404(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        foreign = Client.objects.create(salon=other, first_name="X", phone="+39999")
        res = self.client.get(f"/api/clients/{foreign.id}/history", **self.auth)
        self.assertEqual(res.status_code, 404)


class SensitiveReadsNeedTheClientsScopeTests(TestCase):
    """Storico, note e schede tecniche sono i dati più delicati del gestionale:
    leggerli richiede il permesso «clienti», non il solo accesso allo staff."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        no_scope = staff_context(self.salon)
        self.request = SimpleNamespace(auth=no_scope)

    def test_history_notes_sheets_and_appointments_are_refused(self):
        from ..api import client_history

        # list_client_appointments non lo chiedeva: le visite di una persona
        # sono un dato della sua scheda, non dell'agenda del giorno, e da lì si
        # leggevano nomi, servizi e importi senza il permesso «clienti».
        for view in (client_history, list_notes, list_sheets, list_client_appointments):
            with self.assertRaises(HttpError) as caught:
                view(self.request, self.client_obj.id)
            self.assertEqual(caught.exception.status_code, 403, view.__name__)

    def test_the_owner_still_reads_everything(self):
        from ..api import client_history

        owner = SimpleNamespace(auth=staff_context(self.salon, is_owner=True))
        self.assertEqual(list_notes(owner, self.client_obj.id), [])
        self.assertEqual(list(list_sheets(owner, self.client_obj.id)), [])
        self.assertEqual(list_client_appointments(owner, self.client_obj.id), [])
        self.assertIn("entries", client_history(owner, self.client_obj.id))


class SalesFiguresNeedTheSalesScopeTests(TestCase):
    """Spesa totale e incassi di ogni visita sono dati di cassa: si leggono con
    il permesso «vendite», come la lista degli incassi (che a questi ruoli è
    già preclusa)."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )
        from apps.sales.models import Sale

        Sale.objects.create(salon=self.salon, client=self.client_obj, kind="pos", total=Decimal("80"))

    def _ctx(self, scopes):
        return SimpleNamespace(auth=staff_context(self.salon, scopes))

    def test_without_the_sales_scope_the_figures_are_zero(self):
        detail = get_client(self._ctx({"clients"}), self.client_obj.id)
        self.assertEqual(detail.total_spent, Decimal("0"))
        self.assertEqual(detail.visits, 0)
        self.assertIsNone(detail.last_visit)
        # Zero e «non ti e permesso vedere» devono restare distinguibili: senza
        # questo flag l'interfaccia mostrava «0 visite - 0 EUR spesi» e una
        # cliente storica sembrava alla prima visita, con il rischio che
        # l'operatrice le chiedesse la caparra riservata alle nuove.
        self.assertTrue(detail.stats_hidden)

    def test_with_the_sales_scope_the_figures_are_there(self):
        detail = get_client(self._ctx({"clients", "sales"}), self.client_obj.id)
        self.assertEqual(detail.total_spent, Decimal("80"))
        self.assertEqual(detail.visits, 1)
        self.assertFalse(detail.stats_hidden)

    def test_the_owner_sees_the_figures_without_the_scope(self):
        ctx = SimpleNamespace(auth=staff_context(self.salon, is_owner=True))
        detail = get_client(ctx, self.client_obj.id)
        self.assertEqual(detail.total_spent, Decimal("80"))
        self.assertFalse(detail.stats_hidden)

    def test_the_history_hides_the_takings_too(self):
        from ..api import client_history

        data = client_history(self._ctx({"clients"}), self.client_obj.id)
        self.assertEqual(data["counts"]["sales"], 0)
        self.assertEqual([e for e in data["entries"] if e["kind"] == "sale"], [])
        full = client_history(self._ctx({"clients", "sales"}), self.client_obj.id)
        self.assertEqual(full["counts"]["sales"], 1)


class ClientStatsOnRealSalesTests(TestCase):
    """client_stats su dati veri: finora era testata solo senza nessuna vendita."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )

    def _sale(self, total, line_types):
        from apps.sales.models import Sale, SaleLine

        sale = Sale.objects.create(
            salon=self.salon, client=self.client_obj, kind="pos", total=Decimal(total)
        )
        for line_type in line_types:
            SaleLine.objects.create(
                sale=sale, line_type=line_type, qty=1, unit_price=Decimal(total), amount=Decimal(total)
            )
        return sale

    def test_visits_and_total_spent_add_up(self):
        self._sale("40", ["service"])
        self._sale("25", ["product"])
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 2)
        self.assertEqual(stats["total_spent"], Decimal("65"))
        self.assertIsNotNone(stats["last_visit"])

    def test_a_gift_card_bought_at_the_counter_is_not_a_visit(self):
        """Chi regala un buono non si è seduto in poltrona. Contarlo gonfiava
        le visite e con esse le regole caparra («sotto le N visite chiedi la
        caparra»), che vedevano come abituale chi non era mai passata.
        L'incasso però resta: quei soldi il salone li ha presi."""
        self._sale("50", ["gift_card"])
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("50"))

    def test_a_visit_paid_together_with_a_gift_card_still_counts(self):
        self._sale("70", ["service", "gift_card"])
        self.assertEqual(client_stats(self.client_obj)["visits"], 1)


class ClientHistoryQueryCountTests(TestCase):
    """Lo storico non deve costare di più man mano che la cliente torna."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.ctx = SimpleNamespace(auth=staff_context(self.salon, {"clients"}, is_owner=True))
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )
        from apps.staff.models import Operator

        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi"
        )

    def _appointments(self, how_many):
        from apps.agenda.models import Appointment

        for i in range(how_many):
            Appointment.objects.create(
                salon=self.salon,
                client=self.client_obj,
                operator=self.operator,
                start=timezone.now() - dt.timedelta(days=i + 1),
            )

    def _queries(self, view, how_many):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self._appointments(how_many)
        with CaptureQueriesContext(connection) as captured:
            view(self.ctx, self.client_obj.id)
        return len(captured)

    def test_the_cost_does_not_grow_with_the_number_of_visits(self):
        """_appointment_out senza indice regali interrogava le gift card una
        volta per appuntamento, e `salon` non era in select_related: due query
        in più a visita, oltre 160 per una cliente con 80 visite."""
        from ..api import client_history

        for view in (list_client_appointments, client_history):
            with self.subTest(view=view.__name__):
                first = self._queries(view, 1)
                grown = self._queries(view, 6)
                self.assertEqual(grown, first, f"{view.__name__}: query in più per ogni visita")


# ---------------------------------------------------------------------------
# Caccia 22/09 — visite e spesa della cliente, storico con la caparra.
#
# 05-05 + 06-01 + 14-03 (lato clienti): la vendita-caparra e l'addebito no-show
# sono vendite, e `client_stats` le contava come visite e come spesa; nello
# storico la caparra compariva come «Vendita al banco». 06-05 + 17-04 (C5): lo
# storico senza permesso «vendite» deve dire che gli incassi sono nascosti.
# ---------------------------------------------------------------------------


def _request(salon, scopes=("clients", "sales")):
    return SimpleNamespace(auth=staff_context(salon, scopes))


class _Base(TestCase):
    def setUp(self):
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")

    def appointment(self, days=-1, **kw):
        from apps.agenda.models import Appointment

        defaults = dict(
            salon=self.salon,
            client=self.client_obj,
            operator=self.operator,
            start=timezone.now() + dt.timedelta(days=days),
            status="closed",
        )
        defaults.update(kw)
        return Appointment.objects.create(**defaults)

    def checkout(self, appointment, total, deducted="0"):
        from apps.sales.models import Payment, Sale, SaleLine

        total, deducted = Decimal(total), Decimal(deducted)
        sale = Sale.objects.create(
            salon=self.salon, kind="checkout", client=self.client_obj,
            appointment=appointment, total=total, deposit_deducted=deducted,
        )
        SaleLine.objects.create(sale=sale, line_type="service", qty=1, unit_price=total, amount=total)
        Payment.objects.create(sale=sale, method="cash", amount=total - deducted)
        return sale

    def counter_sale(self, total, line_type="product"):
        from apps.sales.models import Sale, SaleLine

        sale = Sale.objects.create(
            salon=self.salon, kind="pos", client=self.client_obj, total=Decimal(total)
        )
        SaleLine.objects.create(
            sale=sale, line_type=line_type, qty=1, unit_price=Decimal(total), amount=Decimal(total)
        )
        return sale

    def paid_deposit(self, appointment, amount="30"):
        from apps.sales.services import record_deposit_cashed

        appointment.deposit_status = "paid"
        appointment.deposit_amount = Decimal(amount)
        appointment.save(update_fields=["deposit_status", "deposit_amount"])
        sale = record_deposit_cashed(self.salon, appointment, method="card")
        self.assertIsNotNone(sale)
        return sale


class DepositAndNoShowAreNotVisitsTests(_Base):
    def test_deposit_then_checkout_is_one_visit_and_the_bill_once(self):
        appt = self.appointment()
        self.paid_deposit(appt)
        self.checkout(appt, "100", deducted="30")
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 1)
        self.assertEqual(stats["total_spent"], Decimal("100"))

    def test_a_paid_deposit_before_the_visit_is_not_a_visit(self):
        appt = self.appointment(days=5, status="confirmed")
        self.paid_deposit(appt)
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("0"))
        # L'ultima visita non diventa il giorno in cui è arrivata la caparra.
        self.assertIsNone(stats["last_visit"])

    def test_the_deposit_of_a_cancelled_booking_is_not_a_visit(self):
        appt = self.appointment(days=3, status="confirmed")
        self.paid_deposit(appt)
        appt.status = "cancelled"
        appt.save(update_fields=["status"])
        stats = client_stats(self.client_obj)
        self.assertEqual((stats["visits"], stats["total_spent"]), (0, Decimal("0")))

    def test_a_no_show_charge_is_neither_a_visit_nor_spending(self):
        from apps.sales.services import record_no_show_charge

        appt = self.appointment(status="no_show")
        self.assertIsNotNone(record_no_show_charge(self.salon, appt, amount=Decimal("40")))
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("0"))
        self.assertEqual(client_facts(self.client_obj)["noshow_count"], 1)

    def test_the_first_visit_deposit_rule_still_asks_until_she_has_come(self):
        """La regola rapida «Prima visita» (visite < 1): dopo la prima caparra
        pagata smetteva di chiederla, anche se la cliente non era mai venuta."""
        from apps.agenda.services import compute_deposit
        from apps.core.models import DepositRule

        DepositRule.objects.create(
            salon=self.salon, name="Prima visita", amount_type="pct", amount=Decimal("30"),
            conditions={"op": "and", "rules": [{"field": "visits", "cmp": "lt", "value": 1}]},
        )
        first = self.appointment(days=5, status="confirmed")
        self.paid_deposit(first)
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("30.00"))
        # Dopo la visita vera (conto chiuso) la caparra non si chiede più.
        first.status = "closed"
        first.start = timezone.now() - dt.timedelta(hours=2)
        first.save(update_fields=["status", "start"])
        self.checkout(first, "100", deducted="30")
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("0"))

    def test_closed_visits_and_counter_purchases_both_count(self):
        visit = self.appointment(days=-10)
        self.checkout(visit, "80")
        # Una visita chiusa arrivata da Yourang non ha vendita: è una visita lo stesso.
        synced = self.appointment(days=-3)
        self.counter_sale("25")
        self.counter_sale("50", line_type="gift_card")  # buono regalato: incasso, non visita
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 3)
        self.assertEqual(stats["total_spent"], Decimal("155"))
        self.assertIsNotNone(stats["last_visit"])
        self.assertGreaterEqual(stats["last_visit"], synced.start)

    def test_last_visit_is_the_visit_not_the_later_deposit(self):
        visit = self.appointment(days=-20)
        self.checkout(visit, "60")
        upcoming = self.appointment(days=4, status="confirmed")
        self.paid_deposit(upcoming)
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["last_visit"], visit.start)

    def test_the_client_card_shows_the_corrected_figures(self):
        appt = self.appointment()
        self.paid_deposit(appt)
        self.checkout(appt, "100", deducted="30")
        detail = get_client(_request(self.salon), self.client_obj.id)
        self.assertEqual((detail.visits, detail.total_spent), (1, Decimal("100")))


class HistoryDepositTests(_Base):
    def test_the_deposit_sale_belongs_to_its_visit(self):
        appt = self.appointment()
        deposit = self.paid_deposit(appt)
        sale = self.checkout(appt, "100", deducted="30")
        data = client_history(_request(self.salon), self.client_obj.id)
        kinds = [e["kind"] for e in data["entries"]]
        self.assertNotIn("sale", kinds)  # nessuna finta «Vendita al banco»
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        self.assertEqual(visit["sale"]["id"], sale.id)
        self.assertEqual(visit["deposit_sale"]["id"], deposit.id)
        self.assertEqual(data["counts"]["sales"], 1)

    def test_a_deposit_for_an_upcoming_visit_waits_in_that_visit(self):
        appt = self.appointment(days=3, status="confirmed")
        deposit = self.paid_deposit(appt)
        data = client_history(_request(self.salon), self.client_obj.id)
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        self.assertTrue(visit["upcoming"])
        self.assertIsNone(visit["sale"])
        self.assertEqual(visit["deposit_sale"]["id"], deposit.id)
        self.assertEqual([e for e in data["entries"] if e["kind"] == "sale"], [])

    def test_a_real_counter_sale_is_still_listed(self):
        sale = self.counter_sale("25")
        data = client_history(_request(self.salon), self.client_obj.id)
        self.assertEqual([e["sale"]["id"] for e in data["entries"] if e["kind"] == "sale"], [sale.id])


class HistorySalesHiddenTests(_Base):
    """C5: `sales_hidden` distingue «incasso nascosto» da «non incassato»."""

    def test_without_the_sales_scope_the_history_says_so(self):
        appt = self.appointment()
        self.checkout(appt, "50")
        data = client_history(_request(self.salon, scopes=("clients", "agenda")), self.client_obj.id)
        self.assertTrue(data["sales_hidden"])
        visit = next(e for e in data["entries"] if e["kind"] == "visit")
        self.assertIsNone(visit["sale"])
        self.assertIsNone(visit["deposit_sale"])

    def test_with_the_sales_scope_nothing_is_hidden(self):
        appt = self.appointment()
        self.checkout(appt, "50")
        data = client_history(_request(self.salon), self.client_obj.id)
        self.assertFalse(data["sales_hidden"])
        self.assertIsNotNone(next(e for e in data["entries"] if e["kind"] == "visit")["sale"])

    def test_the_owner_sees_the_sales(self):
        owner = SimpleNamespace(auth=staff_context(self.salon, is_owner=True))
        data = client_history(owner, self.client_obj.id)
        self.assertFalse(data["sales_hidden"])
