"""Probe temporaneo del revisore 12 (agenda React: griglie). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal

from django.utils import timezone

from common.auth import create_staff_tokens

from .models import Appointment, AppointmentService
from .services import create_appointment
from .tests import AgendaTestBase, _aware


class ProbeGridTests(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="probe12@theparlour.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Banco", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"}
        self.op2.services.add(self.svc60, self.svc30)
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}

    def _post(self, url, body):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **self.auth)

    def test_split_of_first_service_moves_the_remaining_one(self):
        """La griglia mostra gli altri servizi fermi durante lo stacco: il server li fa slittare."""
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Lia", last_name="Neri", phone="+390000000009")
        with self._windows(self.wide):
            # altra cliente su op2 alle 10:00-10:30
            busy = create_appointment(
                self.salon, other, [{"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 10), via="dashboard",
            )
            # visita: manicure op1 10:00-11:00 + copertura op2 11:00-11:30
            visit = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
            first = visit.items.order_by("order").first()
            start = _aware(self.day, 14).isoformat()
            # come fa la dashboard: prima senza forzare...
            res = self._post(f"/api/agenda/appointments/{visit.id}/split", {"item_id": first.id, "start": start})
            print("\nsplit senza force:", res.status_code, res.content[:200])
            # ...e al 409 riprova con force
            res2 = self._post(f"/api/agenda/appointments/{visit.id}/split", {"item_id": first.id, "start": start, "force": True})
            print("split con force:", res2.status_code)
        visit.refresh_from_db()
        rest = visit.items.get()
        print("servizio rimasto:", rest.service.name_it, "op", rest.operator_id,
              "inizio visita", timezone.localtime(visit.start).strftime("%H:%M"))
        # il servizio rimasto (era alle 11:00 su op2) ora comincia alle 10:00
        self.assertEqual(timezone.localtime(visit.start).strftime("%H:%M"), "10:00")
        self.assertEqual(rest.operator_id, self.op2.id)
        self.assertEqual(res.status_code, 409)
        self.assertEqual(res2.status_code, 200)
        # sovrapposto all'altra cliente di op2 e visita originale NON marcata forzata
        self.assertFalse(visit.forced)
        self.assertTrue(Appointment.objects.filter(id=busy.id).exists())

    def test_reassign_from_inactive_operator_column(self):
        with self._windows(self.wide):
            visit = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op2.id}],
                _aware(self.day, 10), via="dashboard",
            )
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        with self._windows(self.wide):
            day = self.client.get(f"/api/agenda/day?date={self.day.isoformat()}", **self.auth)
            ops = [r["operator"]["id"] for r in day.json()]
            print("\ncolonne giorno:", ops, "inactive op2 presente:", self.op2.id in ops)
            # corpo che manda la dashboard (DayGrid → moveAppt con fromOp = colonna di partenza)
            res = self._post(f"/api/agenda/appointments/{visit.id}/move", {
                "start": _aware(self.day, 10).isoformat(),
                "operator_id": self.op1.id, "from_operator_id": self.op2.id, "force": False,
            })
            print("move da colonna disattivata:", res.status_code, res.content[:120])
            res_plain = self._post(f"/api/agenda/appointments/{visit.id}/move", {
                "start": _aware(self.day, 10).isoformat(), "operator_id": self.op1.id,
            })
            print("move senza from_operator_id:", res_plain.status_code)
        self.assertIn(self.op2.id, ops)
        self.assertEqual(res.status_code, 404)
        self.assertEqual(res_plain.status_code, 200)

    def test_item_of_inactive_operator_has_no_column(self):
        with self._windows(self.wide):
            visit = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        with self._windows(self.wide):
            day = self.client.get(f"/api/agenda/day?date={self.day.isoformat()}", **self.auth)
        ops = [r["operator"]["id"] for r in day.json()]
        items = [it["operator_id"] for r in day.json() for a in r["appointments"] for it in a["items"]]
        print("\ncolonne:", ops, "operatrici dei servizi:", items)
        self.assertIn(self.op2.id, items)
        self.assertNotIn(self.op2.id, ops)


class ProbeResizeTests(ProbeGridTests):
    def test_resize_fails_when_other_item_operator_no_longer_eligible(self):
        with self._windows(self.wide):
            visit = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
        # la collega non fa più la copertura (Staff → servizi)
        self.op2.services.remove(self.svc30)
        items = [
            {"id": it.id, "service_id": it.service_id, "operator_id": it.operator_id,
             "duration_min": 75 if it.service_id == self.svc60.id else it.duration_min}
            for it in visit.items.all()
        ]
        with self._windows(self.wide):
            res = self.client.put(
                f"/api/agenda/appointments/{visit.id}",
                data=json.dumps({"items": items, "force": False}),
                content_type="application/json", **self.auth,
            )
            res2 = self.client.put(
                f"/api/agenda/appointments/{visit.id}",
                data=json.dumps({"items": items, "force": True}),
                content_type="application/json", **self.auth,
            )
        print("\nresize manicure (op1) con copertura di op2 non più abilitata:", res.status_code, res.content[:100], res2.status_code)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res2.status_code, 400)

    def test_resize_fails_when_other_item_operator_inactive(self):
        with self._windows(self.wide):
            visit = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        items = [
            {"id": it.id, "service_id": it.service_id, "operator_id": it.operator_id,
             "duration_min": 75 if it.service_id == self.svc60.id else it.duration_min}
            for it in visit.items.all()
        ]
        with self._windows(self.wide):
            res = self.client.put(
                f"/api/agenda/appointments/{visit.id}",
                data=json.dumps({"items": items}),
                content_type="application/json", **self.auth,
            )
        print("\nresize con collega disattivata:", res.status_code, res.content[:100])
        self.assertEqual(res.status_code, 400)
