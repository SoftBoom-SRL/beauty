"""Aggiuntivi: servizi che si fanno durante un altro (nail art durante la manicure).

15/10, dall'import di un salone di unghie (4.557 aggiuntivi prenotati in
parallelo al servizio principale): la voce di un aggiuntivo dura 0 minuti,
aggiunge il prezzo ma non il tempo, non occupa slot e si appoggia al servizio
prima di lei. Qui ogni via da cui passa una visita: dashboard, app cliente,
assistente vocale (in integrations), modifica, spostamento, stacco, «torna
indietro», ricerca degli orari, check-in, conto, margine, messaggi a Yourang.
"""

import json
from decimal import Decimal

from django.utils.dateparse import parse_datetime
from ninja.errors import HttpError

from apps.catalog.models import Service
from apps.core.models import OutboxEvent
from common.testing import aware

from ..models import Appointment, WaitlistEntry
from ..services.addons import ADDON_ALONE_MESSAGE, ADDON_FIRST_MESSAGE, ADDON_SPLIT_MESSAGE
from ..services.availability import _min_useful_minutes
from ..services.occupancy import _busy_map
from .base import RealShiftsTestBase, hm


def item(service, operator=None, **extra):
    return {"service_id": service.id, "operator_id": operator.id if operator else None, **extra}


class AddonTestBase(RealShiftsTestBase):
    """Giulia e Marta (9–19) fanno manicure e nail art; lo scrub solo Giulia."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.nail_art = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Nail art", duration_min=15,
            price=Decimal("10.00"), product_cost=Decimal("2.00"), is_addon=True,
        )
        cls.scrub = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Scrub", duration_min=10,
            price=Decimal("8.00"), is_addon=True,
        )
        cls.giulia.services.add(cls.nail_art, cls.scrub)
        cls.marta.services.add(cls.nail_art)

    def setUp(self):
        self.desk = self.staff_auth()

    def create(self, items, hour=10, minute=0, client=None, **extra):
        body = {
            "client_id": (client or self.anna).id, "items": items,
            "start": aware(self.day, hour, minute).isoformat(), **extra,
        }
        return self.post("/api/agenda/appointments", body, self.desk)

    def visit(self, items=None, hour=10):
        """Una visita creata dalla dashboard; di serie manicure con Giulia + nail art."""
        res = self.create(items or [item(self.man60, self.giulia), item(self.nail_art)], hour=hour)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def put_items(self, visit, rows):
        return self.put(f"/api/agenda/appointments/{visit['id']}", {"items": rows}, self.desk)

    def rows(self, appointment_id):
        appointment = Appointment.objects.get(id=appointment_id)
        return [
            (row.service_id, row.duration_min, row.soak_min)
            for row in appointment.items.order_by("order", "id")
        ]


class AddonBookingTests(AddonTestBase):
    def test_the_addon_adds_the_price_not_the_time(self):
        res = self.create([item(self.man60, self.giulia), item(self.nail_art)])
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        nail = body["items"][1]
        self.assertEqual((nail["service_id"], nail["duration_min"], nail["soak_min"]), (self.nail_art.id, 0, 0))
        # lo fa chi fa la manicure
        self.assertEqual(nail["operator_id"], self.giulia.id)
        self.assertEqual(body["total_duration_min"], 60)
        self.assertEqual(parse_datetime(body["end"]), aware(self.day, 11))
        # nel conto la voce c'è, col suo prezzo
        self.assertEqual(Decimal(nail["price"]), Decimal("10.00"))
        self.assertEqual(Decimal(body["total_price"]), Decimal("50.00"))
        self.assertFalse(body["forced"])

    def test_the_addon_goes_to_the_first_who_can_do_it_if_the_service_operator_cannot(self):
        body = self.visit([item(self.man60, self.marta), item(self.scrub)])
        self.assertEqual([i["operator_id"] for i in body["items"]], [self.marta.id, self.giulia.id])

    def test_an_operator_who_cannot_do_the_addon_is_refused(self):
        res = self.create([item(self.man60, self.giulia), item(self.scrub, self.marta)])
        self.assertEqual(res.status_code, 400, res.content)

    def test_an_addon_alone_or_first_is_refused_even_forcing(self):
        for items, message in (
            ([item(self.nail_art)], ADDON_ALONE_MESSAGE),
            ([item(self.nail_art), item(self.scrub)], ADDON_ALONE_MESSAGE),
            ([item(self.nail_art), item(self.man60)], ADDON_FIRST_MESSAGE),
        ):
            res = self.create(items, force=True)
            self.assertEqual(res.status_code, 422, res.content)
            self.assertEqual(res.json()["detail"], message)
        self.assertFalse(Appointment.objects.filter(salon=self.salon).exists())

    def test_the_addon_does_not_keep_anyone_busy(self):
        # Marta fa la nail art di Anna alla fine della manicure con Giulia, alle 11:00…
        self.visit([item(self.man60, self.giulia), item(self.nail_art, self.marta)])
        self.assertNotIn(self.marta.id, _busy_map(self.salon, self.day))
        # …e Bea con Marta dalle 10:30 alle 11:30 non è un incastro da forzare
        res = self.create([item(self.man60, self.marta)], hour=10, minute=30, client=self.bea)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["forced"])

    def test_the_day_view_carries_the_addon_with_zero_minutes(self):
        self.visit()
        res = self.client.get(f"/api/agenda/day?date={self.day.isoformat()}", **self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        row = next(r for r in res.json() if r["operator"]["id"] == self.giulia.id)
        items = row["appointments"][0]["items"]
        self.assertEqual([(i["service_name"], i["duration_min"]) for i in items], [("Manicure", 60), ("Nail art", 0)])

    def test_the_message_to_yourang_lists_the_addon_with_zero_minutes(self):
        self.visit()
        event = OutboxEvent.objects.filter(salon=self.salon, event_type="appointment.created").latest("id")
        services = event.payload["services"]
        self.assertEqual([(s["name"], s["duration_min"]) for s in services], [("Manicure", 60), ("Nail art", 0)])
        self.assertEqual(parse_datetime(event.payload["end"]), aware(self.day, 11))

    def test_check_in_of_a_visit_with_an_addon(self):
        visit = self.visit()
        res = self.client.post(f"/api/agenda/appointments/{visit['id']}/check-in?start=true", **self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["status"], "in_progress")
        self.assertEqual(self.rows(visit["id"]), [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0)])

    def test_the_margin_counts_price_and_product_of_the_addon_but_no_labour(self):
        self.giulia.hourly_cost = Decimal("30.00")
        self.giulia.save(update_fields=["hourly_cost"])
        visit = self.visit()
        res = self.client.get(f"/api/agenda/appointments/{visit['id']}/margin", **self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        margin = res.json()
        self.assertEqual(Decimal(margin["revenue"]), Decimal("50.00"))
        self.assertEqual(Decimal(margin["product_cost"]), Decimal("2.00"))
        # un'ora di manicure; la nail art si fa dentro quell'ora
        self.assertEqual(Decimal(margin["labor_cost"]), Decimal("30.00"))


class AddonClientAppTests(AddonTestBase):
    def test_the_client_books_an_addon_after_its_service(self):
        res = self.post(
            "/api/agenda/client/appointments",
            {"items": [item(self.man60), item(self.nail_art)], "start": aware(self.day, 10).isoformat()},
            self.client_auth(),
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual([s["duration_min"] for s in body["services"]], [60, 0])
        self.assertEqual(parse_datetime(body["end"]), aware(self.day, 11))
        self.assertEqual(Decimal(body["total_price"]), Decimal("50.00"))

    def test_the_client_cannot_book_an_addon_alone(self):
        res = self.post(
            "/api/agenda/client/appointments",
            {"items": [item(self.nail_art)], "start": aware(self.day, 10).isoformat()},
            self.client_auth(),
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], ADDON_ALONE_MESSAGE)

    def test_the_public_search_for_an_addon_alone_says_why(self):
        items = json.dumps([{"service_id": self.nail_art.id}])
        res = self.client.get(
            f"/api/agenda/public/availability?salon={self.salon.slug}&date={self.day.isoformat()}&items={items}"
        )
        self.assertEqual(res.status_code, 422, res.content)

    def test_no_waiting_list_for_an_addon(self):
        res = self.post("/api/agenda/client/waitlist", {"service_id": self.nail_art.id}, self.client_auth())
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(WaitlistEntry.objects.exists())

    def test_the_client_moves_a_visit_with_an_addon(self):
        res = self.post(
            "/api/agenda/client/appointments",
            {"items": [item(self.man60), item(self.nail_art)], "start": aware(self.day, 10).isoformat()},
            self.client_auth(),
        )
        visit = res.json()
        # alle 18: un'ora fino alla chiusura del turno, la nail art non allunga
        res = self.post(
            f"/api/agenda/client/appointments/{visit['id']}/move",
            {"start": aware(self.day, 18).isoformat()}, self.client_auth(),
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.rows(visit["id"]), [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0)])


class AddonSearchTests(AddonTestBase):
    def test_the_search_ignores_the_addon_time(self):
        slots = self.slots([item(self.man60, self.giulia), item(self.nail_art)])
        starts = [hm(s["start"]) for s in slots]
        # un'ora fino alle 19: con i 15' di listino della nail art le 18:00 sparivano
        self.assertIn("18:00", starts)
        self.assertNotIn("18:15", starts)
        self.assertEqual(slots[0]["assignment"][1], {"service_id": self.nail_art.id, "operator_id": self.giulia.id})

    def test_the_search_gives_the_addon_to_whoever_does_the_service_and_the_booking_agrees(self):
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        slots = {hm(s["start"]): s for s in self.slots([item(self.man60), item(self.nail_art)])}
        self.assertEqual([a["operator_id"] for a in slots["10:00"]["assignment"]], [self.marta.id, self.marta.id])
        body = self.visit([item(self.man60), item(self.nail_art)])
        self.assertEqual([i["operator_id"] for i in body["items"]], [self.marta.id, self.marta.id])

    def test_searching_for_an_addon_alone_or_first_says_why(self):
        for items, message in (
            ([item(self.nail_art)], ADDON_ALONE_MESSAGE),
            ([item(self.nail_art), item(self.man60)], ADDON_FIRST_MESSAGE),
        ):
            with self.assertRaises(HttpError) as caught:
                self.slots(items)
            self.assertEqual((caught.exception.status_code, str(caught.exception)), (422, message))

    def test_an_addon_does_not_fill_an_unsellable_gap(self):
        # il taglio (30') è il servizio più corto che si prenota da solo; la
        # nail art da 20' non riempie nessun buco
        Service.objects.filter(id=self.nail_art.id).update(duration_min=20)
        self.assertEqual(_min_useful_minutes(self.salon, 15), 30)

    def test_rescheduling_searches_with_the_addon_at_zero(self):
        visit = self.visit()
        res = self.client.get(
            f"/api/agenda/availability?date={self.day.isoformat()}&exclude_appointment_id={visit['id']}",
            **self.desk,
        )
        self.assertEqual(res.status_code, 200, res.content)
        # con lo 0 letto come «durata mancante» la visita durava di nuovo 75'
        self.assertIn("18:00", [hm(s["start"]) for s in res.json()])


class AddonEditTests(AddonTestBase):
    def test_adding_an_addon_in_the_panel_keeps_the_visit_length(self):
        visit = self.visit([item(self.man60, self.giulia)])
        main = visit["items"][0]
        res = self.put_items(visit, [
            {"id": main["id"], **item(self.man60, self.giulia)},
            # il listino dice 15': la voce nasce comunque senza tempo
            item(self.nail_art, self.giulia, duration_min=15),
        ])
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual([(i["duration_min"], i["soak_min"]) for i in body["items"]], [(60, 0), (0, 0)])
        self.assertEqual(body["total_duration_min"], 60)
        self.assertEqual(Decimal(body["total_price"]), Decimal("50.00"))

    def test_the_addon_stays_at_zero_whatever_duration_arrives(self):
        visit = self.visit()
        main, nail = visit["items"]
        # allungando la manicure dalla griglia si rimanda la lista intera, con lo 0 della nail art
        res = self.put_items(visit, [
            {"id": main["id"], **item(self.man60, self.giulia), "duration_min": 75},
            {"id": nail["id"], **item(self.nail_art, self.giulia), "duration_min": 0, "soak_min": 0},
        ])
        self.assertEqual(res.status_code, 200, res.content)
        visit = res.json()
        self.assertEqual([(i["duration_min"], i["soak_min"]) for i in visit["items"]], [(75, 0), (0, 0)])
        # chiedendole del tempo resta senza
        main, nail = visit["items"]
        res = self.put_items(visit, [
            {"id": main["id"], **item(self.man60, self.giulia)},
            {"id": nail["id"], **item(self.nail_art, self.giulia), "duration_min": 30, "soak_min": 10},
        ])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([(i["duration_min"], i["soak_min"]) for i in res.json()["items"]], [(75, 0), (0, 0)])

    def test_zero_minutes_on_a_normal_service_is_still_refused(self):
        visit = self.visit()
        main, nail = visit["items"]
        res = self.put_items(visit, [
            {"id": main["id"], **item(self.man60, self.giulia), "duration_min": 0},
            {"id": nail["id"], **item(self.nail_art, self.giulia)},
        ])
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(self.rows(visit["id"]), [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0)])

    def test_the_addon_cannot_go_first_nor_stay_alone(self):
        visit = self.visit()
        main, nail = visit["items"]
        main_row = {"id": main["id"], **item(self.man60, self.giulia)}
        nail_row = {"id": nail["id"], **item(self.nail_art, self.giulia)}
        res = self.put_items(visit, [nail_row, main_row])
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], ADDON_FIRST_MESSAGE)
        res = self.put(
            f"/api/agenda/appointments/{visit['id']}", {"items": [nail_row], "force": True}, self.desk
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], ADDON_ALONE_MESSAGE)
        self.assertEqual(self.rows(visit["id"]), [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0)])

    def test_reordering_keeps_the_addon_behind_its_service(self):
        visit = self.visit([item(self.cut30, self.giulia), item(self.man60, self.giulia), item(self.nail_art)])
        cut, man, nail = visit["items"]
        res = self.put_items(visit, [
            {"id": man["id"], **item(self.man60, self.giulia)},
            {"id": nail["id"], **item(self.nail_art, self.giulia)},
            {"id": cut["id"], **item(self.cut30, self.giulia)},
        ])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            self.rows(visit["id"]),
            [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0), (self.cut30.id, 30, 0)],
        )
        self.assertEqual(res.json()["total_duration_min"], 90)

    def test_a_nail_art_booked_with_its_time_keeps_it(self):
        """Prenotata a 15' prima che il salone la segnasse come aggiuntivo: la
        visita non si accorcia da sola alla prima modifica."""
        visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 60, 0), (self.nail_art, 15, 0)])
        man, nail = visit.items.order_by("order")
        res = self.put(f"/api/agenda/appointments/{visit.id}", {"items": [
            {"id": man.id, **item(self.man60, self.giulia), "duration_min": 70},
            {"id": nail.id, **item(self.nail_art, self.giulia), "duration_min": 15},
        ]}, self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.rows(visit.id), [(self.man60.id, 70, 0), (self.nail_art.id, 15, 0)])


class AddonMoveTests(AddonTestBase):
    def test_moving_the_visit_keeps_the_addon_without_time(self):
        visit = self.visit()
        res = self.post(
            f"/api/agenda/appointments/{visit['id']}/move", {"start": aware(self.day, 18).isoformat()}, self.desk
        )
        self.assertEqual(res.status_code, 200, res.content)
        # 18–19 sta nel turno: la nail art non lo allunga, e niente «forzato»
        self.assertFalse(res.json()["forced"])
        self.assertEqual(self.rows(visit["id"]), [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0)])

    def test_the_addon_follows_its_column_to_a_colleague(self):
        visit = self.visit()
        res = self.post(
            f"/api/agenda/appointments/{visit['id']}/move",
            {"start": visit["start"], "operator_id": self.marta.id, "from_operator_id": self.giulia.id},
            self.desk,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([i["operator_id"] for i in res.json()["items"]], [self.marta.id, self.marta.id])

    def test_a_colleague_who_cannot_do_the_addon_cannot_take_the_column(self):
        visit = self.visit([item(self.man60, self.giulia), item(self.scrub)])
        res = self.post(
            f"/api/agenda/appointments/{visit['id']}/move",
            {"start": visit["start"], "operator_id": self.marta.id, "from_operator_id": self.giulia.id},
            self.desk,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_the_addon_instant_inside_another_booking_is_no_conflict(self):
        # Bea con Giulia dalle 10:40; Anna: colore (30' + 20' di posa) e nail
        # art, che cade alle 10:50 se la visita parte alle 10:00
        visit = self.visit([item(self.color30s20, self.giulia), item(self.nail_art)], hour=9)
        self.book(self.bea, self.giulia, aware(self.day, 10, 40), [(self.cut30, 30, 0)])
        res = self.post(
            f"/api/agenda/appointments/{visit['id']}/move", {"start": aware(self.day, 10).isoformat()}, self.desk
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["forced"])


class AddonSplitTests(AddonTestBase):
    def split(self, visit, item_id, hour=15, **extra):
        return self.post(
            f"/api/agenda/appointments/{visit['id']}/split",
            {"item_id": item_id, "start": aware(self.day, hour).isoformat(), **extra}, self.desk,
        )

    def test_detaching_a_service_takes_its_addons_along(self):
        visit = self.visit([item(self.man60, self.giulia), item(self.nail_art), item(self.cut30, self.giulia)])
        man, _nail, _cut = visit["items"]
        res = self.split(visit, man["id"])
        self.assertEqual(res.status_code, 200, res.content)
        original, created = res.json()["original"], res.json()["created"]
        self.assertEqual(
            [(i["service_id"], i["duration_min"]) for i in created["items"]],
            [(self.man60.id, 60), (self.nail_art.id, 0)],
        )
        self.assertEqual(Decimal(created["total_price"]), Decimal("50.00"))
        self.assertEqual([i["service_id"] for i in original["items"]], [self.cut30.id])
        # il taglio resta alle 11, dov'era
        self.assertEqual(parse_datetime(original["start"]), aware(self.day, 11))

    def test_the_wait_left_in_the_middle_goes_on_a_service_with_time(self):
        # 9:00 taglio + nail art, 9:30 manicure + scrub, 10:30 colore: si stacca la manicure
        visit = self.visit([
            item(self.cut30, self.giulia), item(self.nail_art), item(self.man60, self.giulia), item(self.scrub),
            item(self.color30s20, self.giulia),
        ], hour=9)
        res = self.split(visit, visit["items"][2]["id"])
        self.assertEqual(res.status_code, 200, res.content)
        # l'ora della manicure diventa attesa dopo il taglio, non dopo la nail art
        self.assertEqual(
            self.rows(visit["id"]),
            [(self.cut30.id, 30, 60), (self.nail_art.id, 0, 0), (self.color30s20.id, 30, 20)],
        )
        self.assertEqual(
            [(i["service_id"], i["duration_min"]) for i in res.json()["created"]["items"]],
            [(self.man60.id, 60), (self.scrub.id, 0)],
        )
        # il colore resta alle 10:30
        self.assertEqual(Appointment.objects.get(id=visit["id"]).end, aware(self.day, 11, 20))

    def test_an_addon_alone_cannot_be_detached(self):
        visit = self.visit([item(self.man60, self.giulia), item(self.nail_art), item(self.cut30, self.giulia)])
        res = self.split(visit, visit["items"][1]["id"])
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["detail"], ADDON_SPLIT_MESSAGE)
        self.assertEqual(Appointment.objects.filter(salon=self.salon).count(), 1)

    def test_a_service_with_only_its_addons_is_moved_not_detached(self):
        visit = self.visit()
        res = self.split(visit, visit["items"][0]["id"])
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("usa «Sposta»", res.json()["detail"])

    def test_a_colleague_must_be_able_to_do_the_addons_she_receives(self):
        visit = self.visit([item(self.man60, self.giulia), item(self.scrub), item(self.cut30, self.giulia)])
        res = self.split(visit, visit["items"][0]["id"], operator_id=self.marta.id)
        self.assertEqual(res.status_code, 400, res.content)
        res = self.split(visit, visit["items"][0]["id"], operator_id=self.giulia.id)
        self.assertEqual(res.status_code, 200, res.content)


class AddonUndoTests(AddonTestBase):
    def undo(self):
        return self.post("/api/agenda/undo", {}, self.desk)

    def test_undoing_a_booking_with_an_addon(self):
        self.visit()
        self.assertEqual(self.undo().status_code, 200)
        self.assertFalse(Appointment.objects.filter(salon=self.salon).exists())

    def test_undoing_a_split_puts_the_addon_back_in_its_place(self):
        visit = self.visit([item(self.man60, self.giulia), item(self.nail_art), item(self.cut30, self.giulia)])
        res = self.post(
            f"/api/agenda/appointments/{visit['id']}/split",
            {"item_id": visit["items"][0]["id"], "start": aware(self.day, 15).isoformat()}, self.desk,
        )
        self.assertEqual(res.status_code, 200, res.content)
        res = self.undo()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            self.rows(visit["id"]),
            [(self.man60.id, 60, 0), (self.nail_art.id, 0, 0), (self.cut30.id, 30, 0)],
        )
        self.assertEqual(Appointment.objects.get(id=visit["id"]).start, aware(self.day, 10))
        self.assertEqual(Appointment.objects.filter(salon=self.salon).count(), 1)

    def test_undoing_the_addition_of_an_addon(self):
        visit = self.visit([item(self.man60, self.giulia)])
        main = visit["items"][0]
        res = self.put_items(visit, [{"id": main["id"], **item(self.man60, self.giulia)}, item(self.nail_art)])
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.undo().status_code, 200)
        self.assertEqual(self.rows(visit["id"]), [(self.man60.id, 60, 0)])


class AddonWaitlistTests(AddonTestBase):
    def test_who_waits_for_an_addon_gets_no_freed_slot(self):
        """Un'iscrizione di prima che la nail art fosse un aggiuntivo: lo slot
        liberato non le va proposto, da sola non si prenota."""
        legacy = WaitlistEntry.objects.create(salon=self.salon, client=self.bea, service=self.nail_art)
        wanted = WaitlistEntry.objects.create(salon=self.salon, client=self.bea, service=self.man60)
        visit = self.visit()
        res = self.post(f"/api/agenda/appointments/{visit['id']}/cancel", {}, self.desk)
        self.assertEqual(res.status_code, 200, res.content)
        freed = OutboxEvent.objects.filter(salon=self.salon, event_type="slot.freed").latest("id")
        self.assertIn(wanted.id, freed.payload["matching_waitlist"])
        self.assertNotIn(legacy.id, freed.payload["matching_waitlist"])
