"""Tempo di posa: quella altrui si occupa solo a mano, e lavoro e posa stanno nell'apertura.

Le classi con un reperto della caccia del 22/09 nella docstring (NN-MM)
descrivono il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt
from decimal import Decimal

from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import SalonSettings
from common.testing import aware

from ..models import Appointment, AppointmentService
from ..services import appointments as S
from ..services.appointments import create_appointment, move_appointment
from ..services.availability import get_free_slots
from .base import AgendaTestBase, RealShiftsTestBase, _aware, hm


class SoakTimeTests(AgendaTestBase):
    """Semantica del tempo di posa (soak): attivo = hard-busy (blocca sempre),
    posa = soft-busy (sovrapposizione manuale ammessa, mai automatica)."""

    def setUp(self):
        from apps.catalog.models import Service

        category = self.svc60.category
        # servizio con posa: 30' attivi + 45' di posa
        self.svc_soak = Service.objects.create(
            salon=self.salon,
            category=category,
            name_it="Colore",
            duration_min=30,
            soak_min=45,
            price=Decimal("60.00"),
        )
        # servizio piano (nessuna posa), idoneo a op1 e op2
        self.svc_plain = Service.objects.create(
            salon=self.salon,
            category=category,
            name_it="Taglio",
            duration_min=30,
            soak_min=0,
            price=Decimal("25.00"),
        )
        self.svc_soak.operators.add(self.op1, self.op2)
        self.svc_plain.operators.add(self.op1, self.op2)
        self.wide = {
            self.op1.id: [(8 * 60, 20 * 60)],
            self.op2.id: [(8 * 60, 20 * 60)],
        }

    def _soak_appt_for_op1(self):
        """Appuntamento con posa per op1: attivo 10:00-10:30, posa 10:30-11:15."""
        appt = Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=self.op1,
            start=_aware(self.day, 10),
        )
        AppointmentService.objects.create(
            appointment=appt,
            service=self.svc_soak,
            operator=self.op1,
            duration_min=30,
            soak_min=45,
            price=Decimal("60.00"),
        )
        return appt

    def test_booking_soak_service_spans_active_plus_soak(self):
        from ..presenters import _item_out

        with self._windows(self.wide):
            appt = create_appointment(
                self.salon,
                self.client_obj,
                [{"service_id": self.svc_soak.id, "operator_id": self.op1.id}],
                _aware(self.day, 10),
                via="dashboard",
            )
        item = appt.items.get()
        self.assertEqual(item.duration_min, 30)  # attivo
        self.assertEqual(item.soak_min, 45)       # posa
        # total_duration_min = attivo + posa -> l'orario di fine è corretto
        self.assertEqual(appt.total_duration_min, 75)
        self.assertEqual(appt.end, _aware(self.day, 11, 15))
        # ItemOut espone soak_min (duration_min resta l'ATTIVO)
        out = _item_out(item)
        self.assertEqual(out["duration_min"], 30)
        self.assertEqual(out["soak_min"], 45)

    def test_availability_never_offers_start_inside_soak(self):
        # op1 impegnata: attivo 10:00-10:30, posa 10:30-11:15
        self._soak_appt_for_op1()
        with self._windows(self.wide):
            slots = get_free_slots(
                self.salon,
                self.day,
                [{"service_id": self.svc_plain.id, "operator_id": self.op1.id}],
            )
        starts = [s["start"] for s in slots]
        # nessuno start che cadrebbe nella posa altrui (auto NON riempie la posa)
        self.assertNotIn(_aware(self.day, 10, 30).isoformat(), starts)
        self.assertNotIn(_aware(self.day, 10, 45).isoformat(), starts)
        self.assertNotIn(_aware(self.day, 11).isoformat(), starts)
        # a posa finita torna disponibile
        self.assertIn(_aware(self.day, 11, 15).isoformat(), starts)

    def test_manual_move_into_soak_window_succeeds(self):
        self._soak_appt_for_op1()  # posa op1 10:30-11:15
        with self._windows(self.wide):
            appt_b = create_appointment(
                self.salon,
                self.client_obj,
                [{"service_id": self.svc_plain.id, "operator_id": self.op1.id}],
                _aware(self.day, 8),
                via="dashboard",
            )
            # spostato a 10:45 -> attivo 10:45-11:15: cade SOLO nella posa di A
            moved = move_appointment(appt_b, _aware(self.day, 10, 45))
        self.assertEqual(moved.start, _aware(self.day, 10, 45))

    def test_manual_move_into_active_window_conflicts(self):
        self._soak_appt_for_op1()  # attivo op1 10:00-10:30
        with self._windows(self.wide):
            appt_b = create_appointment(
                self.salon,
                self.client_obj,
                [{"service_id": self.svc_plain.id, "operator_id": self.op1.id}],
                _aware(self.day, 8),
                via="dashboard",
            )
            with self.assertRaises(HttpError) as caught:
                # 10:15-10:45 si sovrappone all'ATTIVO 10:00-10:30 di A -> conflitto
                move_appointment(appt_b, _aware(self.day, 10, 15))
        self.assertEqual(caught.exception.status_code, 409)

    def test_auto_assign_avoids_operator_in_soak(self):
        self._soak_appt_for_op1()  # op1 in posa 10:30-11:15
        with self._windows(self.wide):
            # auto (operator_id=None) a 10:45: op1 sarebbe nella posa -> sceglie op2
            appt = create_appointment(
                self.salon,
                self.client_obj,
                [{"service_id": self.svc_plain.id, "operator_id": None}],
                _aware(self.day, 10, 45),
                via="dashboard",
            )
        self.assertEqual(appt.operator_id, self.op2.id)
        self.assertEqual(appt.items.get().operator_id, self.op2.id)

    def test_auto_assign_no_alternative_raises_409(self):
        # solo op1 idoneo: in auto durante la posa nessun candidato -> 409
        self.svc_plain.operators.remove(self.op2)
        self._soak_appt_for_op1()  # op1 in posa 10:30-11:15
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            with self.assertRaises(HttpError) as caught:
                create_appointment(
                    self.salon,
                    self.client_obj,
                    [{"service_id": self.svc_plain.id, "operator_id": None}],
                    _aware(self.day, 10, 45),
                    via="dashboard",
                )
        self.assertEqual(caught.exception.status_code, 409)


class ClosingTimeOnEveryPathTests(AgendaTestBase):
    """«Non si finisce dopo la chiusura» non vale solo in creazione."""

    def setUp(self):
        self.svc30.soak_min = 60
        self.svc30.save(update_fields=["soak_min"])
        self.addCleanup(self._reset_soak)
        SalonSettings.objects.update_or_create(
            salon=self.salon,
            defaults={"opening_hours_week": {
                str((self.day + dt.timedelta(days=offset)).weekday()): [["09:00", "19:00"]]
                for offset in range(2)
            }},
        )
        self.salon.refresh_from_db()

    def _reset_soak(self):
        self.svc30.soak_min = 0
        self.svc30.save(update_fields=["soak_min"])

    def _appointment(self, hour):
        with self._windows({self.op1.id: [(0, 1440)]}):
            return create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, hour), via="dashboard", force=True,
            )

    def test_a_move_cannot_push_the_soak_past_closing_time(self):
        appointment = self._appointment(10)
        with self._windows({self.op1.id: [(0, 1440)]}):
            with self.assertRaises(HttpError) as caught:
                move_appointment(appointment, _aware(self.day, 18, 30))
        self.assertEqual(caught.exception.status_code, 409)
        appointment.refresh_from_db()
        self.assertEqual(timezone.localtime(appointment.start).hour, 10)

    def test_stretching_a_service_cannot_push_it_past_closing_time(self):
        from ..services.appointments import edit_appointment

        appointment = self._appointment(17)
        item = appointment.items.get()
        with self._windows({self.op1.id: [(0, 1440)]}):
            with self.assertRaises(HttpError) as caught:
                edit_appointment(
                    appointment,
                    items=[{
                        "id": item.id,
                        "service_id": self.svc30.id,
                        "operator_id": self.op1.id,
                        "duration_min": 90,  # 17:00 + 90' + 60' di posa = 19:30
                    }],
                )
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(appointment.items.get().duration_min, 30)


# ---- 01-08: la posa nella chiusura di pranzo, e oltre il turno ----------------


class SoakInsideTheOpeningBandTests(RealShiftsTestBase):
    def setUp(self):
        from apps.catalog.models import Service

        self.marta.services.clear()
        self.color = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Colore lungo", duration_min=30, soak_min=60,
            price=Decimal("60.00"),
        )
        self.giulia.services.add(self.color)

    def _split_hours(self):
        self.settings_row.opening_hours_week = {
            str(d): [["09:00", "13:00"], ["15:00", "19:00"]] for d in range(7)
        }
        self.settings_row.save(update_fields=["opening_hours_week"])
        self.salon.refresh_from_db()

    def test_soak_cannot_run_into_the_lunch_closure(self):
        self._split_hours()
        starts = [hm(s["start"]) for s in self.slots([{"service_id": self.color.id, "operator_id": None}])]
        self.assertIn("11:30", starts)      # finisce alle 13:00
        self.assertNotIn("12:00", starts)   # 13:30: a serranda abbassata
        self.assertNotIn("12:30", starts)
        with self.assertRaises(HttpError) as caught:
            S.create_appointment(
                self.salon, self.anna, [{"service_id": self.color.id}], aware(self.day, 12, 30),
                via="app", allow_past=False,
            )
        self.assertEqual(caught.exception.status_code, 409)

    def test_a_move_cannot_bring_the_soak_into_the_lunch_closure(self):
        self._split_hours()
        appointment = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.color.id}], aware(self.day, 10), via="dashboard",
        )
        with self.assertRaises(HttpError) as caught:
            S.move_appointment(appointment, aware(self.day, 12, 30))
        self.assertEqual(caught.exception.status_code, 409)

    def test_contiguous_bands_are_one_opening(self):
        self.settings_row.opening_hours_week = {
            str(d): [["09:00", "13:00"], ["13:00", "19:00"]] for d in range(7)
        }
        self.settings_row.save(update_fields=["opening_hours_week"])
        self.salon.refresh_from_db()
        starts = [hm(s["start"]) for s in self.slots([{"service_id": self.color.id, "operator_id": None}])]
        self.assertIn("12:30", starts)

    def test_without_opening_hours_the_soak_ends_within_the_last_shift(self):
        starts = [hm(s["start"]) for s in self.slots([{"service_id": self.color.id, "operator_id": None}])]
        self.assertIn("17:30", starts)      # posa fino alle 19:00
        self.assertNotIn("18:00", starts)   # posa fino alle 19:30, turno finito
        with self.assertRaises(HttpError) as caught:
            S.create_appointment(
                self.salon, self.anna, [{"service_id": self.color.id}], aware(self.day, 18),
                via="dashboard",
            )
        self.assertEqual(caught.exception.status_code, 409)
        # lo staff può comunque forzare
        forced = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.color.id}], aware(self.day, 18),
            via="dashboard", force=True,
        )
        self.assertTrue(forced.forced)


# ---- 01-11 + 04-08: dall'app mai nella posa altrui ---------------------------


class ClientNeverIntoForeignSoakTests(RealShiftsTestBase):
    def setUp(self):
        self.marta.services.clear()
        # colore di Bea: attivo 10:00–10:30, posa 10:30–10:50
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.color30s20, 30, 20)])
        self.items = [{"service_id": self.cut30.id, "operator_id": self.giulia.id}]

    def test_the_app_cannot_book_into_the_soak_even_with_the_stylist_chosen(self):
        starts = [hm(s["start"]) for s in self.slots(self.items)]
        self.assertNotIn("10:30", starts)
        res = self.post(
            "/api/agenda/client/appointments",
            {"items": self.items, "start": aware(self.day, 10, 30).isoformat()}, self.client_auth(),
        )
        self.assertEqual(res.status_code, 409, res.content)

    def test_the_staff_still_can(self):
        res = self.post(
            "/api/agenda/appointments",
            {"client_id": self.anna.id, "items": self.items, "start": aware(self.day, 10, 30).isoformat()},
            self.staff_auth(),
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["forced"])


class ClientMoveNeverLandsInAnotherSoakTests(AgendaTestBase):
    """01-11 / 04-08 (spostamento): dall'app mai dentro la posa di un'altra cliente."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        from apps.catalog.models import Service
        from apps.clients.models import Client

        cls.colour = Service.objects.create(
            salon=cls.salon, category=cls.svc60.category, name_it="Colore",
            duration_min=30, soak_min=60, price=Decimal("70.00"),
        )
        cls.op1.services.add(cls.colour)
        cls.other = Client.objects.create(
            salon=cls.salon, first_name="Anna", last_name="Neri", phone="+390000000009"
        )

    def setUp(self):
        self.windows = self._windows({self.op1.id: [(8 * 60, 20 * 60)]})
        self.windows.start()
        self.addCleanup(self.windows.stop)
        # Anna: colore alle 10:00, lavoro fino alle 10:30 e posa fino alle 11:30
        create_appointment(
            self.salon, self.other,
            [{"service_id": self.colour.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard",
        )
        self.mine = create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            _aware(self.day, 14), via="app",
        )

    def test_the_app_cannot_move_into_the_soak(self):
        with self.assertRaises(HttpError) as err:
            move_appointment(self.mine, _aware(self.day, 10, 30), allow_past=False)
        self.assertEqual(err.exception.status_code, 409)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.start, _aware(self.day, 14))

    def test_the_app_can_still_move_to_a_free_time(self):
        move_appointment(self.mine, _aware(self.day, 12), allow_past=False)
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.start, _aware(self.day, 12))

    def test_the_staff_still_decides_by_hand(self):
        move_appointment(self.mine, _aware(self.day, 10, 30))
        self.mine.refresh_from_db()
        self.assertEqual(self.mine.start, _aware(self.day, 10, 30))
        self.assertFalse(self.mine.forced)
