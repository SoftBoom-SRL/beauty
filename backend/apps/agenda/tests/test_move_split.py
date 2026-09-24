"""Spostamento e stacca-e-sposta: cambio di colonna, operatrici uscite o non più abilitate."""

import datetime as dt
import json
from decimal import Decimal

from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import ActivityLog, OutboxEvent, Salon, SalonSettings
from common.auth import create_staff_tokens
from common.testing import aware, bearer

from ..models import Appointment, Pause
from ..services import appointments as S
from ..services.appointments import create_appointment, move_appointment
from ..services.transitions import cancel_appointment
from .base import AgendaTestBase, RealShiftsTestBase, _aware, hm


class MoveWholeVisitToAnotherOperatorTests(AgendaTestBase):
    """Trascinando in un'altra colonna il gruppo di servizi, cambiano mano quelli
    della colonna di partenza — non sempre quelli dell'operatrice principale."""

    def setUp(self):
        self.op2.services.add(self.svc60, self.svc30)
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}

    def _visit(self, op_first, op_second, hour=10):
        with self._windows(self.wide):
            return create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": op_first.id},
                    {"service_id": self.svc30.id, "operator_id": op_second.id},
                ],
                _aware(self.day, hour), via="dashboard",
            )

    def test_all_the_services_follow_the_main_operator(self):
        visit = self._visit(self.op1, self.op1)
        with self._windows(self.wide):
            moved = move_appointment(visit, _aware(self.day, 12), operator=self.op2)
        self.assertEqual(moved.operator_id, self.op2.id)
        self.assertEqual(
            {item.operator_id for item in moved.items.all()}, {self.op2.id}
        )
        self.assertEqual(timezone.localtime(moved.start).hour, 12)

    def test_only_the_dragged_column_changes_hands(self):
        """La visita è divisa fra due operatrici: si sposta il gruppo di op2."""
        visit = self._visit(self.op1, self.op2)
        with self._windows(self.wide):
            moved = move_appointment(
                visit, visit.start, operator=self.op1, from_operator=self.op2
            )
        by_service = {item.service_id: item.operator_id for item in moved.items.all()}
        self.assertEqual(by_service[self.svc60.id], self.op1.id)
        self.assertEqual(by_service[self.svc30.id], self.op1.id)
        # la principale non cambia: a cambiare colonna sono stati i servizi della collega
        self.assertEqual(moved.operator_id, self.op1.id)

    def test_the_main_operator_stays_when_a_colleague_column_moves(self):
        visit = self._visit(self.op2, self.op1)   # principale = op2
        self.assertEqual(visit.operator_id, self.op2.id)
        with self._windows(self.wide):
            moved = move_appointment(
                visit, visit.start, operator=self.op2, from_operator=self.op1
            )
        self.assertEqual(moved.operator_id, self.op2.id)
        self.assertEqual({item.operator_id for item in moved.items.all()}, {self.op2.id})

    def test_an_unqualified_operator_is_refused(self):
        self.op2.services.clear()
        visit = self._visit(self.op1, self.op1)
        with self._windows(self.wide), self.assertRaises(HttpError) as caught:
            move_appointment(visit, visit.start, operator=self.op2)
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_endpoint_passes_the_source_column(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="spina@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        visit = self._visit(self.op1, self.op2)
        with self._windows(self.wide):
            res = self.client.post(
                f"/api/agenda/appointments/{visit.id}/move",
                data=json.dumps({
                    "start": visit.start.isoformat(),
                    "operator_id": self.op1.id,
                    "from_operator_id": self.op2.id,
                }),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            {item["operator_id"] for item in res.json()["items"]}, {self.op1.id}
        )


class SplitAppointmentTests(AgendaTestBase):
    def test_split_moves_one_service_to_its_own_appointment(self):
        from ..services.appointments import split_appointment

        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}, {"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            second = appointment.items.order_by("order").last()
            tomorrow = self.day + dt.timedelta(days=1)
            original, created = split_appointment(appointment, second.id, _aware(tomorrow, 15))
        self.assertEqual(original.items.count(), 1)
        self.assertEqual(created.items.count(), 1)
        self.assertEqual(created.client_id, self.client_obj.id)
        self.assertEqual(created.items.get().service_id, self.svc30.id)
        self.assertEqual(timezone.localtime(created.start).date(), tomorrow)
        self.assertEqual(original.total_duration_min, 60)
        self.assertTrue(ActivityLog.objects.filter(salon=self.salon, type="appointment.split").exists())

    def test_split_refuses_single_service_and_busy_slot(self):
        from ..services.appointments import split_appointment

        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            single = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            with self.assertRaises(HttpError) as caught:
                split_appointment(single, single.items.get().id, _aware(self.day, 14))
            self.assertEqual(caught.exception.status_code, 400)
            multi = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}, {"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 12), via="dashboard",
            )
            item = multi.items.order_by("order").last()
            with self.assertRaises(HttpError) as caught:
                split_appointment(multi, item.id, _aware(self.day, 10, 15))  # sopra `single`
            self.assertEqual(caught.exception.status_code, 409)
            # forzato passa
            split_appointment(multi, item.id, _aware(self.day, 10, 15), force=True)
        self.assertEqual(Appointment.objects.count(), 3)


class SplitCollisionTests(AgendaTestBase):
    """Lo stacca-e-sposta non deve creare sovrapposizioni: né con i servizi che
    restano nella visita, né con altre clienti quando la catena residua scala."""

    def test_detached_service_cannot_overlap_the_services_that_stay(self):
        from ..services.appointments import split_appointment

        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}, {"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            second = appointment.items.order_by("order").last()
            # 10:15 cade dentro il primo servizio (10:00–11:00), che resta nella visita
            with self.assertRaises(HttpError) as caught:
                split_appointment(appointment, second.id, _aware(self.day, 10, 15))
            self.assertEqual(caught.exception.status_code, 409)
        appointment.refresh_from_db()
        self.assertEqual(appointment.items.count(), 2)          # rollback completo
        self.assertEqual(Appointment.objects.count(), 1)

    def test_the_services_that_stay_keep_the_time_they_were_booked_for(self):
        """Staccando il PRIMO servizio, la copertura delle 11:00 resta alle 11:00.

        Prima la catena residua ripartiva da `start` e scivolava alle 10:00 da
        sola: la cliente si presentava a un orario che in agenda non c'era più e,
        se quel posto era occupato, il ritentativo forzato della dashboard la
        metteva sopra un'altra cliente.
        """
        from apps.clients.models import Client

        from ..services.appointments import split_appointment

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000009")
        self.op2.services.add(self.svc30)
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}):
            # visita: 10:00 svc60 (op1) + 11:00 svc30 (op2)
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}, {"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 10), via="dashboard",
            )
            # op2 è occupata alle 10:00 da un'altra cliente: se la catena
            # residua scalasse indietro le finirebbe addosso
            elsewhere = create_appointment(
                self.salon, other, [{"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 10), via="dashboard",
            )
            first = appointment.items.order_by("order").first()
            original, created = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        # la visita ora comincia dal servizio rimasto, all'ora in cui era
        self.assertEqual(timezone.localtime(original.start).hour, 11)
        self.assertEqual(original.items.count(), 1)
        self.assertFalse(original.forced)
        self.assertEqual(timezone.localtime(created.start).hour, 15)
        # l'altra cliente non è stata sfiorata
        elsewhere.refresh_from_db()
        self.assertEqual(timezone.localtime(elsewhere.start).hour, 10)

    def test_a_service_detached_from_the_middle_leaves_the_rest_where_it_was(self):
        """Staccando un servizio da in mezzo, quelli dopo restano alla loro ora:
        il suo tempo diventa attesa dopo il servizio precedente. Ricompattare
        la catena anticipava in silenzio il terzo servizio sopra l'altra
        cliente di op2 (caccia ai bug del 22/09, 02-02 e 12-01)."""
        from apps.clients.models import Client

        from ..services.appointments import split_appointment

        other = Client.objects.create(salon=self.salon, first_name="Terza", last_name="Cliente", phone="+390000000008")
        self.op2.services.add(self.svc30)
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}):
            # visita: 10:00 svc30 (op1) + 10:30 svc60 (op1) + 11:30 svc30 (op2)
            appointment = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
            # op2 occupata alle 10:30: è lì che finirebbe il terzo servizio
            # se la catena si ricompattasse
            elsewhere = create_appointment(
                self.salon, other, [{"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 10, 30), via="dashboard",
            )
            middle = appointment.items.order_by("order")[1]
            original, created = split_appointment(appointment, middle.id, _aware(self.day, 15))
        original.refresh_from_db()
        first, last = list(original.items.order_by("order"))
        self.assertEqual(timezone.localtime(original.start).hour, 10)
        # 30' di lavoro + 60' di attesa: il terzo servizio resta alle 11:30
        self.assertEqual((first.duration_min, first.soak_min), (30, 60))
        self.assertEqual(last.operator_id, self.op2.id)
        self.assertFalse(original.forced)
        self.assertEqual(timezone.localtime(created.start).hour, 15)
        elsewhere.refresh_from_db()
        self.assertEqual(timezone.localtime(elsewhere.start).strftime("%H:%M"), "10:30")


class BugHunt21SeptemberTests(AgendaTestBase):
    """Difetti trovati nella caccia ai bug del 21/09/2026 (docs/BUG_HUNT_2026-09-21.md)."""

    def _staff(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="hunt21@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda", "sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return bearer(user, self.salon)

    def _visit(self, items, hour=10, **fields):
        with self._windows({self.op1.id: [(0, 24 * 60)], self.op2.id: [(0, 24 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, hour),
                via="dashboard", force=True,
            )
        if fields:
            for name, value in fields.items():
                setattr(appointment, name, value)
            appointment.save(update_fields=list(fields) + ["updated_at"])
        return appointment

    # ---- B16 -------------------------------------------------------------

    def test_an_appointment_of_a_deactivated_stylist_can_still_be_moved(self):
        """La vista giorno mostra la colonna di chi ha lasciato il salone «così
        si possono riassegnare»: mandando sempre `operator_id`, l'API lo cercava
        fra le operatrici ATTIVE e rispondeva 404 a ogni spostamento."""
        auth = self._staff()
        appointment = self._visit([{"service_id": self.svc30.id, "operator_id": self.op1.id}])
        self.op1.active = False
        self.op1.save(update_fields=["active"])

        # la colonna c'è ancora, marcata inattiva
        day = self.client.get(f"/api/agenda/day?date={self.day.isoformat()}", **auth)
        self.assertEqual(day.status_code, 200, day.content)
        row = next(r for r in day.json() if r["operator"]["id"] == self.op1.id)
        self.assertTrue(row["operator"]["inactive"])

        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            moved = self.client.post(
                f"/api/agenda/appointments/{appointment.id}/move",
                json.dumps({"start": _aware(self.day, 12).isoformat(), "operator_id": self.op1.id}),
                content_type="application/json",
                **auth,
            )
        self.assertEqual(moved.status_code, 200, moved.content)
        appointment.refresh_from_db()
        self.assertEqual(timezone.localtime(appointment.start).hour, 12)

    def test_a_new_assignment_still_requires_an_active_stylist(self):
        auth = self._staff()
        appointment = self._visit([{"service_id": self.svc30.id, "operator_id": self.op1.id}])
        self.op2.services.add(self.svc30)
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        with self._windows({self.op1.id: [(0, 24 * 60)], self.op2.id: [(0, 24 * 60)]}):
            response = self.client.post(
                f"/api/agenda/appointments/{appointment.id}/move",
                json.dumps({"start": _aware(self.day, 12).isoformat(), "operator_id": self.op2.id}),
                content_type="application/json",
                **auth,
            )
        self.assertEqual(response.status_code, 404, response.content)

    # ---- B18 -------------------------------------------------------------

    def test_a_move_cannot_push_the_soak_past_closing_time(self):
        """La creazione lo vietava già (la cliente resta in salone durante la
        posa); lo spostamento no, nemmeno dall'app cliente."""
        SalonSettings.objects.update_or_create(
            salon=self.salon,
            defaults={"opening_hours_week": {str(d): [["09:00", "18:00"]] for d in range(7)}},
        )
        self.salon.refresh_from_db()
        self.svc30.soak_min = 60
        self.svc30.save(update_fields=["soak_min"])
        try:
            appointment = self._visit([{"service_id": self.svc30.id, "operator_id": self.op1.id}])
            with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
                # 17:30 + 30' di lavoro + 60' di posa = 19:00, un'ora dopo la chiusura
                with self.assertRaises(HttpError) as caught:
                    move_appointment(appointment, _aware(self.day, 17, 30))
                self.assertEqual(caught.exception.status_code, 409)
                appointment.refresh_from_db()
                self.assertEqual(timezone.localtime(appointment.start).hour, 10)
                # lo staff può ancora forzare consapevolmente
                moved = move_appointment(appointment, _aware(self.day, 17, 30), force=True)
                self.assertEqual(timezone.localtime(moved.start).hour, 17)
        finally:
            self.svc30.soak_min = 0
            self.svc30.save(update_fields=["soak_min"])

    # ---- B21 -------------------------------------------------------------

    def test_a_freed_slot_declares_the_whole_time_it_frees(self):
        """`slot.freed` portava la sola fase attiva: un colore da 30' di lavoro e
        60' di posa liberava «30 minuti» e alla lista d'attesa venivano proposti
        servizi che in quel buco non entravano."""
        self.svc30.soak_min = 60
        self.svc30.save(update_fields=["soak_min"])
        try:
            appointment = self._visit([{"service_id": self.svc30.id, "operator_id": self.op1.id}])
            self.assertEqual(appointment.total_duration_min, 90)
            OutboxEvent.objects.all().delete()
            cancel_appointment(appointment)
            freed = OutboxEvent.objects.get(salon=self.salon, event_type="slot.freed")
            self.assertEqual(freed.payload["duration_min"], 90)
        finally:
            self.svc30.soak_min = 0
            self.svc30.save(update_fields=["soak_min"])

    # ---- B24 -------------------------------------------------------------

    def test_a_manual_refund_writes_the_amount_it_gave_back(self):
        from ..services.refunds import mark_deposit_refunded

        appointment = self._visit(
            [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            deposit_status=Appointment.DepositStatus.REFUND_DUE,
            deposit_amount=Decimal("30.00"),
        )
        mark_deposit_refunded(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("30.00"))
        entry = next(iter(appointment.deposit_refunds.values()))
        self.assertEqual(entry["status"], "succeeded")
        self.assertEqual(entry["amount_cents"], 3000)
        self.assertTrue(entry["manual"])

    def test_a_manual_refund_after_a_partial_one_only_covers_the_rest(self):
        from ..services.refunds import mark_deposit_refunded, record_deposit_refund

        appointment = self._visit(
            [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            deposit_status=Appointment.DepositStatus.PAID,
            deposit_amount=Decimal("30.00"),
        )
        # 10 € già tornati da Stripe
        record_deposit_refund(appointment, refund_id="re_1", cents=1000, status="succeeded")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        appointment.deposit_status = Appointment.DepositStatus.REFUND_DUE
        appointment.save(update_fields=["deposit_status", "updated_at"])

        mark_deposit_refunded(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("30.00"))
        self.assertEqual(appointment.deposit_refunds["re_1"]["amount_cents"], 1000)
        manual = [r for k, r in appointment.deposit_refunds.items() if k.startswith("manual-")]
        self.assertEqual([r["amount_cents"] for r in manual], [2000])

    # ---- Pause a cavallo della mezzanotte --------------------------------

    def test_a_break_that_runs_past_midnight_still_blocks_the_next_day(self):
        from ..services.occupancy import _busy_map

        Pause.objects.create(
            salon=self.salon, operator=self.op1,
            start=_aware(self.day, 23, 30), duration_min=60, note="Chiusura",
        )
        busy = _busy_map(self.salon, self.day + dt.timedelta(days=1))
        self.assertTrue(
            any(start < 30 and end > 0 for start, end, hard in busy.get(self.op1.id, []) if hard),
            busy.get(self.op1.id),
        )


class DeactivatedOperatorTests(AgendaTestBase):
    """Chi lascia il salone non può congelare le visite delle sue clienti."""

    def test_the_client_can_still_find_a_slot_after_her_operator_left(self):
        from common.auth import create_client_tokens

        self.op2.services.add(self.svc60)  # una collega sa fare lo stesso servizio
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="app",
            )
            self.op1.active = False
            self.op1.save(update_fields=["active"])
            auth = {
                "HTTP_AUTHORIZATION":
                f"Bearer {create_client_tokens(self.client_obj)['access']}"
            }
            res = self.client.get(
                "/api/agenda/client/availability",
                {
                    "date": self.day.isoformat(),
                    "items": json.dumps([{"service_id": self.svc60.id}]),
                    "exclude_appointment_id": appointment.id,
                },
                **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        slots = res.json()
        self.assertTrue(slots, "senza slot la cliente non può più spostare la visita")
        self.assertTrue(
            all(a["operator_id"] == self.op2.id for s in slots for a in s["assignment"])
        )
        self.op1.active = True
        self.op1.save(update_fields=["active"])


# ---- 04-03 + 02-15 + 17-07: spostare dall'app la visita di chi è uscita -------


class ClientMoveOperatorLeftTests(RealShiftsTestBase):
    def _left(self, operator):
        operator.active = False
        operator.save(update_fields=["active"])

    def _availability(self, appointment, day):
        return self.client.get(
            "/api/agenda/client/availability",
            {"date": day.isoformat(), "items": "[]", "exclude_appointment_id": appointment.id},
            **self.client_auth(),
        )

    def test_the_move_applies_the_colleague_the_search_proposed(self):
        # Giulia è uscita ma i turni del mattino le sono rimasti.
        appointment = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.shifts(self.giulia, 9 * 60, 13 * 60)
        self._left(self.giulia)
        new_day = self.day + dt.timedelta(days=1)
        res = self._availability(appointment, new_day)
        self.assertEqual(res.status_code, 200, res.content)
        by_start = {hm(s["start"]): s for s in res.json()}
        self.assertIn("15:00", by_start)
        self.assertEqual(by_start["15:00"]["assignment"][0]["operator_id"], self.marta.id)

        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(new_day, 15).isoformat()}, self.client_auth(),
        )
        # prima: 409 «orario appena preso» a ripetizione
        self.assertEqual(moved.status_code, 200, moved.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.operator_id, self.marta.id)
        self.assertEqual(list(appointment.items.values_list("operator_id", flat=True)), [self.marta.id])

    def test_a_morning_move_does_not_leave_the_visit_to_who_left(self):
        appointment = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.shifts(self.giulia, 9 * 60, 13 * 60)
        self._left(self.giulia)
        new_day = self.day + dt.timedelta(days=1)
        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(new_day, 11).isoformat()}, self.client_auth(),
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        appointment.refresh_from_db()
        # prima: spostata, ma ancora a Giulia, che non lavora più lì
        self.assertEqual(appointment.operator_id, self.marta.id)

    def test_all_the_rows_of_who_left_go_to_one_colleague(self):
        # Visita: taglio + manicure, entrambe di Giulia (uscita). Marta è libera
        # per il taglio ma non per la manicure; Paola per tutte e due. La
        # conferma riassegna una colonna sola: la ricerca deve proporre Paola
        # per entrambe, non Marta + Paola.
        paola = self.operator("Paola", order=2)
        appointment = self.book(
            self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0), (self.man60, 60, 0)],
        )
        self._left(self.giulia)
        new_day = self.day + dt.timedelta(days=1)
        self.book(self.bea, self.marta, aware(new_day, 15, 30), [(self.man60, 60, 0)])
        res = self._availability(appointment, new_day)
        at15 = next(s for s in res.json() if hm(s["start"]) == "15:00")
        self.assertEqual([a["operator_id"] for a in at15["assignment"]], [paola.id, paola.id])
        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(new_day, 15).isoformat()}, self.client_auth(),
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        self.assertEqual(
            list(appointment.items.order_by("order").values_list("operator_id", flat=True)),
            [paola.id, paola.id],
        )

    def test_rows_of_a_colleague_still_in_team_stay_with_her(self):
        appointment = self.book(
            self.anna, self.giulia, aware(self.day, 10),
            [(self.cut30, 30, 0), (self.man60, 60, 0, self.marta)],
        )
        self._left(self.giulia)
        paola = self.operator("Paola", order=2)
        new_day = self.day + dt.timedelta(days=1)
        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(new_day, 11).isoformat()}, self.client_auth(),
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        rows = list(appointment.items.order_by("order").values_list("operator_id", flat=True))
        self.assertEqual(rows, [self.marta.id, self.marta.id])  # Marta è la prima idonea libera
        self.assertNotIn(paola.id, rows)

    def test_a_cancelled_visit_is_still_refused_as_such(self):
        appointment = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        appointment.status = Appointment.Status.CANCELLED
        appointment.save(update_fields=["status"])
        self._left(self.giulia)
        self.marta.services.clear()  # nessuna collega: la ricerca non troverebbe posto
        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(self.day + dt.timedelta(days=1), 11).isoformat()}, self.client_auth(),
        )
        self.assertEqual(moved.status_code, 400, moved.content)

    def test_two_operators_gone_means_contact_the_salon(self):
        lia = self.operator("Lia", order=3)
        appointment = self.book(
            self.anna, self.giulia, aware(self.day, 10),
            [(self.cut30, 30, 0), (self.man60, 60, 0, lia)],
        )
        self._left(self.giulia)
        self._left(lia)
        new_day = self.day + dt.timedelta(days=1)
        res = self._availability(appointment, new_day)
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("contatta il salone", res.json()["detail"])
        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(new_day, 11).isoformat()}, self.client_auth(),
        )
        self.assertEqual(moved.status_code, 400, moved.content)
        appointment.refresh_from_db()
        self.assertEqual(timezone.localtime(appointment.start).date(), self.day)


# ---- 01-10: spostando, niente idoneità di oggi sulle righe esistenti ---------


class MoveAfterLostSkillTests(RealShiftsTestBase):
    def test_the_visit_can_be_moved_after_its_operator_lost_the_skill(self):
        appointment = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.giulia.services.remove(self.cut30)
        new_day = self.day + dt.timedelta(days=1)
        res = self.client.get(
            "/api/agenda/client/availability",
            {"date": new_day.isoformat(), "items": "[]", "exclude_appointment_id": appointment.id},
            **self.client_auth(),
        )
        slots = res.json()
        self.assertTrue(slots, "senza orari la cliente non può più spostare la visita")
        self.assertTrue(all(a["operator_id"] == self.giulia.id for s in slots for a in s["assignment"]))
        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": slots[0]["start"]}, self.client_auth(),
        )
        self.assertEqual(moved.status_code, 200, moved.content)


# ---- 01-05 + 02-24 (C1): «Riprogramma» dello staff ---------------------------


class StaffRescheduleTests(RealShiftsTestBase):
    def setUp(self):
        self.marta.services.clear()
        # visita allungata a 90' (snapshot) rispetto ai 60 del listino
        self.visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 90, 0)])
        self.book(self.bea, self.giulia, aware(self.day, 13), [(self.cut30, 30, 0)])

    def _starts(self, **params):
        res = self.client.get(
            "/api/agenda/availability",
            {"date": self.day.isoformat(), "exclude_appointment_id": self.visit.id, **params},
            **self.staff_auth(),
        )
        self.assertEqual(res.status_code, 200, res.content)
        return [hm(s["start"]) for s in res.json()]

    def test_the_visit_does_not_block_itself_and_keeps_its_duration(self):
        starts = self._starts()
        self.assertIn("10:30", starts)      # spostarla di mezz'ora
        self.assertIn("11:30", starts)      # 11:30–13:00: sta in piedi
        self.assertNotIn("12:00", starts)   # 90' dalle 12 urterebbero le 13
        S.move_appointment(self.visit, aware(self.day, 10, 30))

    def test_items_sent_by_the_dashboard_are_ignored(self):
        items = json.dumps([{"service_id": self.man60.id, "operator_id": self.giulia.id}])
        self.assertNotIn("12:00", self._starts(items=items))

    def test_a_service_retired_from_the_price_list_can_still_be_rescheduled(self):
        self.man60.active = False
        self.man60.save(update_fields=["active"])
        self.assertIn("10:30", self._starts())

    def test_another_salons_appointment_is_404(self):
        from apps.clients.models import Client
        from apps.staff.models import Operator

        other = Salon.objects.create(name="Altro", slug="altro-caccia22")
        stranger = Client.objects.create(salon=other, first_name="X", last_name="Y", phone="+393339999999")
        someone = Operator.objects.create(salon=other, first_name="Op", last_name="Altrove")
        foreign = Appointment.objects.create(
            salon=other, client=stranger, operator=someone, start=aware(self.day, 10),
        )
        res = self.client.get(
            "/api/agenda/availability",
            {"date": self.day.isoformat(), "exclude_appointment_id": foreign.id},
            **self.staff_auth(),
        )
        self.assertEqual(res.status_code, 404)
