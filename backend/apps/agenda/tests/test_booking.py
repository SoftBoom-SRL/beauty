"""Prenotazione dallo staff e dall'app cliente: conflitti, forzature, richieste malformate."""

import datetime as dt
import json
from decimal import Decimal

from django.test import Client as HttpClient
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import OutboxEvent
from common.testing import aware, bearer, client_bearer, post_json

from ..models import Appointment, Pause
from ..services.appointments import create_appointment, move_appointment
from .base import AgendaTestBase, RealShiftsTestBase, _aware

STAFF_ONLY_FIELDS = ("note", "forced", "created_via", "cancel_reason", "client", "location_id")


class CreateAppointmentTests(AgendaTestBase):
    def test_collision_raises_409(self):
        mapping = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}
        items = [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        with self._windows(mapping):
            first = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 10), via="dashboard"
            )
            self.assertEqual(first.status, Appointment.Status.CONFIRMED)
            self.assertEqual(first.operator_id, self.op1.id)
            self.assertEqual(first.total_price, Decimal("50.00"))

            # stesso slot (sovrapposto): 409
            with self.assertRaises(HttpError) as caught:
                create_appointment(
                    self.salon,
                    self.client_obj,
                    items,
                    _aware(self.day, 10, 30),
                    via="dashboard",
                )
            self.assertEqual(caught.exception.status_code, 409)

            # anche in auto-assegnazione: op1 occupata, op2 non idonea -> 409
            with self.assertRaises(HttpError) as caught:
                create_appointment(
                    self.salon,
                    self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": None}],
                    _aware(self.day, 10, 30),
                    via="dashboard",
                )
            self.assertEqual(caught.exception.status_code, 409)

            # slot adiacente libero: ok
            second = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 11), via="dashboard"
            )
            self.assertEqual(second.status, Appointment.Status.CONFIRMED)

        self.assertEqual(
            OutboxEvent.objects.filter(event_type="appointment.created").count(), 2
        )

    def test_snapshot_and_deposit_none_without_rules(self):
        mapping = {self.op1.id: [(8 * 60, 20 * 60)]}
        items = [
            {"service_id": self.svc60.id, "operator_id": None},
            {"service_id": self.svc30.id, "operator_id": None},
        ]
        with self._windows(mapping):
            appointment = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 9), via="app"
            )
        self.assertEqual(appointment.total_duration_min, 90)
        self.assertEqual(appointment.total_price, Decimal("80.00"))
        self.assertEqual(appointment.end, _aware(self.day, 10, 30))
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.NONE)
        self.assertEqual(appointment.created_via, "app")


class ClientOverlapTests(AgendaTestBase):
    """Due trattamenti sulla STESSA cliente nella stessa fascia.

    In salone è una seduta sola (la nail art mentre asciuga la manicure), non un
    conflitto: dallo scrittoio deve passare senza forzature e senza marchiare
    l'appuntamento come «forzato». Per una cliente diversa resta un conflitto.
    """

    def test_same_client_can_overlap_from_the_desk(self):
        mapping = {self.op1.id: [(8 * 60, 20 * 60)]}
        items = [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        with self._windows(mapping):
            first = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 10), via="dashboard"
            )
            second = create_appointment(
                self.salon,
                self.client_obj,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 10, 30),
                via="dashboard",
                client_overlap_ok=True,
            )
        self.assertNotEqual(first.id, second.id)
        self.assertFalse(second.forced)   # non è una forzatura: è la stessa seduta

    def test_another_client_still_collides(self):
        from apps.clients.models import Client

        other = Client.objects.create(
            salon=self.salon, first_name="Elena", last_name="Neri", phone="+390000000002"
        )
        mapping = {self.op1.id: [(8 * 60, 20 * 60)]}
        items = [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        with self._windows(mapping):
            create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 10), via="dashboard"
            )
            with self.assertRaises(HttpError) as caught:
                create_appointment(
                    self.salon,
                    other,
                    items,
                    _aware(self.day, 10, 30),
                    via="dashboard",
                    client_overlap_ok=True,
                )
        self.assertEqual(caught.exception.status_code, 409)

    def test_move_over_own_other_visit(self):
        """Spostare una visita sopra un'altra della stessa cliente: passa e non è «forzata»."""
        mapping = {self.op1.id: [(8 * 60, 20 * 60)]}
        with self._windows(mapping):
            morning = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            evening = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 15), via="dashboard",
            )
            moved = move_appointment(
                evening, _aware(self.day, 10, 15), client_overlap_ok=True
            )
        self.assertEqual(moved.start, _aware(self.day, 10, 15))
        self.assertFalse(moved.forced)
        self.assertEqual(morning.start, _aware(self.day, 10))


class ClientBookingApiTests(AgendaTestBase):
    """API app cliente: niente prenotazioni nel passato né su servizi disattivati;
    lo spostamento cerca la disponibilità con le operatrici originarie ed esclude
    l'appuntamento che si sta spostando."""

    def setUp(self):
        self.auth = client_bearer(self.client_obj)
        windows = self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]})
        windows.start()
        self.addCleanup(windows.stop)

    def _post(self, url, body):
        return post_json(self.client, url, body, **self.auth)

    def _availability(self, items, **extra):
        params = {"date": self.day.isoformat(), "items": json.dumps(items), **extra}
        res = self.client.get("/api/agenda/client/availability", params, **self.auth)
        return res

    def test_past_booking_rejected(self):
        yesterday = timezone.localdate() - dt.timedelta(days=1)
        res = self._post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.svc60.id}], "start": _aware(yesterday, 10).isoformat()},
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Appointment.objects.count(), 0)

    def test_inactive_service_rejected_everywhere(self):
        self.svc60.active = False
        self.svc60.save(update_fields=["active"])
        res = self._post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.svc60.id}], "start": _aware(self.day, 10).isoformat()},
        )
        self.assertEqual(res.status_code, 404, res.content)
        self.assertEqual(self._availability([{"service_id": self.svc60.id}]).status_code, 404)
        self.assertEqual(Appointment.objects.count(), 0)

    def test_client_booking_lands_on_the_default_location(self):
        from apps.core.models import Location

        Location.objects.create(salon=self.salon, name="Secondaria")
        default = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        res = self._post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.svc60.id}], "start": _aware(self.day, 10).isoformat()},
        )
        self.assertEqual(res.status_code, 200, res.content)
        # La risposta è la scheda della cliente (senza la sede): si guarda la visita.
        self.assertEqual(Appointment.objects.get(pk=res.json()["id"]).location_id, default.id)

    def test_move_availability_uses_original_operator_and_excludes_itself(self):
        # op2 diventa idonea: senza vincolo di operatrice la disponibilità la
        # proporrebbe, ma lo spostamento conserva op1 → 409. Con operator_id
        # negli items i due calcoli coincidono.
        self.op2.services.add(self.svc60)
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000002")
        create_appointment(
            self.salon, other, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 12), via="dashboard",
        )
        mine = create_appointment(
            self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="app",
        )

        upcoming = self.client.get("/api/agenda/client/appointments", **self.auth).json()["upcoming"]
        self.assertEqual(upcoming[0]["services"][0]["operator_id"], self.op1.id)

        loose = [s["start"] for s in self._availability([{"service_id": self.svc60.id}]).json()]
        self.assertIn(_aware(self.day, 12).isoformat(), loose)  # su op2: lo spostamento lo rifiuterebbe

        items = [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        strict = [s["start"] for s in self._availability(items).json()]
        self.assertNotIn(_aware(self.day, 12).isoformat(), strict)
        self.assertNotIn(_aware(self.day, 10).isoformat(), strict)  # occupato da sé stesso…

        excluded = [s["start"] for s in self._availability(items, exclude_appointment_id=mine.id).json()]
        self.assertIn(_aware(self.day, 10).isoformat(), excluded)  # …salvo escludersi
        self.assertIn(_aware(self.day, 14).isoformat(), excluded)

        res = self._post(f"/api/agenda/client/appointments/{mine.id}/move", {"start": _aware(self.day, 14).isoformat()})
        self.assertEqual(res.status_code, 200, res.content)
        res = self._post(f"/api/agenda/client/appointments/{mine.id}/move", {"start": _aware(self.day, 12).isoformat()})
        self.assertEqual(res.status_code, 409, res.content)

    def test_move_availability_inherits_operators_when_items_omit_them(self):
        # Anche un client che non passa operator_id ottiene, con exclude_appointment_id,
        # la disponibilità calcolata sulle operatrici dell'appuntamento da spostare.
        self.op2.services.add(self.svc60)
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000004")
        create_appointment(
            self.salon, other, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 12), via="dashboard",
        )
        mine = create_appointment(
            self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="app",
        )
        res = self._availability([{"service_id": self.svc60.id}], exclude_appointment_id=mine.id)
        self.assertEqual(res.status_code, 200, res.content)
        slots = res.json()
        starts = [s["start"] for s in slots]
        self.assertNotIn(_aware(self.day, 12).isoformat(), starts)  # op1 è occupata: niente slot su op2
        self.assertIn(_aware(self.day, 10).isoformat(), starts)
        self.assertTrue(all(a["operator_id"] == self.op1.id for s in slots for a in s["assignment"]))

    def test_cannot_exclude_someone_elses_appointment(self):
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000003")
        theirs = create_appointment(
            self.salon, other, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard",
        )
        res = self._availability([{"service_id": self.svc60.id}], exclude_appointment_id=theirs.id)
        self.assertEqual(res.status_code, 404)


class ForcedBookingTests(AgendaTestBase):
    """Lo staff può andare oltre le regole: fuori turno, centro chiuso, sovrapposizione."""

    def _staff(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="force@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return bearer(user, self.salon)

    def test_force_creates_outside_shift_and_over_other_bookings(self):
        auth = self._staff()
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            body = {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                "start": _aware(self.day, 20).isoformat(),  # fuori turno
            }
            res = self.client.post("/api/agenda/appointments", data=json.dumps(body), content_type="application/json", **auth)
            self.assertEqual(res.status_code, 409)
            res = self.client.post("/api/agenda/appointments", data=json.dumps({**body, "force": True}), content_type="application/json", **auth)
            self.assertEqual(res.status_code, 200, res.content)
            self.assertTrue(res.json()["forced"])
            # sovrapposizione sulla stessa operatrice, sempre forzata
            body["start"] = _aware(self.day, 20, 30).isoformat()
            res = self.client.post("/api/agenda/appointments", data=json.dumps({**body, "force": True}), content_type="application/json", **auth)
            self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Appointment.objects.filter(forced=True).count(), 2)

    def test_force_never_bypasses_operator_eligibility(self):
        auth = self._staff()
        body = {
            "client_id": self.client_obj.id,
            "items": [{"service_id": self.svc60.id, "operator_id": self.op2.id}],  # op2 non abilitata
            "start": _aware(self.day, 10).isoformat(),
            "force": True,
        }
        with self._windows({self.op2.id: [(9 * 60, 18 * 60)]}):
            res = self.client.post("/api/agenda/appointments", data=json.dumps(body), content_type="application/json", **auth)
        self.assertEqual(res.status_code, 400)

    def test_client_api_cannot_force(self):
        from common.auth import create_client_tokens

        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            res = self.client.post(
                "/api/agenda/client/appointments",
                data=json.dumps({"items": [{"service_id": self.svc60.id}], "start": _aware(self.day, 20).isoformat(), "force": True}),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 409)

    def test_forced_move_skips_validation(self):
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            with self.assertRaises(HttpError):
                move_appointment(appointment, _aware(self.day, 19))
            move_appointment(appointment, _aware(self.day, 19), force=True)
        appointment.refresh_from_db()
        self.assertEqual(timezone.localtime(appointment.start).hour, 19)
        self.assertTrue(appointment.forced)


class RequestValidationTests(AgendaTestBase):
    """Richieste malformate: risposta di validazione, non 500."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="val@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Manager di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        self.auth = bearer(user, self.salon)

    def _post(self, path, body):
        return post_json(self.client, path, body, **self.auth)

    def test_a_start_without_timezone_is_refused(self):
        res = self._post(
            "/api/agenda/appointments",
            {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc60.id}],
                "start": f"{self.day.isoformat()}T10:00:00",  # senza offset
            },
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Appointment.objects.exists())

    def test_a_reason_longer_than_the_column_is_refused(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
        res = self._post(
            f"/api/agenda/appointments/{appointment.id}/cancel", {"reason": "x" * 300}
        )
        self.assertEqual(res.status_code, 422, res.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)

    def test_too_many_services_in_one_request_are_refused(self):
        res = self._post(
            "/api/agenda/appointments",
            {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc60.id}] * 50,
                "start": _aware(self.day, 10).isoformat(),
            },
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Appointment.objects.exists())

    def test_a_pause_can_be_created_moved_and_removed(self):
        created = self._post(
            "/api/agenda/pauses",
            {
                "operator_id": self.op1.id,
                "start": _aware(self.day, 12).isoformat(),
                "duration_min": 30,
                "note": "pranzo",
            },
        )
        self.assertEqual(created.status_code, 200, created.content)
        pause_id = created.json()["id"]
        moved = self.client.put(
            f"/api/agenda/pauses/{pause_id}",
            data=json.dumps({
                "operator_id": self.op1.id,
                "start": _aware(self.day, 13).isoformat(),
                "duration_min": 45,
                "note": "pranzo lungo",
            }),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        self.assertEqual(moved.json()["duration_min"], 45)
        self.assertEqual(moved.json()["note"], "pranzo lungo")
        pause = Pause.objects.get(pk=pause_id)
        self.assertEqual(timezone.localtime(pause.start).hour, 13)
        gone = self.client.delete(f"/api/agenda/pauses/{pause_id}", **self.auth)
        self.assertEqual(gone.status_code, 200, gone.content)
        self.assertFalse(Pause.objects.exists())

    def test_a_pause_note_longer_than_the_column_is_refused(self):
        res = self._post(
            "/api/agenda/pauses",
            {
                "operator_id": self.op1.id,
                "start": _aware(self.day, 12).isoformat(),
                "duration_min": 30,
                "note": "n" * 300,
            },
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Pause.objects.exists())


# ---- 04-06 + 10-10 + 16-06: l'app risponde con la scheda della cliente ----------


class ClientResponsesTests(RealShiftsTestBase):
    def test_create_move_and_cancel_do_not_leak_staff_fields(self):
        auth = self.client_auth()
        created = self.post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.cut30.id}], "start": aware(self.day, 10).isoformat()}, auth,
        )
        self.assertEqual(created.status_code, 200, created.content)
        body = created.json()
        # quello che l'app legge (Prenota: conferma e caparra)
        for key in ("id", "start", "end", "status", "deposit_status", "deposit_amount",
                    "deposit_due_at", "deposit_payment_link", "services", "operator"):
            self.assertIn(key, body)
        appointment = Appointment.objects.get(pk=body["id"])
        # lo staff scrive una nota riservata sulla cliente
        appointment.note = "Cliente morosa: chiedere prima il saldo"
        appointment.save(update_fields=["note"])

        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(self.day, 12).isoformat()}, auth,
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        cancelled = self.post(f"/api/agenda/client/appointments/{appointment.id}/cancel", {}, auth)
        self.assertEqual(cancelled.status_code, 200, cancelled.content)
        for res in (created, moved, cancelled):
            for key in STAFF_ONLY_FIELDS:
                self.assertNotIn(key, res.json(), (res.request["PATH_INFO"], key))
        self.assertNotIn("morosa", moved.content.decode() + cancelled.content.decode())
        self.assertEqual(cancelled.json()["status"], Appointment.Status.CANCELLED)


# ---- 01-14 + 04-11: date che non stanno in piedi -------------------------------


class InvalidDatesTests(RealShiftsTestBase):
    def test_every_date_parameter_answers_400(self):
        http = HttpClient(raise_request_exception=False)
        staff = self.staff_auth()
        items = json.dumps([{"service_id": self.cut30.id}])
        cases = [
            ("/api/agenda/day", {"date": "2026-02-30"}, staff),
            ("/api/agenda/week", {"start": "2026-13-01"}, staff),
            ("/api/agenda/week", {"start": "9999-12-30"}, staff),
            ("/api/agenda/range", {"start": "2026-09-01", "end": "2026-09-31"}, staff),
            ("/api/agenda/range", {"start": "0001-01-01", "end": "0001-01-02"}, staff),
            ("/api/agenda/pauses", {"date": "2026-04-31"}, staff),
            ("/api/agenda/availability", {"date": "2026-02-29", "items": items}, staff),
            ("/api/agenda/availability", {"date": "9999-12-31", "items": items}, staff),
            ("/api/agenda/client/availability", {"date": "2026-02-29", "items": items}, self.client_auth()),
            ("/api/agenda/public/availability",
             {"salon": self.salon.slug, "date": "2027-02-29", "items": items}, {}),
        ]
        codes = {(url, tuple(params.values())): http.get(url, params, **auth).status_code for url, params, auth in cases}
        self.assertTrue(all(code == 400 for code in codes.values()), codes)

    def test_a_start_in_year_9999_is_rejected_not_a_crash(self):
        http = HttpClient(raise_request_exception=False)
        res = http.post(
            "/api/agenda/appointments",
            data=json.dumps({"client_id": self.anna.id, "items": [{"service_id": self.cut30.id}],
                             "start": "9999-12-31T23:30:00+01:00", "force": True}),
            content_type="application/json", **self.staff_auth(),
        )
        self.assertEqual(res.status_code, 422, res.content)
