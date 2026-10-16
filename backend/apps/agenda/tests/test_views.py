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
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
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
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
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
        from apps.marketing.gift_cards import create_gift_card

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
        # Mezzogiorno di oggi nel fuso del salone: `timezone.now()` è in UTC, e
        # fra mezzanotte e le 2 la sua data è ancora quella di ieri.
        today = Pause.objects.create(
            salon=self.salon, operator=self.op1,
            start=timezone.localtime().replace(hour=12, minute=0, second=0, microsecond=0),
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
        from ..presenters import _client_appointment_out, gift_index

        out = _client_appointment_out(self.visit, gift_index(self.salon, [self.anna.id]))
        self.assertEqual(out["gifts"][0]["code"], self.card.code)
        self.assertTrue(AppointmentService.objects.filter(appointment=self.visit).exists())
        self.assertIsNotNone(S.spendable_gift_cards(self.salon, [self.anna.id]).first())


# ---- Trattamenti già pagati: regalo, pagato in anticipo, pacchetto -----------------


class PaidTreatmentsOnTheVisitTests(RealShiftsTestBase):
    """`appt.gifts` dice che cosa copre il servizio e quante sedute restano.

    Le chiavi di prima restano identiche (la cassa precompila i pagamenti con
    quelle); `kind`, sedute, valore di una seduta e pacchetto si aggiungono.
    """

    LEGACY_KEYS = {"gift_card_id", "code", "service_id", "service_name", "balance", "from_name"}

    def setUp(self):
        from apps.catalog.models import Package, PackageItem

        self.package = Package.objects.create(
            salon=self.salon, name="Tagli dell'anno", price=Decimal("100.00"), validity_days=365,
        )
        PackageItem.objects.create(package=self.package, service=self.cut30, qty=4)
        self.visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.auth = self.staff_auth(("agenda", "sales"))

    def _sessions(self, amount):
        from apps.marketing.credits import create_package_credits

        [card] = create_package_credits(self.salon, package=self.package, client=self.anna, amount=amount)
        return card

    def _gifts(self):
        """I regali della visita nella vista giorno e nel dettaglio (devono coincidere)."""
        day = self.client.get("/api/agenda/day", {"date": self.day.isoformat()}, **self.auth).json()
        in_day = next(a for row in day for a in row["appointments"] if a["id"] == self.visit.id)["gifts"]
        detail = self.client.get(f"/api/agenda/appointments/{self.visit.id}", **self.auth).json()["gifts"]
        self.assertEqual(
            [{k: str(v) for k, v in g.items()} for g in in_day],
            [{k: str(v) for k, v in g.items()} for g in detail],
        )
        return detail

    def test_package_sessions_say_what_they_are(self):
        card = self._sessions(Decimal("100.00"))
        [gift] = self._gifts()
        self.assertLessEqual(self.LEGACY_KEYS, set(gift))
        self.assertEqual((gift["gift_card_id"], gift["service_id"]), (card.id, self.cut30.id))
        self.assertEqual((gift["kind"], gift["sessions_total"], gift["sessions_left"]), ("package", 4, 4))
        self.assertEqual(Decimal(gift["session_value"]), Decimal("25.00"))
        self.assertEqual(gift["package_name"], "Tagli dell'anno")
        # le sedute le ha pagate lei: non è un regalo di nessuno
        self.assertEqual(gift["from_name"], "")
        self.assertIsNotNone(gift["expires_at"])

    def test_a_treatment_paid_in_advance_is_not_a_gift(self):
        from apps.marketing.gift_cards import create_gift_card
        from apps.marketing.models import GiftCard

        create_gift_card(
            self.salon, Decimal("60.00"), gift_service=self.cut30, buyer_client=self.anna,
            recipient_client=self.anna, paid=True, paid_method="cash",
            kind=GiftCard.Kind.PREPAID, sessions=2,
        )
        [gift] = self._gifts()
        self.assertEqual((gift["kind"], gift["from_name"], gift["package_name"]), ("prepaid", "", ""))
        self.assertEqual((gift["sessions_total"], Decimal(gift["session_value"])), (2, Decimal("30.00")))

    def test_a_free_package_still_covers_the_visit(self):
        self._sessions(Decimal("0"))
        [gift] = self._gifts()
        self.assertEqual((Decimal(gift["balance"]), gift["sessions_left"]), (Decimal("0.00"), 4))

    def test_used_up_sessions_no_longer_cover_it(self):
        from apps.marketing.gift_cards import redeem_gift_card

        card = self._sessions(Decimal("100.00"))
        redeem_gift_card(self.salon, card.code, Decimal("100.00"), sessions=4)
        self.assertEqual(self._gifts(), [])


# ---- «In regalo da…» solo per i regali veri ------------------------------------


class GiftFromNameTests(RealShiftsTestBase):
    """Una carta comprata per sé mostrava alla cliente «In regalo da» sé stessa."""

    def test_only_a_card_bought_by_someone_else_is_a_gift(self):
        from apps.marketing.gift_cards import create_gift_card

        from ..presenters import _appointment_out

        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        own = create_gift_card(self.salon, Decimal("30.00"), gift_service=self.cut30,
                               buyer_client=self.anna, paid=True, paid_method="cash")
        gift = create_gift_card(self.salon, Decimal("30.00"), gift_service=self.cut30,
                                buyer_client=self.bea, recipient_client=self.anna,
                                paid=True, paid_method="cash")
        names = {g["gift_card_id"]: g["from_name"] for g in _appointment_out(appt)["gifts"]}
        self.assertEqual(names, {own.id: "", gift.id: self.bea.full_name})


# ---- 16/10: i turni in vista settimana -------------------------------------------


class WeekShiftsTests(RealShiftsTestBase):
    """`shifts` di /agenda/week: le finestre di turno di ogni operatrice, giorno
    per giorno, e l'assenza. Prima la settimana tratteggiava solo gli orari del
    centro: non si vedeva chi lavorava quel giorno."""

    def _week(self, **params):
        monday = self.day - dt.timedelta(days=self.day.weekday())
        res = self.client.get(
            "/api/agenda/week", {"start": monday.isoformat(), **params}, **self.staff_auth()
        )
        self.assertEqual(res.status_code, 200, res.content)
        return {d["date"]: {s["operator_id"]: s for s in d["shifts"]} for d in res.json()}

    def test_every_day_has_the_shift_and_the_absence_of_each_operator(self):
        from apps.staff.models import Absence, WeeklyShift

        monday = self.day - dt.timedelta(days=self.day.weekday())
        tuesday, wednesday = monday + dt.timedelta(days=1), monday + dt.timedelta(days=2)
        # Marta: il martedì pomeriggio, riposo gli altri giorni; il mercoledì in ferie
        WeeklyShift.objects.filter(operator=self.marta).exclude(weekday=1).delete()
        WeeklyShift.objects.filter(operator=self.marta).update(start_min=14 * 60)
        Absence.objects.create(operator=self.marta, date_from=wednesday, date_to=wednesday, type=Absence.Type.VACATION)
        Absence.objects.create(operator=self.giulia, date_from=wednesday, date_to=wednesday, type=Absence.Type.HOLIDAY)
        week = self._week()
        self.assertEqual(len(week), 7)
        self.assertEqual(
            week[tuesday.isoformat()][self.giulia.id],
            {"operator_id": self.giulia.id, "windows": [["09:00", "19:00"]], "absence": None, "out_of_team": None},
        )
        self.assertEqual(week[tuesday.isoformat()][self.marta.id]["windows"], [["14:00", "19:00"]])
        # riposo: niente turno, nessuna assenza
        self.assertEqual(week[monday.isoformat()][self.marta.id], {"operator_id": self.marta.id, "windows": [], "absence": None, "out_of_team": None})
        # assenti: niente turno, col tipo d'assenza (anche chi quel giorno avrebbe lavorato)
        self.assertEqual(week[wednesday.isoformat()][self.marta.id]["absence"], "vacation")
        self.assertEqual(week[wednesday.isoformat()][self.giulia.id], {"operator_id": self.giulia.id, "windows": [], "absence": "holiday", "out_of_team": None})

    def test_shifts_follow_the_location_and_include_whoever_has_a_service(self):
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")
        lia = self.operator("Lia", location=nord)
        sara = self.operator("Sara", location=nord)
        # Lia (sede Nord) fa la piega dentro una visita del Centro: la colonna c'è, col suo turno
        visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0), (self.man60, 60, 0, lia)])
        visit.location = centro
        visit.save(update_fields=["location"])
        today = self._week(location_id=centro.id)[self.day.isoformat()]
        self.assertEqual(set(today), {self.giulia.id, self.marta.id, lia.id})
        self.assertNotIn(sara.id, today)
        self.assertEqual(today[lia.id]["windows"], [["09:00", "19:00"]])

    def test_whoever_is_off_the_list_comes_with_the_name(self):
        """La colonna di una disattivata in settimana diceva «Non più in team»:
        la dashboard elenca solo le attive. Ora il giorno porta il nome."""
        nord = Location.objects.create(salon=self.salon, name="Nord")
        lia = self.operator("Lia", location=nord)
        self.book(self.anna, self.marta, aware(self.day, 10), [(self.cut30, 30, 0), (self.man60, 60, 0, lia)])
        self.marta.active = False
        self.marta.save(update_fields=["active"])
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        monday = self.day - dt.timedelta(days=self.day.weekday())
        res = self.client.get(
            "/api/agenda/week", {"start": monday.isoformat(), "location_id": centro.id}, **self.staff_auth()
        )
        days = {d["date"]: d for d in res.json()}
        extra = {o["id"]: o for o in days[self.day.isoformat()]["extra_operators"]}
        self.assertEqual(
            extra[self.marta.id],
            {"id": self.marta.id, "first_name": self.marta.first_name, "last_name": self.marta.last_name, "inactive": True},
        )
        # Lia è attiva ma di un'altra sede: anche lei col nome, non disattivata
        self.assertFalse(extra[lia.id]["inactive"])
        self.assertNotIn(self.giulia.id, extra)
        # solo nel giorno in cui ha qualcosa
        other = (monday if self.day != monday else monday + dt.timedelta(days=1)).isoformat()
        self.assertEqual(days[other]["extra_operators"], [])

    def test_days_outside_the_employment_period_say_so(self):
        """16/10: prima dell'arrivo la colonna diceva «Riposo»; ora si sa che
        non era ancora nel team (e il giorno non ha il suo turno)."""
        before = self.day - dt.timedelta(days=self.day.weekday())   # il lunedì della settimana
        self.marta.employed_from = before + dt.timedelta(days=1)
        self.marta.save(update_fields=["employed_from"])
        week = self._week()
        self.assertEqual(week[before.isoformat()][self.marta.id]["out_of_team"], "before")
        self.assertEqual(week[before.isoformat()][self.marta.id]["windows"], [])
        tuesday = (before + dt.timedelta(days=1)).isoformat()
        self.assertIsNone(week[tuesday][self.marta.id]["out_of_team"])
        self.assertTrue(week[tuesday][self.marta.id]["windows"])
        rows = self.client.get("/api/agenda/day", {"date": before.isoformat()}, **self.staff_auth()).json()
        row = next(r for r in rows if r["operator"]["id"] == self.marta.id)
        self.assertEqual((row["out_of_team"], row["windows"]), ("before", []))

    def test_the_shifts_do_not_cost_a_query_per_operator(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        auth = self.staff_auth()
        monday = (self.day - dt.timedelta(days=self.day.weekday())).isoformat()
        with CaptureQueriesContext(connection) as two:
            self.client.get("/api/agenda/week", {"start": monday}, **auth)
        for name in ("Lia", "Sara", "Vera"):
            self.operator(name)
        with CaptureQueriesContext(connection) as five:
            res = self.client.get("/api/agenda/week", {"start": monday}, **auth)
        self.assertEqual(len(res.json()[0]["shifts"]), 5)
        self.assertEqual(len(five.captured_queries), len(two.captured_queries))


# ---- 16/10: i soldi di un giorno, sulla testata in vista settimana ---------------


class DayMoneyTests(RealShiftsTestBase):
    """GET /agenda/day-money: valore atteso, già fatto, entrato in cassa e da
    incassare. La testata del giorno aveva una cifra sola, e non si capiva se
    fosse il venduto, l'incassato o il previsto."""

    def _day(self):
        from apps.agenda.models import Appointment
        from apps.sales.models import Payment, Sale

        # Anna: taglio + manicure (70), conclusa; ha pagato 50, 20 restano da saldare
        anna = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0), (self.man60, 60, 0)])
        anna.status = Appointment.Status.CLOSED
        anna.save(update_fields=["status"])
        sale = Sale.objects.create(salon=self.salon, kind=Sale.Kind.CHECKOUT, appointment=anna, client=self.anna, total=Decimal("70.00"), amount_due=Decimal("20.00"))
        Payment.objects.create(sale=sale, method=Payment.Method.CASH, amount=Decimal("50.00"), created_at=aware(self.day, 11))
        # Bea: colore (50) da fare, con 15 di caparra già in cassa
        bea = self.book(self.bea, self.marta, aware(self.day, 15), [(self.color30s20, 30, 20)])
        bea.deposit_status, bea.deposit_amount = "paid", Decimal("15.00")
        bea.save(update_fields=["deposit_status", "deposit_amount"])
        # non contano: il no-show e l'annullata
        for status in (Appointment.Status.NO_SHOW, Appointment.Status.CANCELLED):
            gone = self.book(self.bea, self.giulia, aware(self.day, 17), [(self.cut30, 30, 0)])
            gone.status = status
            gone.save(update_fields=["status"])
        # al banco, un prodotto pagato con la carta: è cassa, non agenda
        pos = Sale.objects.create(salon=self.salon, kind=Sale.Kind.POS, total=Decimal("25.00"))
        Payment.objects.create(sale=pos, method=Payment.Method.CARD, amount=Decimal("25.00"), created_at=aware(self.day, 12))
        Sale.objects.filter(pk__in=[sale.pk, pos.pk]).update(created_at=aware(self.day, 11))
        return anna, bea

    def test_expected_done_cash_and_still_to_collect(self):
        from apps.sales.reports import day_money

        self._day()
        money = day_money(self.salon, self.day)
        self.assertEqual(money["expected"], Decimal("120.00"), "70 di Anna + 50 di Bea: no-show e annullata no")
        self.assertEqual(money["done"], Decimal("70.00"))
        self.assertEqual(money["cash_in"], Decimal("75.00"), "i 50 di Anna e i 25 del banco: i 20 da saldare non sono entrati")
        self.assertEqual(money["to_collect"], Decimal("55.00"), "i 20 di Anna e i 35 di Bea oltre la caparra")
        self.assertEqual((money["visits"], money["closed"]), (2, 1))
        # un altro giorno non ne sa niente
        empty = day_money(self.salon, self.day + dt.timedelta(days=1))
        self.assertEqual([empty[k] for k in ("expected", "done", "cash_in", "to_collect")], [Decimal("0.00")] * 4)

    def test_the_visits_follow_the_location_the_cash_is_the_whole_salon(self):
        from apps.sales.reports import day_money

        _anna, bea = self._day()
        nord = Location.objects.create(salon=self.salon, name="Nord")
        bea.location = nord
        bea.save(update_fields=["location"])
        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        money = day_money(self.salon, self.day, centro.id)
        self.assertEqual((money["expected"], money["to_collect"], money["cash_in"]), (Decimal("70.00"), Decimal("20.00"), Decimal("75.00")))

    def test_the_endpoint_needs_the_agenda_and_answers_with_the_four_figures(self):
        self._day()
        res = self.client.get("/api/agenda/day-money", {"date": self.day.isoformat()}, **self.staff_auth())
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            {k: res.json()[k] for k in ("expected", "done", "cash_in", "to_collect", "visits", "closed")},
            {"expected": "120.00", "done": "70.00", "cash_in": "75.00", "to_collect": "55.00", "visits": 2, "closed": 1},
        )
        res = self.client.get(
            "/api/agenda/day-money", {"date": self.day.isoformat()}, **self.staff_auth(("inventory",), email="mag@caccia22.it"),
        )
        self.assertEqual(res.status_code, 403)
        res = self.client.get("/api/agenda/day-money", {"date": "2026-13-01"}, **self.staff_auth())
        self.assertEqual(res.status_code, 400)
