"""Caccia del 22/09: rotte dell'agenda (permessi, forma delle risposte, viste, caparra)."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.test import Client as HttpClient
from django.utils import timezone

from apps.core.models import DepositRule, Location, OutboxEvent

from . import services as S
from .models import Appointment, AppointmentService, Pause
from .tests_caccia22_disponibilita import Caccia22Base, aware

STAFF_ONLY_FIELDS = ("note", "forced", "created_via", "cancel_reason", "client", "location_id")


# ---- 02-18 + 04-05 + 10-09: /released chiede l'agenda -------------------------


class ReleasedScopeTests(Caccia22Base):
    def setUp(self):
        released = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        released.status = Appointment.Status.CANCELLED
        released.auto_released = True
        released.save(update_fields=["status", "auto_released"])

    def test_a_role_without_agenda_cannot_read_the_released_list(self):
        auth = self.staff_auth(("inventory",), email="magazzino@caccia22.it")
        res = self.client.get("/api/agenda/released", **auth)
        self.assertEqual(res.status_code, 403, res.content)

    def test_the_agenda_role_still_can(self):
        res = self.client.get("/api/agenda/released", **self.staff_auth())
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(len(res.json()), 1)


# ---- 04-06 + 10-10 + 16-06: l'app risponde con la scheda della cliente ----------


class ClientResponsesTests(Caccia22Base):
    def test_create_move_and_cancel_do_not_leak_staff_fields(self):
        auth = self.client_auth()
        created = self.post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.cut30.id}], "start": aware(self.day, 10).isoformat()}, auth,
        )
        self.assertEqual(created.status_code, 200, created.content)
        body = created.json()
        # quello che l'app legge (Prenota: conferma e caparra)
        for key in ("id", "start", "end", "status", "deposit_status", "deposit_amount",
                    "deposit_due_at", "deposit_payment_link", "services", "operator"):
            self.assertIn(key, body)
        appointment = Appointment.objects.get(pk=body["id"])
        # lo staff scrive una nota riservata sulla cliente
        appointment.note = "Cliente morosa: chiedere prima il saldo"
        appointment.save(update_fields=["note"])

        moved = self.post(
            f"/api/agenda/client/appointments/{appointment.id}/move",
            {"start": aware(self.day, 12).isoformat()}, auth,
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        cancelled = self.post(f"/api/agenda/client/appointments/{appointment.id}/cancel", {}, auth)
        self.assertEqual(cancelled.status_code, 200, cancelled.content)
        for res in (created, moved, cancelled):
            for key in STAFF_ONLY_FIELDS:
                self.assertNotIn(key, res.json(), (res.request["PATH_INFO"], key))
        self.assertNotIn("morosa", moved.content.decode() + cancelled.content.decode())
        self.assertEqual(cancelled.json()["status"], Appointment.Status.CANCELLED)


# ---- 04-02 + 04-07: colonne della vista giorno --------------------------------


class DayColumnsTests(Caccia22Base):
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


# ---- 01-14 + 04-11: date che non stanno in piedi -------------------------------


class InvalidDatesTests(Caccia22Base):
    def test_every_date_parameter_answers_400(self):
        http = HttpClient(raise_request_exception=False)
        staff = self.staff_auth()
        items = json.dumps([{"service_id": self.cut30.id}])
        cases = [
            ("/api/agenda/day", {"date": "2026-02-30"}, staff),
            ("/api/agenda/week", {"start": "2026-13-01"}, staff),
            ("/api/agenda/week", {"start": "9999-12-30"}, staff),
            ("/api/agenda/range", {"start": "2026-09-01", "end": "2026-09-31"}, staff),
            ("/api/agenda/range", {"start": "0001-01-01", "end": "0001-01-02"}, staff),
            ("/api/agenda/pauses", {"date": "2026-04-31"}, staff),
            ("/api/agenda/availability", {"date": "2026-02-29", "items": items}, staff),
            ("/api/agenda/availability", {"date": "9999-12-31", "items": items}, staff),
            ("/api/agenda/client/availability", {"date": "2026-02-29", "items": items}, self.client_auth()),
            ("/api/agenda/public/availability",
             {"salon": self.salon.slug, "date": "2027-02-29", "items": items}, {}),
        ]
        codes = {(url, tuple(params.values())): http.get(url, params, **auth).status_code for url, params, auth in cases}
        self.assertTrue(all(code == 400 for code in codes.values()), codes)

    def test_a_start_in_year_9999_is_rejected_not_a_crash(self):
        http = HttpClient(raise_request_exception=False)
        res = http.post(
            "/api/agenda/appointments",
            data=json.dumps({"client_id": self.anna.id, "items": [{"service_id": self.cut30.id}],
                             "start": "9999-12-31T23:30:00+01:00", "force": True}),
            content_type="application/json", **self.staff_auth(),
        )
        self.assertEqual(res.status_code, 422, res.content)


# ---- 04-09: walk-in e visite registrate a posteriori ---------------------------


class DepositForPastStartTests(Caccia22Base):
    def setUp(self):
        DepositRule.objects.create(
            salon=self.salon, name="Tutte", conditions={}, amount_type="fixed", amount=Decimal("10"),
        )
        self.anna.deposit_always = True
        self.anna.save(update_fields=["deposit_always"])
        self.shifts(self.giulia, 0, 24 * 60)

    def _create(self, start):
        with patch("apps.sales.stripe_service.payments_enabled", return_value=True), \
                patch("apps.sales.stripe_service.create_deposit_checkout",
                      # forma della sessione dopo 05-10/05-12 (fix22/ag-caparra):
                      # anche scadenza e account, non più la coppia (url, id)
                      return_value={"url": "https://pay.example/x", "id": "cs_1",
                                    "expires_at": None, "account": ""}):
            return self.post(
                "/api/agenda/appointments",
                {"client_id": self.anna.id, "items": [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
                 "start": start.isoformat(), "force": True},
                self.staff_auth(),
            )

    def test_a_walk_in_gets_no_deposit_and_no_payment_link(self):
        start = timezone.now().replace(second=0, microsecond=0) - dt.timedelta(minutes=5)
        res = self._create(start)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["deposit_status"], Appointment.DepositStatus.NONE)
        self.assertEqual(Decimal(res.json()["deposit_amount"]), Decimal("0"))
        self.assertFalse(OutboxEvent.objects.filter(event_type="deposit.payment_link").exists())

    def test_a_future_visit_still_asks_for_it(self):
        res = self._create(aware(self.day, 10))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["deposit_status"], Appointment.DepositStatus.REQUIRED)
        self.assertEqual(Decimal(res.json()["deposit_amount"]), Decimal("10.00"))
        self.assertTrue(OutboxEvent.objects.filter(event_type="deposit.payment_link").exists())


# ---- 01-07: caparra al netto delle gift card «a trattamento» ----------------------


class DepositNetOfGiftCardsTests(Caccia22Base):
    def setUp(self):
        DepositRule.objects.create(
            salon=self.salon, name="Prima visita", conditions={}, amount_type="pct", amount=Decimal("30"),
        )
        self.anna.deposit_always = True
        self.anna.save(update_fields=["deposit_always"])

    def gift(self, service, balance, **fields):
        from apps.marketing.models import GiftCard

        defaults = {
            "recipient_client": self.anna, "buyer_client": self.bea,
            "payment_status": "paid", "status": "active",
        }
        defaults.update(fields)
        return GiftCard.objects.create(
            salon=self.salon, code=f"GIFT{GiftCard.objects.count():08d}", initial_value=balance,
            balance=balance, gift_service=service, **defaults,
        )

    def _book(self, services):
        res = self.post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": s.id} for s in services], "start": aware(self.day, 11).isoformat()},
            self.client_auth(),
        )
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_a_gifted_treatment_needs_no_deposit(self):
        self.gift(self.cut30, Decimal("30.00"))
        body = self._book([self.cut30])
        self.assertEqual(body["deposit_status"], Appointment.DepositStatus.NONE)
        self.assertEqual(Decimal(body["deposit_amount"]), Decimal("0"))

    def test_the_deposit_is_on_what_she_will_pay_in_the_salon(self):
        self.gift(self.cut30, Decimal("30.00"))
        body = self._book([self.cut30, self.man60])  # 30 regalati + 40
        self.assertEqual(Decimal(body["deposit_amount"]), Decimal("12.00"))
        # un saldo parziale copre solo quello che resta sulla carta
        Appointment.objects.all().delete()
        from apps.marketing.models import GiftCard

        GiftCard.objects.update(balance=Decimal("20.00"))
        body = self._book([self.cut30])
        self.assertEqual(Decimal(body["deposit_amount"]), Decimal("3.00"))

    def test_cards_that_are_not_hers_or_not_spendable_do_not_count(self):
        self.gift(self.cut30, Decimal("30.00"), payment_status="unpaid")
        self.gift(self.cut30, Decimal("30.00"), expires_at=timezone.now() - dt.timedelta(days=1))
        # comprata da Anna ma intestata a mano a un'altra persona
        self.gift(self.cut30, Decimal("30.00"), recipient_client=None, buyer_client=self.anna, recipient_name="Maria")
        body = self._book([self.cut30])
        self.assertEqual(Decimal(body["deposit_amount"]), Decimal("9.00"))

    def test_one_card_covers_one_treatment(self):
        self.gift(self.cut30, Decimal("30.00"))
        body = self._book([self.cut30, self.cut30])
        self.assertEqual(Decimal(body["deposit_amount"]), Decimal("9.00"))


# ---- 10-06 / C21: codici delle gift card in agenda -----------------------------


class GiftCodesInTheAgendaTests(Caccia22Base):
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
        from .api import _client_appointment_out, gift_index

        out = _client_appointment_out(self.visit, gift_index(self.salon, [self.anna.id]))
        self.assertEqual(out["gifts"][0]["code"], self.card.code)
        self.assertTrue(AppointmentService.objects.filter(appointment=self.visit).exists())
        self.assertIsNotNone(S.spendable_gift_cards(self.salon, [self.anna.id]).first())
