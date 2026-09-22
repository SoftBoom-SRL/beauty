"""Probe temporanei del revisore 16 (app cliente). Da cancellare a fine lavoro.

Ogni test afferma il comportamento CORRETTO: se fallisce, il difetto è confermato.
"""

import datetime as dt
import json

from apps.core.models import OutboxEvent
from common.auth import create_client_tokens

from .models import Appointment
from .services import cancel_appointment, create_appointment
from .tests import AgendaTestBase, _aware


class Probe16(AgendaTestBase):
    def setUp(self):
        self.cli = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        self.mapping = {self.op1.id: [(8 * 60, 20 * 60)]}

    def _post(self, url, body=None):
        return self.client.post(
            url, data=json.dumps(body or {}), content_type="application/json", **self.cli
        )

    def _booked(self, hour=10):
        return create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, hour), via="dashboard",
        )

    def test_move_of_cancelled_appointment_is_refused(self):
        with self._windows(self.mapping):
            appt = self._booked()
            cancel_appointment(appt, reason="Operatrice malata")
            before = OutboxEvent.objects.filter(event_type="appointment.moved").count()
            res = self._post(
                f"/api/agenda/client/appointments/{appt.id}/move",
                {"start": _aware(self.day, 15).isoformat()},
            )
        appt.refresh_from_db()
        moved_events = OutboxEvent.objects.filter(event_type="appointment.moved").count() - before
        print(f"\n[probe16 move-cancelled] status={res.status_code} appt.status={appt.status} "
              f"start={appt.start} eventi moved={moved_events}")
        self.assertGreaterEqual(res.status_code, 400, res.content)

    def test_cancel_of_cancelled_appointment_is_refused(self):
        with self._windows(self.mapping):
            appt = self._booked()
            cancel_appointment(appt, reason="Operatrice malata")
            before = OutboxEvent.objects.filter(event_type="appointment.cancelled").count()
            res = self._post(f"/api/agenda/client/appointments/{appt.id}/cancel")
        appt.refresh_from_db()
        again = OutboxEvent.objects.filter(event_type="appointment.cancelled").count() - before
        print(f"\n[probe16 cancel-cancelled] status={res.status_code} reason={appt.cancel_reason!r} "
              f"eventi cancelled in più={again}")
        self.assertGreaterEqual(res.status_code, 400, res.content)

    def test_client_move_response_hides_staff_note(self):
        with self._windows(self.mapping):
            appt = self._booked()
            Appointment.objects.filter(pk=appt.pk).update(note="Nota interna: non fare sconti, paga sempre in ritardo")
            res = self._post(
                f"/api/agenda/client/appointments/{appt.id}/move",
                {"start": _aware(self.day, 15).isoformat()},
            )
        body = res.json()
        print(f"\n[probe16 note] status={res.status_code} note nella risposta={body.get('note')!r} "
              f"chiavi={sorted(body)[:8]}…")
        self.assertNotIn("note", body)


class Probe16Sedi(AgendaTestBase):
    """Salone con due sedi: l'operatrice della sede secondaria compare nel
    selettore dell'app, ma l'app prenota solo sulla predefinita."""

    def test_operator_of_other_location_bookable_from_app(self):
        from apps.core.models import Location

        main = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        other = Location.objects.create(salon=self.salon, name="Mare")
        self.op1.location = main
        self.op1.save(update_fields=["location"])
        self.op2.location = other
        self.op2.save(update_fields=["location"])
        self.op2.services.add(self.svc60)
        cli = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        mapping = {self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}
        with self._windows(mapping):
            ops = self.client.get("/api/staff/public/operators", {"salon": self.salon.slug}).json()
            items = json.dumps([{"service_id": self.svc60.id, "operator_id": self.op2.id}])
            slots = self.client.get(
                "/api/agenda/public/availability",
                {"salon": self.salon.slug, "date": self.day.isoformat(), "items": items},
            ).json()
            first = slots[0] if slots else None
            res = self.client.post(
                "/api/agenda/client/appointments",
                data=json.dumps({"items": [{"service_id": self.svc60.id, "operator_id": self.op2.id}],
                                 "start": first["start"] if first else _aware(self.day, 10).isoformat()}),
                content_type="application/json", **cli,
            )
        print(f"\n[probe16 sedi] op2 nel selettore={any(o['id'] == self.op2.id for o in ops)} "
              f"slot proposti={len(slots)} assegnati a={first and first['assignment']} "
              f"POST={res.status_code} {res.content[:120]!r}")
        # Corretto: o l'operatrice non compare nel selettore, o si può prenotare con lei.
        in_picker = any(o["id"] == self.op2.id for o in ops)
        self.assertFalse(in_picker and res.status_code != 200)
