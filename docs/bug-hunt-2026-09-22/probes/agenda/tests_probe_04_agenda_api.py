"""Probe temporanei del revisore 04 (API agenda). Da cancellare a fine lavoro.

Ogni test afferma il comportamento CORRETTO: se fallisce, il difetto è confermato.
"""

import datetime as dt
import json
from decimal import Decimal

from django.test import Client as HttpClient
from django.utils import timezone

from common.auth import create_client_tokens, create_staff_tokens

from .models import Appointment, AppointmentService, Pause
from .services import create_appointment
from .tests import AgendaTestBase, _aware


class Probe04(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="probe04@theparlour.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Front desk probe", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.staff = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"}
        self.cli = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}

    def _post(self, url, body, auth):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **auth)

    # ---- 1. riassegnare dalla colonna di un'operatrice disattivata --------------
    def test_move_reassign_from_inactive_operator(self):
        from apps.staff.models import Operator

        op3 = Operator.objects.create(salon=self.salon, first_name="Nuova", last_name="Collega")
        op3.services.add(self.svc60)
        mapping = {self.op1.id: [(8 * 60, 20 * 60)], op3.id: [(8 * 60, 20 * 60)]}
        with self._windows(mapping):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            self.op1.active = False
            self.op1.save(update_fields=["active"])
            # stesso corpo che manda la griglia (index.jsx moveAppt) e il pannello (applyMove)
            res = self._post(
                f"/api/agenda/appointments/{appt.id}/move",
                {"start": _aware(self.day, 10).isoformat(), "operator_id": op3.id,
                 "from_operator_id": self.op1.id, "force": False},
                self.staff,
            )
            # senza from_operator_id (come prima del commit 0f7d39a) passa
            res_old = self._post(
                f"/api/agenda/appointments/{appt.id}/move",
                {"start": _aware(self.day, 10).isoformat(), "operator_id": op3.id, "force": False},
                self.staff,
            )
        print("\n[probe1] con from_operator_id:", res.status_code, "| senza:", res_old.status_code)
        self.assertEqual(res.status_code, 200, res.content)

    # ---- 2. /released senza scope agenda --------------------------------------
    def test_released_requires_agenda_scope(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="contabile@theparlour.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Contabile", scopes=["inventory"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1,
            start=_aware(self.day, 10), status=Appointment.Status.CANCELLED, auto_released=True,
        )
        AppointmentService.objects.create(
            appointment=appt, service=self.svc60, operator=self.op1, duration_min=60, price=Decimal("50"),
        )
        day = self.client.get("/api/agenda/day", {"date": self.day.isoformat()}, **auth)
        rel = self.client.get("/api/agenda/released", **auth)
        print("\n[probe2] /day:", day.status_code, "| /released:", rel.status_code, rel.content[:160])
        self.assertEqual(rel.status_code, 403)

    # ---- 3. date ben formate ma inesistenti -----------------------------------
    def test_invalid_calendar_date_is_400(self):
        http = HttpClient(raise_request_exception=False)
        codes = {}
        for url, params in [
            ("/api/agenda/day", {"date": "2026-02-30"}),
            ("/api/agenda/week", {"start": "2026-13-01"}),
            ("/api/agenda/range", {"start": "2026-09-01", "end": "2026-09-31"}),
            ("/api/agenda/pauses", {"date": "2026-04-31"}),
            ("/api/agenda/week", {"start": "9999-12-30"}),
        ]:
            codes[(url, tuple(params.values()))] = http.get(url, params, **self.staff).status_code
        cli_codes = http.get(
            "/api/agenda/client/availability",
            {"date": "2026-02-29", "items": json.dumps([{"service_id": self.svc60.id}])},
            **self.cli,
        ).status_code
        pub = http.get(
            "/api/agenda/public/availability",
            {"salon": self.salon.slug, "date": "2027-02-29", "items": json.dumps([{"service_id": self.svc60.id}])},
        ).status_code
        print("\n[probe3]", codes, "client:", cli_codes, "public:", pub)
        self.assertTrue(all(c == 400 for c in codes.values()), codes)

    # ---- 4. app cliente: spostare una visita di un'operatrice uscita ----------
    def test_client_move_when_operator_left(self):
        from apps.staff.models import Operator

        op3 = Operator.objects.create(salon=self.salon, first_name="Nuova", last_name="Collega")
        op3.services.add(self.svc60)
        # la vecchia operatrice aveva il turno solo al mattino, la nuova tutto il giorno
        mapping = {self.op1.id: [(9 * 60, 12 * 60)], op3.id: [(9 * 60, 18 * 60)]}
        with self._windows(mapping):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="app",
            )
            self.op1.active = False
            self.op1.save(update_fields=["active"])
            res = self.client.get(
                "/api/agenda/client/availability",
                {"date": self.day.isoformat(), "items": json.dumps([{"service_id": self.svc60.id, "operator_id": self.op1.id}]),
                 "exclude_appointment_id": appt.id},
                **self.cli,
            )
            slots = res.json()
            afternoon = [s for s in slots if s["start"] == _aware(self.day, 15).isoformat()]
            move = self._post(
                f"/api/agenda/client/appointments/{appt.id}/move",
                {"start": _aware(self.day, 15).isoformat()}, self.cli,
            )
            morning = self._post(
                f"/api/agenda/client/appointments/{appt.id}/move",
                {"start": _aware(self.day, 11).isoformat()}, self.cli,
            )
        appt.refresh_from_db()
        print("\n[probe4] slot 15:00 proposto:", afternoon, "| move 15:00:", move.status_code,
              "| move 11:00:", morning.status_code, "operatore finale:", appt.operator_id,
              "(inattiva:", self.op1.id, ")", "items:", list(appt.items.values_list("operator_id", flat=True)))
        self.assertTrue(afternoon, "lo slot delle 15 deve essere proposto")
        self.assertEqual(move.status_code, 200, move.content)

    # ---- 5. risposte dell'app cliente con la nota interna dello staff ---------
    def test_client_responses_do_not_leak_staff_note(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard", note="Cliente morosa: chiedere prima il saldo",
            )
            move = self._post(
                f"/api/agenda/client/appointments/{appt.id}/move",
                {"start": _aware(self.day, 12).isoformat()}, self.cli,
            )
            cancel = self._post(f"/api/agenda/client/appointments/{appt.id}/cancel", {}, self.cli)
        print("\n[probe5] move note:", move.json().get("note"), "| cancel note:", cancel.json().get("note"),
              "| keys:", sorted(move.json().keys()))
        self.assertNotIn("note", move.json())

    # ---- 6. app cliente sulla posa altrui con operatrice scelta ---------------
    def test_client_booking_on_other_soak(self):
        from apps.catalog.models import Service

        color = Service.objects.create(
            salon=self.salon, category=self.svc60.category, name_it="Colore",
            duration_min=30, soak_min=30, price=Decimal("40"),
        )
        self.op1.services.add(color)
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000099")
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            create_appointment(
                self.salon, other, [{"service_id": color.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )  # attivo 10:00-10:30, posa 10:30-11:00
            items = [{"service_id": self.svc30.id, "operator_id": self.op1.id}]
            slots = self.client.get(
                "/api/agenda/client/availability",
                {"date": self.day.isoformat(), "items": json.dumps(items)}, **self.cli,
            ).json()
            offered = _aware(self.day, 10, 30).isoformat() in [s["start"] for s in slots]
            res = self._post(
                "/api/agenda/client/appointments",
                {"items": items, "start": _aware(self.day, 10, 30).isoformat()}, self.cli,
            )
            auto = self._post(
                "/api/agenda/client/appointments",
                {"items": [{"service_id": self.svc30.id}], "start": _aware(self.day, 10, 30).isoformat()}, self.cli,
            )
        print("\n[probe6] 10:30 offerto:", offered, "| POST con operatrice:", res.status_code,
              "| POST prima disponibile:", auto.status_code)
        self.assertNotEqual(res.status_code, 200)

    # ---- 7. salone con due sedi: stilista dell'altra sede ---------------------
    def test_client_availability_other_location_stylist(self):
        from apps.core.models import Location
        from apps.staff.models import Operator

        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")
        self.op1.location = centro
        self.op1.save(update_fields=["location"])
        op_nord = Operator.objects.create(salon=self.salon, first_name="Lia", last_name="Nord", location=nord)
        op_nord.services.add(self.svc60)
        items = [{"service_id": self.svc60.id, "operator_id": op_nord.id}]
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)], op_nord.id: [(9 * 60, 18 * 60)]}):
            slots = self.client.get(
                "/api/agenda/client/availability",
                {"date": self.day.isoformat(), "items": json.dumps(items)}, **self.cli,
            ).json()
            first = slots[0] if slots else None
            res = self._post(
                "/api/agenda/client/appointments",
                {"items": items, "start": first["start"]}, self.cli,
            ) if first else None
        print("\n[probe7] slot:", len(slots), "assignment:", first and first["assignment"],
              "(scelta:", op_nord.id, ") | POST:", res and res.status_code, res and res.content[:120])
        self.assertTrue(not slots or res.status_code == 200)

    # ---- 8. vista giorno per sede: colonne di operatrici dell'altra sede ------
    def test_day_location_filter_pause_of_other_location(self):
        from apps.core.models import Location
        from apps.staff.models import Operator

        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")
        self.op1.location = centro
        self.op1.save(update_fields=["location"])
        op_nord = Operator.objects.create(salon=self.salon, first_name="Lia", last_name="Nord", location=nord)
        Pause.objects.create(salon=self.salon, operator=op_nord, start=_aware(self.day, 13), duration_min=60)
        with self._windows({}):
            rows = self.client.get(
                "/api/agenda/day", {"date": self.day.isoformat(), "location_id": centro.id}, **self.staff,
            ).json()
        cols = [(r["operator"]["id"], r["operator"]["name"], r["operator"]["inactive"]) for r in rows]
        print("\n[probe8] colonne sede Centro:", cols)
        self.assertNotIn(op_nord.id, [c[0] for c in cols])

    # ---- 9. vista giorno: servizio di un'operatrice uscita che non è la principale
    def test_day_secondary_item_of_inactive_operator(self):
        from apps.staff.models import Operator

        op3 = Operator.objects.create(salon=self.salon, first_name="Uscita", last_name="Dal team")
        op3.services.add(self.svc30)
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)], op3.id: [(8 * 60, 20 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id},
                 {"service_id": self.svc30.id, "operator_id": op3.id}],
                _aware(self.day, 10), via="dashboard",
            )
            op3.active = False
            op3.save(update_fields=["active"])
            rows = self.client.get("/api/agenda/day", {"date": self.day.isoformat()}, **self.staff).json()
        col_ids = [r["operator"]["id"] for r in rows]
        print("\n[probe9] colonne:", col_ids, "| operatrici dei servizi:",
              list(appt.items.values_list("operator_id", flat=True)))
        self.assertIn(op3.id, col_ids)


class Probe04Queries(AgendaTestBase):
    """Numero di query delle viste al crescere degli appuntamenti."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="probe04q@theparlour.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Front desk probe q", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.staff = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _seed(self, n):
        from apps.clients.models import Client

        base = Client.objects.count()
        for i in range(base, base + n):
            c = Client.objects.create(salon=self.salon, first_name=f"C{i}", last_name="X", phone=f"+39333{i:07d}")
            a = Appointment.objects.create(
                salon=self.salon, client=c, operator=self.op1,
                start=_aware(self.day, 8) + dt.timedelta(minutes=10 * (i % 40)),
            )
            AppointmentService.objects.create(appointment=a, service=self.svc60, operator=self.op1, duration_min=60, price=Decimal("50"))
            AppointmentService.objects.create(appointment=a, service=self.svc30, operator=self.op2, duration_min=30, price=Decimal("30"), order=1)

    def _count(self, url, params):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        with CaptureQueriesContext(connection) as ctx:
            res = self.client.get(url, params, **self.staff)
        self.assertEqual(res.status_code, 200, res.content[:300])
        return len(ctx.captured_queries)

    def test_query_counts(self):
        monday = self.day - dt.timedelta(days=self.day.weekday())
        out = {}
        for n in (3, 30):
            self._seed(n if n == 3 else n - 3)
            out[n] = (
                self._count("/api/agenda/day", {"date": self.day.isoformat()}),
                self._count("/api/agenda/week", {"start": monday.isoformat()}),
                self._count("/api/agenda/range", {"start": monday.isoformat(), "end": (monday + dt.timedelta(days=41)).isoformat()}),
                self._count("/api/agenda/released", {}),
            )
        print("\n[probe-q] query day/week/range/released:", out)
        self.assertEqual(out[3], out[30])


class Probe04DepositPast(AgendaTestBase):
    def test_deposit_link_for_walk_in_now(self):
        from unittest.mock import patch

        from apps.accounts.models import Membership, Role, User
        from apps.core.models import DepositRule, OutboxEvent

        user = User.objects.create_user(email="probe04d@theparlour.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Front desk probe d", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        DepositRule.objects.create(salon=self.salon, name="Tutte", conditions={}, amount_type="fixed", amount=Decimal("10"))
        self.client_obj.deposit_always = True
        self.client_obj.save()
        start = timezone.now().replace(second=0, microsecond=0) - dt.timedelta(minutes=5)
        with self._windows({self.op1.id: [(0, 24 * 60)]}), \
                patch("apps.sales.stripe_service.payments_enabled", return_value=True), \
                patch("apps.sales.stripe_service.create_deposit_checkout", return_value=("https://pay.example/x", "cs_1")):
            res = self.client.post(
                "/api/agenda/appointments",
                data=json.dumps({"client_id": self.client_obj.id,
                                 "items": [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
                                 "start": start.isoformat(), "force": True}),
                content_type="application/json", **auth,
            )
        body = res.json()
        events = list(OutboxEvent.objects.values_list("event_type", flat=True))
        print("\n[probe-dep] status:", res.status_code, "deposit:", body.get("deposit_status"), body.get("deposit_amount"),
              "due:", body.get("deposit_due_at"), "link:", body.get("deposit_payment_link"), "events:", events)
        self.assertNotIn("deposit.payment_link", events)


class Probe04EditNoEligible(AgendaTestBase):
    def test_put_new_item_without_eligible_operator(self):
        from apps.accounts.models import Membership, Role, User
        from apps.catalog.models import Service

        user = User.objects.create_user(email="probe04e@theparlour.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Front desk probe e", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        nuovo = Service.objects.create(salon=self.salon, category=self.svc60.category, name_it="Nuovo", duration_min=30, price=Decimal("20"))
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            item = appt.items.first()
            body = {"items": [
                {"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id},
                {"service_id": nuovo.id, "operator_id": None},
            ]}
            first = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps(body), content_type="application/json", **auth)
            forced = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps({**body, "force": True}), content_type="application/json", **auth)
        print("\n[probe-edit] senza force:", first.status_code, first.content, "| con force:", forced.status_code, forced.content)
        self.assertEqual(first.status_code, 400)
