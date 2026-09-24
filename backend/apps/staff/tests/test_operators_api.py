"""Operatrici dall'API: creazione e modifica con la loro validazione, colore
in agenda, elenco (anche delle disattivate), endpoint pubblico
/public/operators (scelta stilista in prenotazione).

Caccia del 22/09:
- 09-03 / 16-04 / 04-04: le operatrici pubbliche sono quelle della sede su cui
  l'app prenota;
- 09-05 / 15-05 (C8): `include_inactive` per ritrovare le disattivate;
- 09-09 (C19): la PUT applica solo i campi presenti.
"""

import json
from decimal import Decimal

from django.test import TestCase

from apps.core.models import Location, Salon
from common.testing import bearer

from ..models import Operator, WeeklyShift
from .base import StaffApiTestCase, _StaffSetup


class PublicOperatorsApiTests(TestCase):
    """GET /api/staff/public/operators: elenco operatrici attive, senza auth."""

    def setUp(self):
        from apps.catalog.models import Service, ServiceCategory

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.service = Service.objects.create(
            salon=self.salon,
            category=category,
            name_it="Manicure",
            duration_min=30,
            price=Decimal("20.00"),
        )
        self.op_active = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Rossi", color="#AACCEE"
        )
        self.op_active.services.add(self.service)
        self.op_inactive = Operator.objects.create(
            salon=self.salon, first_name="Marta", last_name="Verdi", active=False
        )

    def test_public_operators_no_auth(self):
        resp = self.client.get(f"/api/staff/public/operators?salon={self.salon.slug}")
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        ids = [o["id"] for o in data]
        self.assertIn(self.op_active.id, ids)
        self.assertNotIn(self.op_inactive.id, ids)
        active = next(o for o in data if o["id"] == self.op_active.id)
        self.assertEqual(active["service_ids"], [self.service.id])
        self.assertEqual(active["initials"], "GR")
        self.assertEqual(active["color"], "#AACCEE")

    def test_public_operators_unknown_salon_404(self):
        resp = self.client.get("/api/staff/public/operators?salon=inesistente")
        self.assertEqual(resp.status_code, 404, resp.content)


class OperatorColorApiTests(TestCase):
    """Il colore dell'operatrice in agenda è condiviso fra le postazioni."""

    def test_patch_color_is_persisted_and_logged(self):
        from apps.accounts.models import Membership, Role, User
        from apps.core.models import ActivityLog

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        operator = Operator.objects.create(salon=salon, first_name="Giulia", last_name="Rossi", color="#AAAAAA")
        user = User.objects.create_user(email="front@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=salon, role=role)
        auth = bearer(user, salon)
        res = self.client.patch(f"/api/staff/{operator.id}/color", data='{"color": "#c9b8f2"}', content_type="application/json", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        operator.refresh_from_db()
        self.assertEqual(operator.color, "#C9B8F2")
        self.assertTrue(ActivityLog.objects.filter(salon=salon, type="operator.updated").exists())
        res = self.client.patch(f"/api/staff/{operator.id}/color", data='{"color": "rosso"}', content_type="application/json", **auth)
        self.assertEqual(res.status_code, 400)


class OperatorValidationTests(StaffApiTestCase):
    """Colore, ciclo e ordine fuori range sono 400, non errori del database."""

    def test_invalid_color_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(color="viola"),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(Operator.objects.exists())

    def test_zero_cycle_weeks_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(cycle_weeks=0),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_absurd_cycle_weeks_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(cycle_weeks=100000),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_negative_order_is_refused(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(order=-3),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_valid_payload_creates_the_operator(self):
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(cycle_weeks=2),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Operator.objects.get().cycle_weeks, 2)

    def test_a_user_cannot_be_linked_to_two_operators(self):
        first = Operator.objects.create(
            salon=self.salon, first_name="Anna", last_name="Bianchi", user=self.user
        )
        res = self.client.post(
            "/api/staff/",
            data=self.operator_payload(user_id=self.user.id),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("Anna", res.json()["detail"])
        self.assertEqual(Operator.objects.count(), 1)
        first.refresh_from_db()
        self.assertEqual(first.user_id, self.user.id)


class ColumnLimitsTests(StaffApiTestCase):
    """Bug sospetti del 24/09, voce 21: gli schemi di operatrice e assenza non
    limitavano i testi che finiscono in colonne strette (nome e cognome 80,
    ruolo 120, nota dell'assenza 255). Su PostgreSQL la riga veniva rifiutata:
    500 invece di un errore che dice quale campo correggere."""

    def _send(self, method, url, body):
        return getattr(self.client, method)(
            url, data=json.dumps(body), content_type="application/json", **self.auth
        )

    def test_operator_texts_are_as_long_as_their_columns(self):
        operator = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="Bianchi")
        for field, size in (("first_name", 80), ("last_name", 80), ("role_title", 120)):
            res = self._send("post", "/api/staff/", self.operator_payload(**{field: "x" * (size + 1)}))
            self.assertEqual(res.status_code, 422, field)
            res = self._send("put", f"/api/staff/{operator.id}", {field: "x" * (size + 1)})
            self.assertEqual(res.status_code, 422, field)
        self.assertEqual(Operator.objects.count(), 1)
        operator.refresh_from_db()
        self.assertEqual((operator.first_name, operator.last_name, operator.role_title), ("Anna", "Bianchi", ""))
        full = self.operator_payload(first_name="x" * 80, last_name="x" * 80, role_title="x" * 120)
        self.assertEqual(self._send("post", "/api/staff/", full).status_code, 200)

    def test_the_absence_note_is_as_long_as_its_column(self):
        operator = Operator.objects.create(salon=self.salon, first_name="Anna", last_name="Bianchi")
        body = {"date_from": "2026-08-10", "date_to": "2026-08-14", "type": "vacation", "note": "x" * 256}
        url = f"/api/staff/{operator.id}/absences"
        self.assertEqual(self._send("post", url, body).status_code, 422)
        self.assertFalse(operator.absences.exists())
        created = self._send("post", url, {**body, "note": "x" * 255})
        self.assertEqual(created.status_code, 200, created.content)
        res = self._send("put", f"{url}/{created.json()['id']}", body)
        self.assertEqual(res.status_code, 422, res.content)


class OperatorListQueryCountTests(StaffApiTestCase):
    """La lista operatrici è la pagina che il salone tiene aperta tutto il
    giorno: il numero di query non deve crescere con le operatrici."""

    scopes = ["team", "agenda"]

    def _make_operators(self, how_many):
        for index in range(how_many):
            operator = Operator.objects.create(
                salon=self.salon, first_name=f"Op{index}", last_name="Rossi"
            )
            WeeklyShift.objects.create(
                operator=operator, week_index=0, weekday=1, start_min=540, end_min=1080
            )

    def _count_queries(self, expected_rows):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as captured:
            res = self.client.get("/api/staff/", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()), expected_rows)
        return len(captured)

    def test_query_count_does_not_grow_with_the_team(self):
        self._make_operators(2)
        with_two = self._count_queries(2)
        self._make_operators(6)
        with_eight = self._count_queries(8)
        self.assertEqual(with_two, with_eight)

    def test_list_works_without_salon_settings(self):
        self._make_operators(1)
        res = self.client.get("/api/staff/", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()), 1)
        self.assertIn("on_shift", res.json()[0])


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
