"""Caccia del 22/09: API staff.

- 09-01 / 10-09 (C6): incassi, spesa delle clienti e costo orario solo a chi ha
  il permesso; agli altri null (mai 0) con `cash_hidden`;
- 09-03 / 16-04 / 04-04: le operatrici pubbliche sono quelle della sede su cui
  l'app prenota;
- 09-04: chi fa un servizio secondario conta la visita;
- 09-05 / 15-05 (C8): `include_inactive` per ritrovare le disattivate;
- 09-09 (C19): la PUT applica solo i campi presenti;
- 18-14: i turni si sostituiscono sotto lock, sull'operatrice riletta.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest import mock

from django.test import TestCase
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Location, Salon
from apps.sales.models import Sale, SaleLine
from common.auth import create_staff_tokens

from ..models import Operator, WeeklyShift
from ..services import served_clients, today_clients_by_operator


def bearer(user, salon):
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


class _StaffSetup(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.color = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Colore", duration_min=60, price=Decimal("60")
        )
        self.cut = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Taglio", duration_min=30, price=Decimal("30")
        )
        self.anna = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="A")
        self.bea = Operator.objects.create(
            salon=self.salon, first_name="Bea", last_name="B", hourly_cost=Decimal("18.50")
        )
        self.xenia = Client.objects.create(salon=self.salon, first_name="Xenia", phone="+393331112233")

    def _member(self, email, scopes=None, owner=False):
        user = User.objects.create_user(email=email, password="x-Segreta-1")
        role = None
        if scopes is not None:
            role = Role.objects.create(salon=self.salon, name=email, scopes=scopes)
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=owner)
        return bearer(user, self.salon)

    def _visit(self, start, items):
        """Visita con i servizi dati come [(servizio, operatrice), …]; la principale è la prima."""
        appt = Appointment.objects.create(
            salon=self.salon, client=self.xenia, operator=items[0][1], start=start
        )
        for order, (service, operator) in enumerate(items):
            AppointmentService.objects.create(
                appointment=appt, service=service, operator=operator,
                duration_min=service.duration_min, price=service.price, order=order,
            )
        return appt


class CashDataVisibilityTests(_StaffSetup):
    """C6: il ruolo «Operatrice» è dato proprio perché non veda gli incassi."""

    def setUp(self):
        super().setUp()
        self._visit(timezone.now() - dt.timedelta(days=1), [(self.cut, self.bea)])
        sale = Sale.objects.create(salon=self.salon, kind="pos", client=self.xenia, total=Decimal("250"))
        SaleLine.objects.create(
            sale=sale, operator=self.bea, line_type="service", qty=1,
            unit_price=Decimal("250"), amount=Decimal("250"),
        )

    def _bea_row(self, auth):
        res = self.client.get("/api/staff/", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        return next(o for o in res.json() if o["id"] == self.bea.id)

    def test_operatrice_role_sees_no_cash_nor_salary(self):
        auth = self._member("junior@parlour.it", ["agenda", "clients"])
        row = self._bea_row(auth)
        self.assertIsNone(row["month_revenue"])
        self.assertIsNone(row["hourly_cost"])
        self.assertIs(row["cash_hidden"], True)
        self.assertEqual(row["today_clients"], 0)  # non è un dato di cassa: resta

        perf = self.client.get(f"/api/staff/{self.bea.id}/performance?months=36", **auth).json()
        self.assertEqual(len(perf), 36)
        self.assertTrue(all(m["revenue"] is None and m["cash_hidden"] for m in perf))

        served = self.client.get(f"/api/staff/{self.bea.id}/clients", **auth).json()
        self.assertEqual(len(served), 1)
        self.assertEqual(served[0]["first_name"], "Xenia")
        for key in ("total_spent", "visits", "last_visit"):
            self.assertIsNone(served[0][key], key)
        self.assertIs(served[0]["cash_hidden"], True)

        detail = self.client.get(f"/api/staff/{self.bea.id}", **auth).json()
        self.assertIsNone(detail["hourly_cost"])
        self.assertIs(detail["cash_hidden"], True)

    def test_sales_scope_sees_the_cash_but_not_the_salary(self):
        auth = self._member("cassa@parlour.it", ["agenda", "clients", "sales"])
        row = self._bea_row(auth)
        self.assertEqual(Decimal(row["month_revenue"]), Decimal("250"))
        self.assertIsNone(row["hourly_cost"])
        self.assertIs(row["cash_hidden"], True)
        served = self.client.get(f"/api/staff/{self.bea.id}/clients", **auth).json()
        self.assertEqual(Decimal(served[0]["total_spent"]), Decimal("250"))
        self.assertEqual(served[0]["visits"], 1)
        self.assertIs(served[0]["cash_hidden"], False)
        perf = self.client.get(f"/api/staff/{self.bea.id}/performance", **auth).json()
        self.assertEqual(Decimal(perf[-1]["revenue"]), Decimal("250"))

    def test_team_scope_sees_the_salary_but_not_the_cash(self):
        auth = self._member("hr@parlour.it", ["team"])
        row = self._bea_row(auth)
        self.assertEqual(Decimal(row["hourly_cost"]), Decimal("18.50"))
        self.assertIsNone(row["month_revenue"])
        self.assertIs(row["cash_hidden"], True)

    def test_the_owner_sees_everything(self):
        auth = self._member("titolare@parlour.it", owner=True)
        row = self._bea_row(auth)
        self.assertEqual(Decimal(row["month_revenue"]), Decimal("250"))
        self.assertEqual(Decimal(row["hourly_cost"]), Decimal("18.50"))
        self.assertIs(row["cash_hidden"], False)

    def test_the_agenda_colour_patch_does_not_leak_the_salary(self):
        auth = self._member("junior@parlour.it", ["agenda", "clients"])
        res = self.client.patch(
            f"/api/staff/{self.bea.id}/color", data=json.dumps({"color": "#112233"}),
            content_type="application/json", **auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIsNone(res.json()["hourly_cost"])


class PublicOperatorsLocationTests(_StaffSetup):
    """09-03: dall'app si prenota sulla sede predefinita."""

    def _public_ids(self):
        res = self.client.get(f"/api/staff/public/operators?salon={self.salon.slug}")
        self.assertEqual(res.status_code, 200, res.content)
        return {o["id"] for o in res.json()}

    def test_an_operator_of_another_location_is_not_offered(self):
        main = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        second = Location.objects.create(salon=self.salon, name="Mare")
        self.anna.location = main
        self.anna.save(update_fields=["location"])
        giulia = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="G", location=second
        )
        ids = self._public_ids()
        self.assertIn(self.anna.id, ids)
        self.assertIn(self.bea.id, ids)  # senza sede: lavora ovunque
        self.assertNotIn(giulia.id, ids)

    def test_a_salon_without_locations_lists_every_active_operator(self):
        Operator.objects.create(salon=self.salon, first_name="Spenta", last_name="S", active=False)
        self.assertEqual(self._public_ids(), {self.anna.id, self.bea.id})


class SecondaryOperatorTests(_StaffSetup):
    """09-04: Bea fa i tagli dopo i colori di Anna."""

    def test_the_second_operator_counts_today(self):
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon, [(self.color, self.anna), (self.cut, self.bea)])
        counts = today_clients_by_operator([self.anna, self.bea], today)
        self.assertEqual(counts, {self.anna.id: 1, self.bea.id: 1})

    def test_two_services_of_the_same_visit_count_once(self):
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon, [(self.color, self.anna), (self.cut, self.bea), (self.color, self.bea)])
        self.assertEqual(today_clients_by_operator([self.bea], today), {self.bea.id: 1})

    def test_served_clients_include_the_secondary_visits(self):
        past = timezone.now() - dt.timedelta(days=3)
        self._visit(past, [(self.color, self.anna), (self.cut, self.bea), (self.cut, self.bea)])
        rows = served_clients(self.bea)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["client_id"], self.xenia.id)
        self.assertEqual(rows[0]["visits"], 1)
        # E per la principale nulla cambia.
        self.assertEqual(served_clients(self.anna)[0]["visits"], 1)

    def test_the_list_shows_the_secondary_operator_clients(self):
        auth = self._member("titolare@parlour.it", owner=True)
        today = timezone.localdate()
        noon = timezone.make_aware(dt.datetime.combine(today, dt.time(12, 0)))
        self._visit(noon, [(self.color, self.anna), (self.cut, self.bea)])
        rows = {o["id"]: o for o in self.client.get("/api/staff/", **auth).json()}
        self.assertEqual(rows[self.bea.id]["today_clients"], 1)


class InactiveOperatorsTests(_StaffSetup):
    """09-05 + 15-05 (C8): la disattivata si ritrova e si riattiva."""

    def setUp(self):
        super().setUp()
        self.auth = self._member("titolare@parlour.it", owner=True)
        self.bea.active = False
        self.bea.save(update_fields=["active"])

    def test_the_default_list_keeps_only_the_active_ones(self):
        ids = {o["id"] for o in self.client.get("/api/staff/", **self.auth).json()}
        self.assertEqual(ids, {self.anna.id})

    def test_include_inactive_brings_her_back_and_she_can_be_reactivated(self):
        rows = self.client.get("/api/staff/?include_inactive=true", **self.auth).json()
        bea = next(o for o in rows if o["id"] == self.bea.id)
        self.assertIs(bea["active"], False)
        res = self.client.put(
            f"/api/staff/{self.bea.id}", data=json.dumps({"active": True}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.bea.refresh_from_db()
        self.assertTrue(self.bea.active)


class PartialOperatorUpdateTests(_StaffSetup):
    """09-09 (C19): la scheda salvava colore e servizi letti all'apertura."""

    def setUp(self):
        super().setUp()
        self.auth = self._member("titolare@parlour.it", owner=True)
        self.bea.services.add(self.cut)

    def _put(self, body):
        return self.client.put(
            f"/api/staff/{self.bea.id}", data=json.dumps(body), content_type="application/json", **self.auth
        )

    def test_changing_the_hourly_cost_keeps_what_others_changed_meanwhile(self):
        # Intanto: il colore cambiato dall'agenda e l'abilitazione al servizio
        # nuovo data dal listino.
        self.bea.color = "#112233"
        self.bea.save(update_fields=["color"])
        self.bea.services.add(self.color)
        res = self._put({"hourly_cost": "21.00"})
        self.assertEqual(res.status_code, 200, res.content)
        self.bea.refresh_from_db()
        self.assertEqual(self.bea.hourly_cost, Decimal("21.00"))
        self.assertEqual(self.bea.color, "#112233")
        self.assertEqual(set(self.bea.services.values_list("id", flat=True)), {self.cut.id, self.color.id})

    def test_service_ids_are_replaced_only_when_sent(self):
        res = self._put({"service_ids": [self.color.id]})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(list(self.bea.services.values_list("id", flat=True)), [self.color.id])

    def test_nullable_fields_accept_null_and_the_others_do_not(self):
        location = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        self.bea.location = location
        self.bea.save(update_fields=["location"])
        self.assertEqual(self._put({"location_id": None}).status_code, 200)
        self.bea.refresh_from_db()
        self.assertIsNone(self.bea.location_id)
        self.assertEqual(self._put({"first_name": None}).status_code, 400)
        self.assertEqual(self._put({"color": "rosso"}).status_code, 400)
        self.assertEqual(self._put({"cycle_weeks": 0}).status_code, 400)
        self.bea.refresh_from_db()
        self.assertEqual(self.bea.first_name, "Bea")

    def test_a_full_body_still_works(self):
        body = {
            "first_name": "Beatrice", "last_name": "B", "color": "#a5b4fc", "role_title": "Senior",
            "location_id": None, "user_id": None, "service_ids": [], "hourly_cost": "19",
            "cycle_weeks": 1, "active": True, "order": 3,
        }
        res = self._put(body)
        self.assertEqual(res.status_code, 200, res.content)
        self.bea.refresh_from_db()
        self.assertEqual((self.bea.first_name, self.bea.color, self.bea.order), ("Beatrice", "#A5B4FC", 3))
        self.assertFalse(self.bea.services.exists())

    def test_shrinking_the_cycle_still_removes_the_orphan_shifts(self):
        self.bea.cycle_weeks = 2
        self.bea.save(update_fields=["cycle_weeks"])
        WeeklyShift.objects.create(operator=self.bea, week_index=1, weekday=0, start_min=540, end_min=600)
        self.assertEqual(self._put({"cycle_weeks": 1}).status_code, 200)
        self.assertFalse(WeeklyShift.objects.filter(operator=self.bea, week_index=1).exists())


class ReplaceShiftsTests(_StaffSetup):
    """18-14: i turni si sostituiscono sotto lock, sull'operatrice riletta."""

    def test_rows_are_validated_against_the_cycle_read_under_the_lock(self):
        from .. import api as staff_api

        auth = self._member("titolare@parlour.it", owner=True)
        self.bea.cycle_weeks = 2
        self.bea.save(update_fields=["cycle_weeks"])
        real_salon_get = staff_api.salon_get

        def read_then_cycle_shrinks(model, ctx, pk, **kwargs):
            obj = real_salon_get(model, ctx, pk, **kwargs)
            if model is Operator:
                # Un'altra postazione riduce il ciclo a una settimana subito dopo.
                Operator.objects.filter(pk=obj.pk).update(cycle_weeks=1)
            return obj

        body = {"shifts": [
            {"week_index": 0, "weekday": 0, "start_min": 540, "end_min": 1080},
            {"week_index": 1, "weekday": 0, "start_min": 540, "end_min": 1080},
        ]}
        with mock.patch.object(staff_api, "salon_get", side_effect=read_then_cycle_shrinks):
            res = self.client.put(
                f"/api/staff/{self.bea.id}/shifts", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(WeeklyShift.objects.filter(operator=self.bea).exists())
