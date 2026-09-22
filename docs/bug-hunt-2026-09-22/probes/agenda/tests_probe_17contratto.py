"""PROBE temporaneo del revisore 17 (contratto frontend/backend). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal

from common.auth import create_client_tokens, create_staff_tokens

from .models import Appointment, AppointmentService
from .tests import AgendaTestBase, _aware


class Probe17MoveFromInactive(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="p17@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"}
        self.op2.services.add(self.svc60, self.svc30)
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}

    def _visit(self, op):
        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=op, start=_aware(self.day, 10)
        )
        AppointmentService.objects.create(
            appointment=appt, service=self.svc60, operator=op, duration_min=60,
            price=Decimal("50.00"), order=0,
        )
        return appt

    def _post(self, url, body):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **self.auth)

    def test_day_view_marks_orphan_column(self):
        visit = self._visit(self.op2)
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        with self._windows(self.wide):
            res = self.client.get(f"/api/agenda/day?date={self.day.isoformat()}", **self.auth)
        self.assertEqual(res.status_code, 200)
        rows = {r["operator"]["id"]: r for r in res.json()}
        self.assertTrue(rows[self.op2.id]["operator"]["inactive"])
        self.assertEqual(rows[self.op2.id]["appointments"][0]["id"], visit.id)

    def test_drag_from_inactive_column_exact_frontend_payload(self):
        # DayGrid → index.jsx moveAppt: fromOp = colonna di partenza (op2, disattivata)
        visit = self._visit(self.op2)
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        body = {
            "start": _aware(self.day, 11).astimezone(dt.timezone.utc).isoformat().replace("+00:00", ".000Z"),
            "operator_id": self.op1.id,
            "from_operator_id": self.op2.id,
            "force": False,
        }
        with self._windows(self.wide):
            res = self._post(f"/api/agenda/appointments/{visit.id}/move", body)
        print("\n[probe17] move da colonna disattivata:", res.status_code, res.content[:200])
        # senza from_operator_id (comportamento prima della modifica) lo spostamento riesce
        body.pop("from_operator_id")
        with self._windows(self.wide):
            res2 = self._post(f"/api/agenda/appointments/{visit.id}/move", body)
        print("[probe17] stesso gesto senza from_operator_id:", res2.status_code)
        self.assertEqual(res2.status_code, 200)
        self.assertEqual(res.status_code, 404)  # il difetto: 404 «Not Found»

    def test_resize_in_inactive_column(self):
        # index.jsx resizeItem manda operator_id di ogni riga: la riga è di op2 disattivata
        visit = self._visit(self.op2)
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        item = visit.items.first()
        body = {"items": [{"id": item.id, "service_id": self.svc60.id, "operator_id": self.op2.id, "duration_min": 75}], "force": False}
        with self._windows(self.wide):
            res = self.client.put(f"/api/agenda/appointments/{visit.id}", data=json.dumps(body), content_type="application/json", **self.auth)
            res_f = self.client.put(f"/api/agenda/appointments/{visit.id}", data=json.dumps({**body, "force": True}), content_type="application/json", **self.auth)
        print("\n[probe17] resize in colonna disattivata:", res.status_code, res.content[:200], "| con force:", res_f.status_code)


class Probe17ClientMoveInactive(AgendaTestBase):
    """App cliente: disponibilità propone altre operatrici, lo spostamento tiene quella disattivata."""

    def test_client_move_after_operator_left(self):
        from apps.core.models import SalonSettings

        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"agenda_fill": "free"})
        self.op2.services.add(self.svc60, self.svc30)
        day = self.day
        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op2, start=_aware(day, 10)
        )
        AppointmentService.objects.create(
            appointment=appt, service=self.svc60, operator=self.op2, duration_min=60,
            price=Decimal("50.00"), order=0,
        )
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        # op2 disattivata: nessun turno (caso 1) oppure turni ancora a database (caso 2)
        for label, mapping in (
            ("senza turni", {self.op1.id: [(8 * 60, 20 * 60)]}),
            ("turni rimasti", {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}),
        ):
            items = json.dumps([{"service_id": self.svc60.id, "operator_id": self.op2.id}])
            with self._windows(mapping):
                slots = self.client.get(
                    f"/api/agenda/client/availability?date={day.isoformat()}&items={items}&exclude_appointment_id={appt.id}",
                    **auth,
                ).json()
            target = next(s for s in slots if s["start"] != appt.start.isoformat())
            with self._windows(mapping):
                res = self.client.post(
                    f"/api/agenda/client/appointments/{appt.id}/move",
                    data=json.dumps({"start": target["start"]}), content_type="application/json", **auth,
                )
            appt.refresh_from_db()
            print(f"\n[probe17] cliente sposta ({label}): slot proposto con {target['assignment']} → {res.status_code}",
                  "operatrice dopo:", appt.operator_id, "(op2 disattivata =", self.op2.id, ")")


class Probe17PanelUndo(AgendaTestBase):
    """«Annulla» del pannello (spostamento forzato al contrario) contro il torna indietro del server."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import WaitlistEntry

        self.user = User.objects.create_user(email="p17u@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"}
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)]}
        WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)

    def _visit(self):
        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=_aware(self.day, 10)
        )
        AppointmentService.objects.create(
            appointment=appt, service=self.svc60, operator=self.op1, duration_min=60,
            price=Decimal("50.00"), order=0,
        )
        return appt

    def _post(self, url, body):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **self.auth)

    def _pending(self):
        from apps.core.models import OutboxEvent

        return sorted(
            (e.event_type, e.payload.get("start") or e.payload.get("start_iso") or "")
            for e in OutboxEvent.objects.filter(salon=self.salon, status=OutboxEvent.Status.PENDING)
        )

    def test_panel_reverse_move_vs_server_undo(self):
        iso = lambda h: _aware(self.day, h).astimezone(dt.timezone.utc).isoformat().replace("+00:00", ".000Z")
        a = self._visit()
        with self._windows(self.wide):
            r1 = self._post(f"/api/agenda/appointments/{a.id}/move", {"start": iso(11), "force": False})
            # ApptDetailModal.applyMove → undoFn: stesso percorso al contrario, force: true
            r2 = self._post(f"/api/agenda/appointments/{a.id}/move", {"start": iso(10), "force": True})
        a.refresh_from_db()
        print("\n[probe17] pannello: move", r1.status_code, "annulla", r2.status_code,
              "| forced:", a.forced, "| eventi in coda:", self._pending())
        from apps.core.models import OutboxEvent
        OutboxEvent.objects.all().delete()
        b = self._visit()
        with self._windows(self.wide):
            r3 = self._post(f"/api/agenda/appointments/{b.id}/move", {"start": iso(11), "force": False})
            r4 = self._post("/api/agenda/undo", {})
        b.refresh_from_db()
        print("[probe17] griglia: move", r3.status_code, "undo", r4.status_code,
              "| forced:", b.forced, "| eventi in coda:", self._pending())
