"""Disponibilità: gli orari che la ricerca propone e che la conferma poi accetta."""

import datetime as dt
import json
from decimal import Decimal

from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Location, Salon, SalonSettings
from common.testing import aware, client_bearer

from ..models import Appointment, AppointmentService, Pause
from ..services import appointments as S
from ..services.appointments import create_appointment
from ..services.availability import get_free_slots, smart_slots
from .base import AgendaTestBase, RealShiftsTestBase, _aware, hm


class GetFreeSlotsTests(AgendaTestBase):
    def test_shifts_overlap_and_eligibility(self):
        # op1: 9-13. op2 ha un turno più ampio ma NON è idonea al servizio.
        mapping = {self.op1.id: [(9 * 60, 13 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}
        # appuntamento esistente per op1: 10:00-11:00
        existing = Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=self.op1,
            start=_aware(self.day, 10),
        )
        AppointmentService.objects.create(
            appointment=existing,
            service=self.svc60,
            operator=self.op1,
            duration_min=60,
            price=Decimal("50.00"),
        )

        with self._windows(mapping):
            slots = get_free_slots(
                self.salon, self.day, [{"service_id": self.svc60.id, "operator_id": None}]
            )

        starts = [slot["start"] for slot in slots]
        # liberi: 9:00 poi da 11:00 a 12:00 (l'ultimo che finisce entro le 13)
        self.assertIn(_aware(self.day, 9).isoformat(), starts)
        self.assertIn(_aware(self.day, 11).isoformat(), starts)
        self.assertIn(_aware(self.day, 12).isoformat(), starts)
        # 9:15 finirebbe alle 10:15: si sovrappone all'appuntamento esistente
        self.assertNotIn(_aware(self.day, 9, 15).isoformat(), starts)
        self.assertNotIn(_aware(self.day, 10).isoformat(), starts)
        # 12:15 finirebbe alle 13:15: fuori turno
        self.assertNotIn(_aware(self.day, 12, 15).isoformat(), starts)
        self.assertEqual(len(slots), 6)
        # tutte le assegnazioni sono su op1: op2 non è in service.operators
        for slot in slots:
            self.assertEqual(slot["assignment"][0]["operator_id"], self.op1.id)

    def test_requested_operator_not_eligible_returns_no_slots(self):
        mapping = {self.op2.id: [(9 * 60, 18 * 60)]}
        with self._windows(mapping):
            slots = get_free_slots(
                self.salon,
                self.day,
                [{"service_id": self.svc60.id, "operator_id": self.op2.id}],
            )
        self.assertEqual(slots, [])

    def test_multi_service_sequential_chain(self):
        # Finestra stretta 9:00-10:00: due servizi da 30' entrano solo alle 9:00.
        mapping = {self.op1.id: [(9 * 60, 10 * 60)]}
        items = [
            {"service_id": self.svc30.id, "operator_id": None},
            {"service_id": self.svc30.id, "operator_id": None},
        ]
        with self._windows(mapping):
            slots = get_free_slots(self.salon, self.day, items)

        self.assertEqual(len(slots), 1)
        self.assertEqual(slots[0]["start"], _aware(self.day, 9).isoformat())
        self.assertEqual(
            [a["operator_id"] for a in slots[0]["assignment"]],
            [self.op1.id, self.op1.id],
        )

    def test_pause_blocks_slots(self):
        mapping = {self.op1.id: [(9 * 60, 13 * 60)]}
        Pause.objects.create(
            salon=self.salon,
            operator=self.op1,
            start=_aware(self.day, 9),
            duration_min=30,
        )
        with self._windows(mapping):
            slots = get_free_slots(
                self.salon, self.day, [{"service_id": self.svc30.id, "operator_id": None}]
            )
        starts = [slot["start"] for slot in slots]
        self.assertNotIn(_aware(self.day, 9).isoformat(), starts)
        self.assertNotIn(_aware(self.day, 9, 15).isoformat(), starts)
        self.assertIn(_aware(self.day, 9, 30).isoformat(), starts)


class SlotIntervalTests(AgendaTestBase):
    """L'intervallo fasce orarie del salone (SalonSettings.slot_interval_min)
    guida il passo della disponibilità; senza riga impostazioni si usa il
    default globale (AGENDA_SLOT_STEP_MIN = 15)."""

    def test_default_step_is_15_without_settings(self):
        # nessuna SalonSettings: passo di default 15'
        mapping = {self.op1.id: [(9 * 60, 11 * 60)]}
        with self._windows(mapping):
            slots = get_free_slots(
                self.salon, self.day, [{"service_id": self.svc30.id, "operator_id": None}]
            )
        starts = [s["start"] for s in slots]
        self.assertIn(_aware(self.day, 9, 15).isoformat(), starts)

    def test_step_30_offers_half_hour_grid(self):
        SalonSettings.objects.create(salon=self.salon, slot_interval_min=30)
        mapping = {self.op1.id: [(9 * 60, 11 * 60)]}
        with self._windows(mapping):
            slots = get_free_slots(
                self.salon, self.day, [{"service_id": self.svc30.id, "operator_id": None}]
            )
        starts = [s["start"] for s in slots]
        # passo 30': 9:00, 9:30, 10:00, 10:30 (l'ultimo finisce alle 11:00)
        self.assertEqual(
            starts,
            [
                _aware(self.day, 9).isoformat(),
                _aware(self.day, 9, 30).isoformat(),
                _aware(self.day, 10).isoformat(),
                _aware(self.day, 10, 30).isoformat(),
            ],
        )
        self.assertNotIn(_aware(self.day, 9, 15).isoformat(), starts)

    def test_step_20_offers_twenty_minute_grid(self):
        SalonSettings.objects.create(salon=self.salon, slot_interval_min=20)
        mapping = {self.op1.id: [(9 * 60, 10 * 60)]}
        with self._windows(mapping):
            slots = get_free_slots(
                self.salon, self.day, [{"service_id": self.svc30.id, "operator_id": None}]
            )
        starts = [s["start"] for s in slots]
        # passo 20' entro 9:00-10:00 con servizio 30': 9:00 (→9:30), 9:20 (→9:50)
        self.assertEqual(
            starts,
            [_aware(self.day, 9).isoformat(), _aware(self.day, 9, 20).isoformat()],
        )


class PublicAvailabilityApiTests(AgendaTestBase):
    """GET /api/agenda/public/availability: disponibilità pubblica, senza auth."""

    def setUp(self):
        self.service = self.svc60
        self.date_str = self.day.isoformat()

    def test_public_availability_no_auth(self):
        # nessun header di auth
        items = json.dumps([{"service_id": self.service.id}])
        resp = self.client.get(
            f"/api/agenda/public/availability?salon={self.salon.slug}"
            f"&date={self.date_str}&items={items}"
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsInstance(resp.json(), list)

    def test_public_availability_unknown_salon_404(self):
        items = json.dumps([{"service_id": self.service.id}])
        resp = self.client.get(
            f"/api/agenda/public/availability?salon=inesistente"
            f"&date={self.date_str}&items={items}"
        )
        self.assertEqual(resp.status_code, 404, resp.content)


class OpeningHoursAvailabilityTests(AgendaTestBase):
    """Disponibilità con shift_windows reale: gli orari di apertura del salone
    vincolano gli slot anche quando il turno dell'operatrice è più ampio."""

    def _configure(self, week):
        from apps.core.models import Salon

        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"opening_hours_week": week})
        return Salon.objects.get(pk=self.salon.pk)  # istanza fresca: niente settings in cache

    def test_slots_respect_salon_opening_hours(self):
        from apps.staff.models import WeeklyShift

        WeeklyShift.objects.create(
            operator=self.op1, week_index=0, weekday=self.day.weekday(), start_min=8 * 60, end_min=20 * 60
        )
        items = [{"service_id": self.svc60.id, "operator_id": None}]

        salon = self._configure({str(self.day.weekday()): [["10:00", "13:00"]]})
        starts = [s["start"] for s in get_free_slots(salon, self.day, items)]
        self.assertIn(_aware(self.day, 10).isoformat(), starts)
        self.assertIn(_aware(self.day, 12).isoformat(), starts)
        self.assertNotIn(_aware(self.day, 9).isoformat(), starts)
        self.assertNotIn(_aware(self.day, 13).isoformat(), starts)

        salon = self._configure({str(self.day.weekday()): []})  # giorno di chiusura
        self.assertEqual(get_free_slots(salon, self.day, items), [])

        salon = self._configure({})  # orari non configurati: conta solo il turno
        starts = [s["start"] for s in get_free_slots(salon, self.day, items)]
        self.assertIn(_aware(self.day, 8).isoformat(), starts)


class SmartSlotsTests(AgendaTestBase):
    """Disponibilità intelligente: niente orari che lascerebbero buchi invendibili."""

    def test_recommended_flags_and_client_filtering(self):
        from common.auth import create_client_tokens

        from ..services.availability import smart_slots

        SalonSettings.objects.create(salon=self.salon, agenda_fill="max_revenue")
        salon = Salon.objects.get(pk=self.salon.pk)
        # turno 9-13, cliente esistente 10:00-11:00 (svc60); servizio più corto a listino: 30'
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            create_appointment(
                salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            slots = get_free_slots(salon, self.day, [{"service_id": self.svc60.id, "operator_id": None}])
        by_start = {s["start"]: s["recommended"] for s in slots}
        # 9:00 (adiacente al bordo e all'appuntamento): consigliato
        self.assertTrue(by_start[_aware(self.day, 9).isoformat()])
        # 11:00 subito dopo la cliente: consigliato; 12:00 finisce al bordo 13: consigliato
        self.assertTrue(by_start[_aware(self.day, 11).isoformat()])
        self.assertTrue(by_start[_aware(self.day, 12).isoformat()])
        # 11:15 lascia 15' prima → no; 11:30 lascia 30' prima e 30' dopo (vendibili) → sì;
        # 11:45 lascia 15' dopo → no
        self.assertFalse(by_start[_aware(self.day, 11, 15).isoformat()])
        self.assertTrue(by_start[_aware(self.day, 11, 30).isoformat()])
        self.assertFalse(by_start[_aware(self.day, 11, 45).isoformat()])
        # in modalità ottimizzata la cliente vede solo i consigliati…
        smart = smart_slots(salon, slots)
        self.assertTrue(all(s["recommended"] for s in smart))
        self.assertLess(len(smart), len(slots))
        # …e via API lo stesso; la dashboard vede tutto con il flag
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            res = self.client.get(
                "/api/agenda/client/availability",
                {"date": self.day.isoformat(), "items": json.dumps([{"service_id": self.svc60.id}])}, **auth,
            )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.json()), len(smart))
        # modalità libera: tutti gli orari
        SalonSettings.objects.filter(salon=self.salon).update(agenda_fill="free")
        self.assertEqual(len(smart_slots(Salon.objects.get(pk=self.salon.pk), slots)), len(slots))

    def test_falls_back_to_all_when_nothing_is_recommended(self):
        from ..services.availability import smart_slots

        self.assertEqual(smart_slots(self.salon, [{"start": "x", "assignment": [], "recommended": False}]), [{"start": "x", "assignment": [], "recommended": False}])


class BugHuntAgendaTests(AgendaTestBase):
    """Difetti trovati nella ricerca bug del 17/09/2026."""

    def test_the_client_app_cannot_move_an_appointment_into_the_past(self):
        """Prenotare nel passato era già vietato; spostarci un appuntamento no."""
        from ..services.appointments import move_appointment

        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="app",
            )
            past = timezone.now() - dt.timedelta(days=1)
            with self.assertRaises(HttpError) as caught:
                move_appointment(appointment, past, allow_past=False)
            self.assertEqual(caught.exception.status_code, 400)
            # lo staff può ancora sistemare a posteriori
            moved = move_appointment(appointment, past)
            self.assertEqual(moved.start, past)

    def test_an_appointment_that_runs_past_midnight_still_blocks_the_next_day(self):
        from ..services.occupancy import _busy_map

        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 23, 30), via="dashboard", force=True,
            )
        tomorrow = self.day + dt.timedelta(days=1)
        busy = _busy_map(self.salon, tomorrow)
        # la coda 00:00–00:30 di domani deve risultare occupata
        self.assertTrue(
            any(start < 30 and end > 0 for start, end, _hard in busy.get(self.op1.id, [])),
            busy.get(self.op1.id),
        )

    def test_the_items_parameter_is_validated_instead_of_crashing(self):
        from ..api.params import _parse_items_param
        from ..schemas import MAX_ITEMS_PER_REQUEST

        for raw in (
            '[{"service_id": "non-un-numero"}]',
            '[{"service_id": {"nested": 1}}]',
            '[{"service_id": true}]',
            '[{"service_id": -3}]',
            json.dumps([{"service_id": 1}] * (MAX_ITEMS_PER_REQUEST + 1)),
        ):
            with self.assertRaises(HttpError) as caught:
                _parse_items_param(raw)
            self.assertEqual(caught.exception.status_code, 400, raw)
        self.assertEqual(
            _parse_items_param('[{"service_id": 4, "operator_id": 9}]'),
            [{"service_id": 4, "operator_id": 9}],
        )

    def test_a_gift_card_for_someone_else_is_not_shown_as_the_buyers_own(self):
        """Una carta intestata a «Maria» restava di Maria anche senza la sua
        scheda: non deve comparire come regalo di chi l'ha pagata."""
        from apps.marketing.models import GiftCard

        from ..presenters import gift_index

        GiftCard.objects.create(
            salon=self.salon, code="GC-REGALO-01",
            initial_value=Decimal("30.00"), balance=Decimal("30.00"),
            gift_service=self.svc30, buyer_client=self.client_obj,
            recipient_name="Maria Bianchi",
            payment_status=GiftCard.PaymentStatus.PAID,
        )
        self.assertEqual(gift_index(self.salon, [self.client_obj.id]), {})

        # senza destinatario è invece un regalo a sé stessa
        GiftCard.objects.create(
            salon=self.salon, code="GC-PERSE-01",
            initial_value=Decimal("30.00"), balance=Decimal("30.00"),
            gift_service=self.svc30, buyer_client=self.client_obj,
            payment_status=GiftCard.PaymentStatus.PAID,
        )
        self.assertEqual(
            list(gift_index(self.salon, [self.client_obj.id])), [self.client_obj.id]
        )

    def test_an_expired_gift_card_is_not_offered_as_a_bookable_present(self):
        """Lo stato «scaduta» lo scrive solo chi prova a riscattare: in agenda
        la carta compariva ancora fra i regali, e la cassa poi la rifiutava."""
        from apps.marketing.models import GiftCard

        from ..presenters import gift_index

        card = GiftCard.objects.create(
            salon=self.salon, code="GC-SCADUTA-1",
            initial_value=Decimal("30.00"), balance=Decimal("30.00"),
            gift_service=self.svc30, recipient_client=self.client_obj,
            payment_status=GiftCard.PaymentStatus.PAID,
            expires_at=timezone.now() - dt.timedelta(days=1),
        )
        self.assertEqual(gift_index(self.salon, [self.client_obj.id]), {})

        # spostata in avanti la scadenza, torna spendibile
        card.expires_at = timezone.now() + dt.timedelta(days=1)
        card.save(update_fields=["expires_at"])
        self.assertEqual(
            list(gift_index(self.salon, [self.client_obj.id])), [self.client_obj.id]
        )

    def test_a_service_cannot_end_its_soak_after_closing_time(self):
        from apps.catalog.models import Service

        from ..services.resolution import resolve_items

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"opening_hours_week": {
                str(d): [["09:00", "18:00"]] for d in range(7)
            }},
        )
        soaking = Service.objects.create(
            salon=self.salon, category=self.svc30.category, name_it="Colore",
            duration_min=60, soak_min=45, price=Decimal("60.00"),
        )
        self.op1.services.add(soaking)
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            with self.assertRaises(HttpError) as caught:
                resolve_items(
                    self.salon, [{"service_id": soaking.id, "operator_id": self.op1.id}],
                    _aware(self.day, 17),
                )
            self.assertEqual(caught.exception.status_code, 409)
            # lo staff può forzare lo straordinario
            self.assertEqual(
                len(resolve_items(
                    self.salon, [{"service_id": soaking.id, "operator_id": self.op1.id}],
                    _aware(self.day, 17), force=True,
                )),
                1,
            )


class SmartSlotMultiOperatorTests(AgendaTestBase):
    """Il criterio degli orari consigliati deve guardare TUTTE le operatrici
    coinvolte, non solo il primo e l'ultimo servizio della catena."""

    def test_a_split_visit_does_not_recommend_a_time_that_fragments_a_colleagues_day(self):
        from apps.clients.models import Client

        from ..services.availability import _slot_is_recommended

        other = Client.objects.create(
            salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000021"
        )
        self.op2.services.add(self.svc30)
        windows = {self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}
        # op1 è già occupata 11:00–12:00: un servizio che finisce alle 10:50
                # lascerebbe dieci minuti invendibili prima di quell'impegno.
        busy = {self.op1.id: [(11 * 60, 12 * 60, True)], self.op2.id: []}
        chain = [
            (self.op1, 9 * 60 + 50, 10 * 60 + 50),   # op1: buco di 10' prima delle 11:00
            (self.op2, 10 * 60 + 50, 11 * 60 + 20),  # op2: libera tutto il giorno
        ]
        self.assertFalse(_slot_is_recommended(chain, windows, busy, 30))

        # spostata mezz'ora più tardi la catena si appoggia all'impegno di op1
        ok_chain = [
            (self.op1, 10 * 60, 11 * 60),
            (self.op2, 11 * 60, 11 * 60 + 30),
        ]
        self.assertTrue(_slot_is_recommended(ok_chain, windows, busy, 30))
        self.assertIsNotNone(other.id)


class AvailabilityMatchesBookingTests(AgendaTestBase):
    """Quello che la ricerca propone, la conferma deve accettarlo."""

    def setUp(self):
        self.auth = client_bearer(self.client_obj)

    def _slots(self, path, params, **extra):
        response = self.client.get(path, params, **extra)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_public_slots_only_cover_the_location_the_app_books_on(self):
        from apps.core.models import Location

        main = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        other = Location.objects.create(salon=self.salon, name="Distaccata")
        self.op1.location = other
        self.op1.save(update_fields=["location"])

        items = json.dumps([{"service_id": self.svc60.id}])
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            slots = self._slots(
                "/api/agenda/public/availability",
                {"salon": self.salon.slug, "date": self.day.isoformat(), "items": items},
            )
        # L'unica operatrice lavora nell'altra sede: niente da proporre, invece
        # di orari che la prenotazione avrebbe poi rifiutato con un 409.
        self.assertEqual(slots, [])
        self.assertTrue(main.is_default)

    def test_a_slot_offered_for_a_move_is_accepted(self):
        """Durata dalla visita, non dal listino di oggi."""
        start = timezone.make_aware(dt.datetime.combine(self.day, dt.time(10)))
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=start
        )
        AppointmentService.objects.create(
            appointment=appointment,
            service=self.svc30,  # a listino oggi dura 30 minuti…
            operator=self.op1,
            duration_min=60,     # …ma la visita è stata presa da 60
            price=Decimal("30.00"),
            order=0,
        )
        items = json.dumps([{"service_id": self.svc30.id}])
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            slots = self._slots(
                "/api/agenda/client/availability",
                {
                    "date": self.day.isoformat(),
                    "items": items,
                    "exclude_appointment_id": appointment.id,
                },
                **self.auth,
            )
            starts = {s["start"] for s in slots}
            # Le 17:30 non stanno più in piedi: 60 minuti sforano le 18:00.
            late = timezone.make_aware(dt.datetime.combine(self.day, dt.time(17, 30)))
            self.assertNotIn(late.isoformat(), starts)
            self.assertTrue(slots)
            moved = self.client.post(
                f"/api/agenda/client/appointments/{appointment.id}/move",
                json.dumps({"start": slots[-1]["start"]}),
                content_type="application/json",
                **self.auth,
            )
        self.assertEqual(moved.status_code, 200, moved.content)

    def test_a_move_still_works_after_the_service_leaves_the_price_list(self):
        start = timezone.make_aware(dt.datetime.combine(self.day, dt.time(10)))
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=start
        )
        AppointmentService.objects.create(
            appointment=appointment,
            service=self.svc60,
            operator=self.op1,
            duration_min=60,
            price=Decimal("50.00"),
            order=0,
        )
        self.svc60.active = False
        self.svc60.save(update_fields=["active"])
        items = json.dumps([{"service_id": self.svc60.id}])
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            slots = self._slots(
                "/api/agenda/client/availability",
                {
                    "date": self.day.isoformat(),
                    "items": items,
                    "exclude_appointment_id": appointment.id,
                },
                **self.auth,
            )
        self.assertTrue(slots)
        self.svc60.active = True
        self.svc60.save(update_fields=["active"])

    def test_soak_time_after_closing_is_not_offered(self):
        from apps.core.models import SalonSettings

        self.svc30.soak_min = 60
        self.svc30.save(update_fields=["soak_min"])
        SalonSettings.objects.update_or_create(
            salon=self.salon,
            defaults={"opening_hours_week": {str(self.day.weekday()): [["09:00", "18:00"]]}},
        )
        self.salon.refresh_from_db()
        items = json.dumps([{"service_id": self.svc30.id}])
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            slots = self._slots(
                "/api/agenda/public/availability",
                {"salon": self.salon.slug, "date": self.day.isoformat(), "items": items},
            )
            late = timezone.make_aware(dt.datetime.combine(self.day, dt.time(17, 30)))
            self.assertNotIn(late.isoformat(), {s["start"] for s in slots})
            # L'ultimo orario proposto regge la conferma: lavoro più posa
            # stanno dentro la chiusura.
            booked = self.client.post(
                "/api/agenda/client/appointments",
                json.dumps({"start": slots[-1]["start"], "items": [{"service_id": self.svc30.id}]}),
                content_type="application/json",
                **self.auth,
            )
        self.assertEqual(booked.status_code, 200, booked.content)
        self.svc30.soak_min = 0
        self.svc30.save(update_fields=["soak_min"])


class MidnightPauseTests(AgendaTestBase):
    """Una pausa lunga a cavallo di mezzanotte occupa anche il giorno dopo."""

    def test_a_pause_running_past_midnight_blocks_the_next_morning(self):
        Pause.objects.create(
            salon=self.salon,
            operator=self.op1,
            start=_aware(self.day, 23),
            duration_min=10 * 60,  # 23:00 -> 09:00 del giorno dopo
        )
        next_day = self.day + dt.timedelta(days=1)
        with self._windows({self.op1.id: [(8 * 60, 18 * 60)]}):
            slots = get_free_slots(
                self.salon, next_day,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            )
        starts = {timezone.localtime(dt.datetime.fromisoformat(s["start"])).hour for s in slots}
        self.assertNotIn(8, starts)   # coperte dalla pausa di ieri sera
        self.assertIn(9, starts)      # appena finita, si riparte


class DaylightSavingTests(AgendaTestBase):
    """L'ora che non esiste non si prenota."""

    def test_the_hour_skipped_by_dst_is_never_offered(self):
        # Ultima domenica di marzo 2027: alle 02:00 gli orologi saltano alle 03:00.
        day = dt.date(2027, 3, 28)
        with self._windows({self.op1.id: [(0, 6 * 60)]}):
            slots = get_free_slots(
                self.salon, day,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            )
        offered = [dt.datetime.fromisoformat(s["start"]) for s in slots]
        self.assertTrue(offered)
        # L'etichetta che parte (02:30+01:00) non è l'ora che la cliente leggerà
        # sul telefono (03:30): quell'orario semplicemente non esiste e non va
        # proposto. Prima ne uscivano quattro, tutti con l'ora sbagliata.
        self.assertNotIn(2, {s.hour for s in offered})
        self.assertIn(1, {s.hour for s in offered})
        for start in offered:
            self.assertEqual(
                start.hour,
                timezone.localtime(start).hour,
                f"{start.isoformat()} non corrisponde all'ora locale",
            )


class RealShiftWindowsTests(AgendaTestBase):
    """Senza mock: turni e assenze veri arrivano fino all'agenda."""

    def setUp(self):
        from apps.staff.models import WeeklyShift

        WeeklyShift.objects.create(
            operator=self.op1, week_index=0, weekday=self.day.weekday(),
            start_min=9 * 60, end_min=13 * 60,
        )

    def _starts(self):
        slots = get_free_slots(
            self.salon, self.day, [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        return [timezone.localtime(dt.datetime.fromisoformat(s["start"])).hour for s in slots]

    def test_the_shift_bounds_the_day(self):
        hours = self._starts()
        self.assertEqual(min(hours), 9)
        self.assertEqual(max(hours), 12)  # 12:00-13:00 è l'ultimo che ci sta

    def test_an_absence_empties_the_day(self):
        from apps.staff.models import Absence

        Absence.objects.create(
            operator=self.op1, date_from=self.day, date_to=self.day, type="vacation"
        )
        self.assertEqual(self._starts(), [])

    def test_booking_on_a_day_off_is_refused(self):
        from apps.staff.models import Absence

        Absence.objects.create(
            operator=self.op1, date_from=self.day, date_to=self.day, type="vacation"
        )
        with self.assertRaises(HttpError) as caught:
            create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
        self.assertEqual(caught.exception.status_code, 409)


class PublicAvailabilityContentTests(AgendaTestBase):
    """La disponibilità pubblica restituisce orari veri, non una lista vuota."""

    def test_public_availability_returns_the_real_free_times(self):
        from apps.staff.models import WeeklyShift

        WeeklyShift.objects.create(
            operator=self.op1, week_index=0, weekday=self.day.weekday(),
            start_min=9 * 60, end_min=12 * 60,
        )
        items = json.dumps([{"service_id": self.svc60.id}])
        res = self.client.get(
            f"/api/agenda/public/availability?salon={self.salon.slug}"
            f"&date={self.day.isoformat()}&items={items}"
        )
        self.assertEqual(res.status_code, 200, res.content)
        slots = res.json()
        starts = [timezone.localtime(dt.datetime.fromisoformat(s["start"])) for s in slots]
        self.assertEqual(starts[0].hour, 9)
        self.assertEqual(starts[-1].hour, 11)  # 11:00-12:00, l'ultimo che ci sta
        self.assertTrue(
            all(a["operator_id"] == self.op1.id for s in slots for a in s["assignment"])
        )


# ---- 01-01 + 13-12: forzando, «Prima disponibile» va a chi è libera ----------


class ForcedFirstAvailableTests(RealShiftsTestBase):
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


class SameClientAssignmentTests(RealShiftsTestBase):
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


class NewBookingUnbookableOperatorTests(RealShiftsTestBase):
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


# ---- 01-04: «Consigliati» e la posa ------------------------------------------


class RecommendedWithSoakTests(RealShiftsTestBase):
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
        self.assertIn("09:45", [hm(s["start"]) for s in smart_slots(self.salon, slots)])

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
