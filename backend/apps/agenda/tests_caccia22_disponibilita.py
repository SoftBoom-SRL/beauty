"""Caccia del 22/09: motore di disponibilità e conferma (ricerca = conferma).

Turni veri (WeeklyShift), niente mock di `shift_windows`: i difetti stavano
proprio nel punto in cui ricerca e conferma guardavano cose diverse.
"""

import datetime as dt
import json
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Location, Salon, SalonSettings
from common.auth import create_client_tokens, create_staff_tokens

from . import services as S
from .models import Appointment, AppointmentService


def aware(day, hour, minute=0):
    return timezone.make_aware(dt.datetime.combine(day, dt.time(hour, minute)))


def hm(iso):
    return f"{timezone.localtime(dt.datetime.fromisoformat(iso)):%H:%M}"


class Caccia22Base(TestCase):
    """Due operatrici (Giulia prima in ordine, Marta seconda), turno 9–19 tutti i giorni."""

    @classmethod
    def setUpTestData(cls):
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator

        cls.salon = Salon.objects.create(name="Caccia 22", slug="caccia-22-agenda")
        cls.settings_row = SalonSettings.objects.create(
            salon=cls.salon, slot_interval_min=15, agenda_fill="max_revenue",
            automation_delay_seconds=0,
        )
        cls.cat = ServiceCategory.objects.create(salon=cls.salon, name_it="Capelli", color="#FFFFFF", order=0)
        cls.cut30 = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Taglio", duration_min=30, price=Decimal("30.00"),
        )
        cls.color30s20 = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Colore", duration_min=30, soak_min=20,
            price=Decimal("50.00"),
        )
        cls.man60 = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Manicure", duration_min=60, price=Decimal("40.00"),
        )
        cls.giulia = Operator.objects.create(salon=cls.salon, first_name="Giulia", last_name="A", order=0)
        cls.marta = Operator.objects.create(salon=cls.salon, first_name="Marta", last_name="B", order=1)
        for op in (cls.giulia, cls.marta):
            op.services.add(cls.cut30, cls.color30s20, cls.man60)
            cls.shifts(op, 9 * 60, 19 * 60)
        cls.anna = Client.objects.create(salon=cls.salon, first_name="Anna", last_name="R", phone="+393330000001")
        cls.bea = Client.objects.create(salon=cls.salon, first_name="Bea", last_name="S", phone="+393330000002")
        cls.day = timezone.localdate() + dt.timedelta(days=10)

    @staticmethod
    def shifts(op, start_min, end_min):
        from apps.staff.models import WeeklyShift

        WeeklyShift.objects.filter(operator=op).delete()
        for weekday in range(7):
            WeeklyShift.objects.create(
                operator=op, week_index=0, weekday=weekday, start_min=start_min, end_min=end_min,
            )

    def operator(self, first_name, *, services=None, start_min=9 * 60, end_min=19 * 60, **fields):
        from apps.staff.models import Operator

        op = Operator.objects.create(salon=self.salon, first_name=first_name, last_name="Z", **fields)
        op.services.add(*(services or (self.cut30, self.color30s20, self.man60)))
        self.shifts(op, start_min, end_min)
        return op

    def book(self, client, op, start, items):
        """items = [(servizio, durata, posa)] tutti di `op` (o [(servizio, durata, posa, op)])."""
        appointment = Appointment.objects.create(salon=self.salon, client=client, operator=op, start=start)
        for index, entry in enumerate(items):
            service, duration, soak = entry[:3]
            AppointmentService.objects.create(
                appointment=appointment, service=service, operator=entry[3] if len(entry) > 3 else op,
                duration_min=duration, soak_min=soak, price=service.price, order=index,
            )
        return appointment

    def staff_auth(self, scopes=("agenda",), *, email="desk@caccia22.it", owner=False):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email=email, password="x" * 12)
        role = Role.objects.create(salon=self.salon, name=f"Ruolo {email}", scopes=list(scopes))
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=owner)
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def client_auth(self, client=None):
        return {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client or self.anna)['access']}"}

    def post(self, url, body, auth):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **auth)

    def put(self, url, body, auth):
        return self.client.put(url, data=json.dumps(body), content_type="application/json", **auth)

    def slots(self, items, day=None, **kwargs):
        return S.get_free_slots(self.salon, day or self.day, items, **kwargs)


# ---- 01-01 + 13-12: forzando, «Prima disponibile» va a chi è libera ----------


class ForcedFirstAvailableTests(Caccia22Base):
    def test_forced_first_available_goes_to_the_free_colleague(self):
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        appointment = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": None}],
            aware(self.day, 10, 10), via="dashboard", force=True,
        )
        # Marta è libera: nessuna doppia prenotazione su Giulia, e l'orario
        # fuori griglia (10:10) ma libero non è una forzatura.
        self.assertEqual(appointment.operator_id, self.marta.id)
        self.assertFalse(appointment.forced)

    def test_when_forcing_is_needed_the_free_one_is_still_preferred(self):
        # Giulia occupata 10–11. La seconda voce è chiesta a Giulia: serve forzare
        # la visita intera, ma la prima («Prima disponibile») va a Marta, libera.
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        appointment = S.create_appointment(
            self.salon, self.anna,
            [
                {"service_id": self.cut30.id, "operator_id": None},
                {"service_id": self.cut30.id, "operator_id": self.giulia.id},
            ],
            aware(self.day, 10), via="dashboard", force=True,
        )
        operators = list(appointment.items.values_list("operator_id", flat=True))
        self.assertEqual(operators, [self.marta.id, self.giulia.id])
        self.assertTrue(appointment.forced)

    def test_nobody_free_falls_back_to_the_first_eligible(self):
        # 18:45 + 30' va oltre il turno di tutte: forzando si ripiega sulla prima.
        appointment = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": None}],
            aware(self.day, 18, 45), via="dashboard", force=True,
        )
        self.assertEqual(appointment.operator_id, self.giulia.id)
        self.assertTrue(appointment.forced)


# ---- 01-02: la stessa cliente non cambia l'assegnazione proposta ------------


class SameClientAssignmentTests(Caccia22Base):
    def test_first_available_follows_the_search_not_the_same_client_operator(self):
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        slots = self.slots([{"service_id": self.man60.id, "operator_id": None}])
        at10 = next(s for s in slots if hm(s["start"]) == "10:00")
        self.assertEqual(at10["assignment"][0]["operator_id"], self.marta.id)
        appointment = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.man60.id, "operator_id": None}],
            aware(self.day, 10), via="dashboard", client_overlap_ok=True,
        )
        self.assertEqual(appointment.operator_id, self.marta.id)
        self.assertFalse(appointment.forced)

    def test_same_client_is_ignored_only_as_a_fallback(self):
        # Marta è impegnata con un'altra cliente: resta Giulia, già con Anna —
        # la stessa seduta, non una forzatura.
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        self.book(self.bea, self.marta, aware(self.day, 10), [(self.man60, 60, 0)])
        appointment = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": None}],
            aware(self.day, 10), via="dashboard", client_overlap_ok=True,
        )
        self.assertEqual(appointment.operator_id, self.giulia.id)
        self.assertFalse(appointment.forced)


# ---- 01-03 + 04-04: prenotazione nuova, operatrice non prenotabile ------------


class NewBookingUnbookableOperatorTests(Caccia22Base):
    def setUp(self):
        self.centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        self.nord = Location.objects.create(salon=self.salon, name="Nord")
        self.lia = self.operator("Lia", location=self.nord)

    def test_stylist_of_another_location_gets_no_slots_from_the_app(self):
        items = [{"service_id": self.cut30.id, "operator_id": self.lia.id}]
        res = self.client.get(
            "/api/agenda/client/availability",
            {"date": self.day.isoformat(), "items": json.dumps(items)}, **self.client_auth(),
        )
        self.assertEqual(res.status_code, 200, res.content)
        # prima: orari di un'altra operatrice, e ogni conferma «Operatrice non idonea»
        self.assertEqual(res.json(), [])
        booked = self.post(
            "/api/agenda/client/appointments",
            {"items": items, "start": aware(self.day, 10).isoformat()}, self.client_auth(),
        )
        self.assertEqual(booked.status_code, 400, booked.content)

    def test_public_and_staff_searches_do_not_swap_the_stylist_either(self):
        items = json.dumps([{"service_id": self.cut30.id, "operator_id": self.lia.id}])
        public = self.client.get(
            "/api/agenda/public/availability",
            {"salon": self.salon.slug, "date": self.day.isoformat(), "items": items},
        )
        self.assertEqual(public.json(), [])
        staff = self.client.get(
            "/api/agenda/availability",
            {"date": self.day.isoformat(), "items": items, "location_id": self.centro.id},
            **self.staff_auth(),
        )
        self.assertEqual(staff.json(), [])

    def test_deactivated_stylist_gets_no_slots_for_a_new_booking(self):
        self.lia.location = None
        self.lia.active = False
        self.lia.save(update_fields=["location", "active"])
        self.assertEqual(self.slots([{"service_id": self.cut30.id, "operator_id": self.lia.id}]), [])


# ---- 04-03 + 02-15 + 17-07: spostare dall'app la visita di chi è uscita -------


class ClientMoveOperatorLeftTests(Caccia22Base):
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


class MoveAfterLostSkillTests(Caccia22Base):
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


# ---- 01-04: «Consigliati» e la posa ------------------------------------------


class RecommendedWithSoakTests(Caccia22Base):
    def setUp(self):
        from apps.catalog.models import Service

        self.marta.services.clear()
        self.color15 = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Colore breve", duration_min=30, soak_min=15,
            price=Decimal("45.00"),
        )
        self.giulia.services.add(self.color15)

    def test_the_slot_right_after_a_foreign_soak_is_recommended(self):
        self.book(self.bea, self.giulia, aware(self.day, 9), [(self.color15, 30, 15)])  # posa fino alle 9:45
        slots = self.slots([{"service_id": self.cut30.id, "operator_id": None}])
        by = {hm(s["start"]): s["recommended"] for s in slots}
        self.assertTrue(by["09:45"])
        self.assertFalse(by["10:00"])  # lascia 15' morti dopo la posa
        self.assertIn("09:45", [hm(s["start"]) for s in S.smart_slots(self.salon, slots)])

    def test_colour_and_cut_of_the_same_operator_can_be_recommended(self):
        slots = self.slots([
            {"service_id": self.color30s20.id, "operator_id": None},
            {"service_id": self.cut30.id, "operator_id": None},
        ])
        # la posa del colore seguita dal taglio non è un buco
        self.assertTrue(any(s["recommended"] for s in slots))
        self.assertTrue(next(s for s in slots if hm(s["start"]) == "09:00")["recommended"])

    def test_a_colour_whose_soak_ends_when_the_next_client_arrives(self):
        self.book(self.bea, self.giulia, aware(self.day, 10, 45), [(self.cut30, 30, 0)])
        slots = self.slots([{"service_id": self.color15.id, "operator_id": None}])
        by = {hm(s["start"]): s["recommended"] for s in slots}
        self.assertTrue(by["10:00"])  # attivo 10:00–10:30, posa fino alle 10:45: attaccato
        self.assertFalse(by["09:45"])  # finirebbe alle 10:30 e lascerebbe 15' morti


# ---- 01-05 + 02-24 (C1): «Riprogramma» dello staff ---------------------------


class StaffRescheduleTests(Caccia22Base):
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


# ---- 01-08: la posa nella chiusura di pranzo, e oltre il turno ----------------


class SoakInsideTheOpeningBandTests(Caccia22Base):
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


class ClientNeverIntoForeignSoakTests(Caccia22Base):
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
