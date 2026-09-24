"""Viste dell'agenda (giorno, settimana, intervallo, dettaglio): colonne, permessi, regali."""

import datetime as dt
from decimal import Decimal

from django.utils import timezone

from apps.core.models import Location
from common.auth import create_staff_tokens
from common.testing import aware, bearer

from ..models import AppointmentService, Pause
from ..services import deposits as S
from ..services.appointments import create_appointment
from .base import AgendaTestBase, RealShiftsTestBase, _aware


class AgendaDayLocationTests(AgendaTestBase):
    """Con il filtro sede, gli appuntamenti senza sede (app, import) restano visibili."""

    def test_day_view_with_location_keeps_unassigned_appointments(self):
        from apps.accounts.models import Membership, Role, User
        from apps.core.models import Location

        user = User.objects.create_user(email="front@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")

        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            in_centro = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 9), via="dashboard", location=centro,
            )
            no_location = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 11), via="app",
            )
            in_nord = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 14), via="dashboard", location=nord,
            )
            res = self.client.get(
                "/api/agenda/day", {"date": self.day.isoformat(), "location_id": centro.id}, **auth
            )
        self.assertEqual(res.status_code, 200, res.content)
        ids = {a["id"] for row in res.json() for a in row["appointments"]}
        self.assertEqual(ids, {in_centro.id, no_location.id})
        self.assertNotIn(in_nord.id, ids)


class RangeAndGiftTests(AgendaTestBase):
    def _staff(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="range@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return bearer(user, self.salon)

    def test_range_reports_capacity_booking_and_revenue(self):
        from apps.staff.models import WeeklyShift

        auth = self._staff()
        WeeklyShift.objects.create(operator=self.op1, week_index=0, weekday=self.day.weekday(), start_min=9 * 60, end_min=17 * 60)
        appointment = create_appointment(
            self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard",
        )
        res = self.client.get("/api/agenda/range", {"start": self.day.isoformat(), "end": (self.day + dt.timedelta(days=2)).isoformat()}, **auth)
        self.assertEqual(res.status_code, 200, res.content)
        days = res.json()
        self.assertEqual(len(days), 3)
        first = days[0]
        self.assertEqual(first["count"], 1)
        self.assertEqual(first["capacity_min"], 8 * 60)
        self.assertEqual(first["booked_min"], 60)
        self.assertEqual(Decimal(first["revenue"]), Decimal("50.00"))
        self.assertEqual(first["appointments"][0]["id"], appointment.id)
        self.assertEqual(first["appointments"][0]["services"], ["Manicure completa"])
        op_row = next(o for o in first["operators"] if o["operator_id"] == self.op1.id)
        self.assertEqual(op_row["booked_min"], 60)
        res = self.client.get("/api/agenda/range", {"start": self.day.isoformat(), "end": (self.day + dt.timedelta(days=60)).isoformat()}, **auth)
        self.assertEqual(res.status_code, 400)

    def test_gift_card_for_a_service_shows_on_the_appointment(self):
        from apps.marketing.services import create_gift_card

        auth = self._staff()
        card = create_gift_card(self.salon, Decimal("50.00"), gift_service=self.svc60, paid=True, paid_method="cash")
        card.recipient_client = self.client_obj
        card.save(update_fields=["recipient_client"])
        unpaid = create_gift_card(self.salon, Decimal("30.00"), gift_service=self.svc30)  # non pagata: non conta
        unpaid.recipient_client = self.client_obj
        unpaid.save(update_fields=["recipient_client"])
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}, {"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            res = self.client.get("/api/agenda/day", {"date": self.day.isoformat()}, **auth)
        self.assertEqual(res.status_code, 200, res.content)
        out = next(a for row in res.json() for a in row["appointments"] if a["id"] == appointment.id)
        self.assertEqual([g["gift_card_id"] for g in out["gifts"]], [card.id])
        # ruolo con la sola agenda: del codice (denaro al portatore) solo le ultime cifre
        self.assertNotEqual(out["gifts"][0]["code"], card.code)
        self.assertTrue(out["gifts"][0]["code"].endswith(card.code[-4:]))
        self.assertEqual(out["gifts"][0]["service_id"], self.svc60.id)
        detail = self.client.get(f"/api/agenda/appointments/{appointment.id}", **auth).json()
        self.assertEqual(len(detail["gifts"]), 1)


class ReadEndpointsTests(AgendaTestBase):
    """Permessi e limiti delle rotte di lettura dell'agenda."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="mag@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Magazzino", scopes=["inventory"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = bearer(self.user, self.salon)

    def test_reading_the_agenda_needs_the_agenda_permission(self):
        # Tutti i ruoli predefiniti (Manager, Front desk, Operatrice) hanno
        # «agenda»: qui il ruolo è di solo magazzino e non deve vedere né
        # l'agenda né i margini di una visita.
        for path, params in (
            ("/api/agenda/day", {"date": self.day.isoformat()}),
            ("/api/agenda/week", {"start": self.day.isoformat()}),
            ("/api/agenda/range", {"start": self.day.isoformat(), "end": self.day.isoformat()}),
            ("/api/agenda/pauses", {}),
        ):
            res = self.client.get(path, params, **self.auth)
            self.assertEqual(res.status_code, 403, f"{path}: {res.content}")

    def test_the_week_view_carries_the_note_for_the_hover_card(self):
        from apps.accounts.models import Membership

        Membership.objects.filter(user=self.user).update(is_owner=True)
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard", note="allergia alla tinta",
            )
        week = self.client.get(
            "/api/agenda/week", {"start": self.day.isoformat()}, **self.auth
        ).json()
        booked = [a for row in week for a in row["appointments"]]
        self.assertEqual([a["note"] for a in booked], ["allergia alla tinta"])

    def test_the_month_view_stops_at_six_weeks(self):
        from apps.accounts.models import Membership

        Membership.objects.filter(user=self.user).update(is_owner=True)
        first = self.day
        ok = self.client.get(
            "/api/agenda/range",
            {"start": first.isoformat(), "end": (first + dt.timedelta(days=41)).isoformat()},
            **self.auth,
        )
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(len(ok.json()), 42)
        too_long = self.client.get(
            "/api/agenda/range",
            {"start": first.isoformat(), "end": (first + dt.timedelta(days=42)).isoformat()},
            **self.auth,
        )
        self.assertEqual(too_long.status_code, 400, too_long.content)

    def test_pauses_without_a_date_are_only_todays(self):
        from apps.accounts.models import Membership

        Membership.objects.filter(user=self.user).update(is_owner=True)
        today = Pause.objects.create(
            salon=self.salon, operator=self.op1,
            start=timezone.now().replace(hour=12, minute=0, second=0, microsecond=0),
            duration_min=30,
        )
        Pause.objects.create(
            salon=self.salon, operator=self.op1, start=_aware(self.day, 12), duration_min=30
        )
        res = self.client.get("/api/agenda/pauses", **self.auth)
        self.assertEqual([p["id"] for p in res.json()], [today.id])

    def test_the_margin_is_revenue_minus_costs(self):
        from apps.accounts.models import Membership

        Membership.objects.filter(user=self.user).update(is_owner=True)
        self.svc60.supplier_cost = Decimal("4.00")
        self.svc60.product_cost = Decimal("6.00")
        self.svc60.save(update_fields=["supplier_cost", "product_cost"])
        self.op1.hourly_cost = Decimal("20.00")
        self.op1.save(update_fields=["hourly_cost"])
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
        body = self.client.get(
            f"/api/agenda/appointments/{appointment.id}/margin", **self.auth
        ).json()
        # 50 di ricavo, 4 + 6 di costi, un'ora di manodopera a 20
        self.assertEqual(body["revenue"], "50.00")
        self.assertEqual(body["labor_cost"], "20.00")
        self.assertEqual(body["margin"], "20.00")
        self.assertEqual(body["margin_pct"], "40.0")
        self.svc60.supplier_cost = Decimal("0.00")
        self.svc60.product_cost = Decimal("0.00")
        self.svc60.save(update_fields=["supplier_cost", "product_cost"])


# ---- 04-02 + 04-07: colonne della vista giorno --------------------------------


class DayColumnsTests(RealShiftsTestBase):
    def _columns(self, **params):
        res = self.client.get("/api/agenda/day", {"date": self.day.isoformat(), **params}, **self.staff_auth())
        self.assertEqual(res.status_code, 200, res.content)
        return {row["operator"]["id"]: row for row in res.json()}

    def test_secondary_service_of_a_deactivated_operator_has_a_column(self):
        laura = self.operator("Laura", order=5)
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0), (self.color30s20, 30, 20, laura)])
        laura.active = False
        laura.save(update_fields=["active"])
        columns = self._columns()
        self.assertIn(laura.id, columns)
        self.assertTrue(columns[laura.id]["operator"]["inactive"])
        # la visita resta una sola, nella riga della principale
        self.assertEqual(len(columns[self.giulia.id]["appointments"]), 1)
        self.assertEqual(columns[laura.id]["appointments"], [])

    def test_secondary_service_of_another_location_has_a_column_with_the_filter(self):
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")
        lia = self.operator("Lia", location=nord, order=5)
        visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0), (self.cut30, 30, 0, lia)])
        visit.location = centro
        visit.save(update_fields=["location"])
        columns = self._columns(location_id=centro.id)
        self.assertIn(lia.id, columns)
        self.assertFalse(columns[lia.id]["operator"]["inactive"])

    def test_a_pause_of_another_location_opens_no_column(self):
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")
        lia = self.operator("Lia", location=nord, order=5)
        Pause.objects.create(salon=self.salon, operator=lia, start=aware(self.day, 13), duration_min=60)
        self.assertNotIn(lia.id, self._columns(location_id=centro.id))
        # senza filtro Lia è una colonna come le altre, con la sua pausa
        self.assertEqual(len(self._columns()[lia.id]["pauses"]), 1)

    def test_a_pause_of_a_deactivated_operator_of_the_location_still_shows(self):
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        laura = self.operator("Laura", location=centro, order=5)
        Pause.objects.create(salon=self.salon, operator=laura, start=aware(self.day, 13), duration_min=60)
        laura.active = False
        laura.save(update_fields=["active"])
        columns = self._columns(location_id=centro.id)
        self.assertIn(laura.id, columns)
        self.assertTrue(columns[laura.id]["operator"]["inactive"])


# ---- 10-06 / C21: codici delle gift card in agenda -----------------------------


class GiftCodesInTheAgendaTests(RealShiftsTestBase):
    def setUp(self):
        from apps.marketing.models import GiftCard

        self.card = GiftCard.objects.create(
            salon=self.salon, code="REGALO123456", initial_value=Decimal("30.00"), balance=Decimal("30.00"),
            gift_service=self.cut30, recipient_client=self.anna, payment_status="paid", status="active",
        )
        self.visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])

    def _codes(self, auth):
        monday = self.day - dt.timedelta(days=self.day.weekday())
        day = self.client.get("/api/agenda/day", {"date": self.day.isoformat()}, **auth).json()
        week = self.client.get("/api/agenda/week", {"start": monday.isoformat()}, **auth).json()
        rng = self.client.get(
            "/api/agenda/range", {"start": self.day.isoformat(), "end": self.day.isoformat()}, **auth,
        ).json()
        detail = self.client.get(f"/api/agenda/appointments/{self.visit.id}", **auth).json()
        return {
            "day": next(a for row in day for a in row["appointments"])["gifts"][0]["code"],
            "week": next(a for d in week for a in d["appointments"])["gifts"][0]["code"],
            "range": rng[0]["appointments"][0]["gifts"][0]["code"],
            "detail": detail["gifts"][0]["code"],
        }

    def test_the_agenda_alone_sees_only_the_last_digits(self):
        codes = self._codes(self.staff_auth(("agenda",)))
        for where, code in codes.items():
            self.assertNotEqual(code, self.card.code, where)
            self.assertTrue(code.endswith("3456"), (where, code))

    def test_the_cash_desk_and_the_owner_see_the_whole_code(self):
        cash = self._codes(self.staff_auth(("agenda", "sales"), email="cassa@caccia22.it"))
        self.assertEqual(set(cash.values()), {self.card.code})
        owner = self._codes(self.staff_auth(("agenda",), email="titolare@caccia22.it", owner=True))
        self.assertEqual(set(owner.values()), {self.card.code})

    def test_the_client_sees_her_own_code(self):
        from ..api import _client_appointment_out, gift_index

        out = _client_appointment_out(self.visit, gift_index(self.salon, [self.anna.id]))
        self.assertEqual(out["gifts"][0]["code"], self.card.code)
        self.assertTrue(AppointmentService.objects.filter(appointment=self.visit).exists())
        self.assertIsNotNone(S.spendable_gift_cards(self.salon, [self.anna.id]).first())


# ---- «In regalo da…» solo per i regali veri ------------------------------------


class GiftFromNameTests(RealShiftsTestBase):
    """Una carta comprata per sé mostrava alla cliente «In regalo da» sé stessa."""

    def test_only_a_card_bought_by_someone_else_is_a_gift(self):
        from apps.marketing.services import create_gift_card

        from ..api import _appointment_out

        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        own = create_gift_card(self.salon, Decimal("30.00"), gift_service=self.cut30,
                               buyer_client=self.anna, paid=True, paid_method="cash")
        gift = create_gift_card(self.salon, Decimal("30.00"), gift_service=self.cut30,
                                buyer_client=self.bea, recipient_client=self.anna,
                                paid=True, paid_method="cash")
        names = {g["gift_card_id"]: g["from_name"] for g in _appointment_out(appt)["gifts"]}
        self.assertEqual(names, {own.id: "", gift.id: self.bea.full_name})
