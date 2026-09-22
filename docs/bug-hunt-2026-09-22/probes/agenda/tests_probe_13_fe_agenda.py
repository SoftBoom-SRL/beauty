"""Probe temporaneo del revisore 13 (agenda React). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal

from django.utils import timezone

from common.auth import create_staff_tokens

from .models import Appointment, AppointmentService
from .tests import AgendaTestBase, _aware


class Probe13Tests(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="probe13@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front", scopes=["agenda", "sales"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"}
        # op2 diventa idonea ai servizi: serve come collega che subentra
        self.op2.services.add(self.svc60, self.svc30)
        w = self._windows({self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]})
        w.start()
        self.addCleanup(w.stop)

    def _appt(self, operator, start, **kw):
        a = Appointment.objects.create(salon=self.salon, client=self.client_obj, operator=operator, start=start, **kw)
        AppointmentService.objects.create(
            appointment=a, service=self.svc60, operator=operator, duration_min=60, price=Decimal("50.00")
        )
        return a

    def _post(self, url, body):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **self.auth)

    def test_reassign_from_inactive_operator_with_from_operator_id(self):
        """Quello che mandano pannello («Passa a») e trascinamento: from_operator_id sempre."""
        a = self._appt(self.op1, _aware(self.day, 10))
        self.op1.active = False
        self.op1.save(update_fields=["active"])
        start = _aware(self.day, 10).isoformat()
        with_from = self._post(
            f"/api/agenda/appointments/{a.id}/move",
            {"start": start, "operator_id": self.op2.id, "from_operator_id": self.op1.id, "force": False},
        )
        print("\n[probe] move con from_operator_id inattiva ->", with_from.status_code, with_from.content[:200])
        without_from = self._post(
            f"/api/agenda/appointments/{a.id}/move",
            {"start": start, "operator_id": self.op2.id, "force": False},
        )
        print("[probe] move senza from_operator_id ->", without_from.status_code)
        self.assertEqual(with_from.status_code, 404)
        self.assertEqual(without_from.status_code, 200)

    def test_dashboard_late_cancel_refunds_paid_deposit(self):
        """L'anteprima del pannello dice «Caparra trattenuta» sotto le 24 h: il server rimborsa."""
        soon = timezone.now() + dt.timedelta(hours=2)
        a = self._appt(self.op1, soon, deposit_amount=Decimal("20.00"), deposit_status=Appointment.DepositStatus.PAID)
        res = self._post(f"/api/agenda/appointments/{a.id}/cancel", {"reason": "Richiesta cliente"})
        print("\n[probe] cancel tardivo dal gestionale ->", res.status_code, res.json().get("deposit_status"), res.json().get("cancelled_late"))
        self.assertEqual(res.status_code, 200)
        self.assertNotEqual(res.json()["deposit_status"], "forfeited")

    def test_put_items_fails_when_existing_operator_lost_skill(self):
        """Il pannello manda operator_id anche per le righe esistenti: se l'operatrice
        non è più abilitata, qualunque modifica ai servizi risponde 400."""
        a = self._appt(self.op1, _aware(self.day, 10))
        item = a.items.first()
        self.op1.services.remove(self.svc60)
        body = {"items": [{"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id, "duration_min": 70, "soak_min": 0}]}
        res = self.client.put(f"/api/agenda/appointments/{a.id}", data=json.dumps(body), content_type="application/json", **self.auth)
        print("\n[probe] PUT con operatrice non più abilitata ->", res.status_code, res.content[:120])
        body_no_op = {"items": [{"id": item.id, "service_id": self.svc60.id, "duration_min": 70, "soak_min": 0}]}
        res2 = self.client.put(f"/api/agenda/appointments/{a.id}", data=json.dumps(body_no_op), content_type="application/json", **self.auth)
        print("[probe] PUT senza operator_id ->", res2.status_code, res2.json().get("items", [{}])[0].get("operator_id") if res2.status_code == 200 else res2.content[:120])
        self.assertEqual(res.status_code, 400)

    def test_put_note_only_on_stale_items_does_not_touch_items(self):
        """Solo nota: gli item non viaggiano (controllo di base)."""
        a = self._appt(self.op1, _aware(self.day, 10))
        res = self.client.put(f"/api/agenda/appointments/{a.id}", data=json.dumps({"note": "ciao"}), content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200)

    def test_same_time_other_day_move_payload(self):
        """Controllo: spostare alla stessa ora di un altro giorno funziona se la richiesta parte."""
        a = self._appt(self.op1, _aware(self.day, 10))
        other = _aware(self.day + dt.timedelta(days=1), 10).isoformat()
        res = self._post(f"/api/agenda/appointments/{a.id}/move", {"start": other, "force": False})
        self.assertEqual(res.status_code, 200)


class Probe13MoreTests(Probe13Tests):
    def _appt2(self, start):
        """Visita mista: svc60 con op1 (principale) e poi svc30 con op2."""
        a = Appointment.objects.create(salon=self.salon, client=self.client_obj, operator=self.op1, start=start)
        AppointmentService.objects.create(appointment=a, service=self.svc60, operator=self.op1, duration_min=60, price=Decimal("50.00"), order=0)
        AppointmentService.objects.create(appointment=a, service=self.svc30, operator=self.op2, duration_min=30, price=Decimal("30.00"), order=1)
        return a

    def test_panel_undo_of_hand_over_is_not_the_original(self):
        """«Passa a» dal pannello e poi «Annulla» del suo avviso (spostamento inverso forzato)."""
        a = self._appt2(_aware(self.day, 10))
        start = _aware(self.day, 10).isoformat()
        r1 = self._post(f"/api/agenda/appointments/{a.id}/move",
                        {"start": start, "operator_id": self.op2.id, "from_operator_id": self.op1.id, "force": False})
        self.assertEqual(r1.status_code, 200, r1.content)
        # undoFn del pannello: applyMove({operatorId: op1}, {force: true, base: res})
        r2 = self._post(f"/api/agenda/appointments/{a.id}/move",
                        {"start": start, "operator_id": self.op1.id, "from_operator_id": r1.json()["operator_id"], "force": True})
        print("\n[probe] undo del pannello ->", r2.status_code, [(i["service_name"], i["operator_id"]) for i in r2.json()["items"]], "forced:", r2.json()["forced"])
        print("[probe] originale: svc60->op1(", self.op1.id, ") svc30->op2(", self.op2.id, ")")
        ops = [i["operator_id"] for i in r2.json()["items"]]
        self.assertEqual(ops, [self.op1.id, self.op1.id])   # tutto a op1: non è lo stato di partenza
        self.assertTrue(r2.json()["forced"])

    def test_sposta_qui_with_stale_from_operator(self):
        """Dopo «Passa a» (op1->op2) l'agenda usa ancora la copia vecchia (op1) per «Sposta qui»."""
        from apps.staff.models import Operator
        op3 = Operator.objects.create(salon=self.salon, first_name="Carla", last_name="Neri", color="#CCCCCC")
        op3.services.add(self.svc60, self.svc30)
        a = self._appt(self.op1, _aware(self.day, 10))
        start = _aware(self.day, 10).isoformat()
        r1 = self._post(f"/api/agenda/appointments/{a.id}/move",
                        {"start": start, "operator_id": self.op2.id, "from_operator_id": self.op1.id, "force": False})
        self.assertEqual(r1.status_code, 200)
        # «Sposta qui» nella colonna di Carla alle 15: moveAppt(a vecchio) -> from_operator_id = op1
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)], op3.id: [(8 * 60, 20 * 60)]}):
            r2 = self._post(f"/api/agenda/appointments/{a.id}/move",
                            {"start": _aware(self.day, 15).isoformat(), "operator_id": op3.id, "from_operator_id": self.op1.id, "force": False})
        print("\n[probe] Sposta qui (colonna Carla, from vecchio) ->", r2.status_code, "operator:", r2.json().get("operator_id"), "atteso", op3.id,
              [(i["operator_id"]) for i in r2.json().get("items", [])])
        self.assertEqual(r2.status_code, 200)
        self.assertNotEqual(r2.json()["operator_id"], op3.id)

    def test_forced_create_first_available_takes_busy_operator(self):
        """Nuova prenotazione forzata con «Prima disponibile»: il server prende la prima in ordine anche se occupata."""
        busy = self._appt(self.op1, _aware(self.day, 10))
        body = {"client_id": self.client_obj.id, "items": [{"service_id": self.svc30.id, "operator_id": None}],
                "start": _aware(self.day, 10).isoformat(), "force": True}
        res = self._post("/api/agenda/appointments", body)
        print("\n[probe] create forzata, Prima disponibile, op1 occupata e op2 libera ->", res.status_code, "operator:", res.json().get("operator_id"),
              "(op1=", self.op1.id, "op2=", self.op2.id, ")")
        self.assertEqual(res.json()["operator_id"], self.op1.id)


class Probe13StaleTests(Probe13MoreTests):
    def test_stale_panel_put_readds_split_service(self):
        """Pannello aperto con 2 servizi; in griglia si stacca il secondo; poi dal pannello si
        cambia la durata del primo e si salva con la lista vecchia."""
        a = self._appt2(_aware(self.day, 10))
        items = list(a.items.order_by("order"))
        split = self._post(f"/api/agenda/appointments/{a.id}/split",
                           {"item_id": items[1].id, "start": _aware(self.day, 16).isoformat(), "operator_id": None, "force": False})
        self.assertEqual(split.status_code, 200, split.content)
        stale_items = [
            {"id": items[0].id, "service_id": self.svc60.id, "operator_id": self.op1.id, "duration_min": 70, "soak_min": 0},
            {"id": items[1].id, "service_id": self.svc30.id, "operator_id": self.op2.id, "duration_min": 30, "soak_min": 0},
        ]
        res = self.client.put(f"/api/agenda/appointments/{a.id}", data=json.dumps({"items": stale_items}), content_type="application/json", **self.auth)
        print("\n[probe] PUT con lista vecchia dopo lo stacco ->", res.status_code, [(i["service_name"], str(i["price"])) for i in res.json().get("items", [])],
              "| appuntamento staccato ancora presente:", Appointment.objects.filter(id=split.json()["created"]["id"]).exists())
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.json()["items"]), 2)
