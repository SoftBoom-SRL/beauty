"""Import degli appuntamenti da un altro gestionale (POST /appointments/import).

Riconoscimento della cliente, durata e prezzo del file, niente conferme né
caparre, doppioni, visite forzate e visite rifiutate una per una.
"""

import datetime as dt
from decimal import Decimal

from apps.clients.models import Client
from apps.core.models import ActivityLog, DepositRule, OutboxEvent
from common.testing import aware

from ..models import Appointment
from ..services.deposits import compute_deposit
from ..services.importer import import_visits
from .base import RealShiftsTestBase


class AppointmentImportTests(RealShiftsTestBase):
    def visit(self, hour=10, minute=0, *, items=None, **fields):
        base = {
            "first_name": "Anna", "last_name": "R", "phone": self.anna.phone, "email": "",
            "start": aware(self.day, hour, minute), "note": "",
            "items": items or [self.item()],
        }
        return {**base, **fields}

    def item(self, service=None, operator=None, duration_min=45, price=None):
        return {
            "service_id": (service or self.cut30).id,
            "operator_id": (operator or self.giulia).id,
            "duration_min": duration_min,
            "price": price,
        }

    def test_the_visit_keeps_the_duration_and_price_of_the_file(self):
        result = import_visits(self.salon, [
            self.visit(items=[self.item(duration_min=45), self.item(self.man60, self.marta, 90, Decimal("36.00"))]),
        ])
        self.assertEqual((result["created"], result["skipped"], result["errors"]), (1, 0, []))
        appointment = Appointment.objects.get(salon=self.salon)
        self.assertEqual((appointment.client, appointment.operator, appointment.forced), (self.anna, self.giulia, False))
        rows = list(appointment.items.order_by("order").values_list("operator_id", "duration_min", "soak_min", "price"))
        # senza prezzo nel file vale il listino; la durata è sempre quella del file
        self.assertEqual(rows, [
            (self.giulia.id, 45, 0, Decimal("30.00")),
            (self.marta.id, 90, 0, Decimal("36.00")),
        ])

    def test_no_confirmation_and_no_deposit_for_bookings_the_client_already_has(self):
        DepositRule.objects.create(salon=self.salon, name="Sempre", amount_type="pct", amount=Decimal("30"))
        # la stessa visita presa dal banco la caparra la chiederebbe
        self.assertGreater(compute_deposit(self.salon, self.anna, Decimal("30.00")), 0)
        import_visits(self.salon, [self.visit()])
        appointment = Appointment.objects.get(salon=self.salon)
        self.assertEqual(
            (appointment.deposit_status, appointment.deposit_amount),
            (Appointment.DepositStatus.NONE, Decimal("0")),
        )
        self.assertFalse(OutboxEvent.objects.filter(salon=self.salon).exists())

    def test_the_same_file_twice_does_not_double_the_agenda(self):
        visits = [self.visit(10), self.visit(15)]
        import_visits(self.salon, visits)
        again = import_visits(self.salon, visits)
        self.assertEqual((again["created"], again["duplicates"], again["skipped"]), (0, 2, 0))
        self.assertEqual(Appointment.objects.filter(salon=self.salon).count(), 2)

    def test_the_client_is_found_by_phone_or_created(self):
        result = import_visits(self.salon, [
            self.visit(10, phone="333 000 0001"),  # Anna, scritta senza prefisso
            self.visit(12, first_name="Carla", last_name="Neri", phone="+393331112222"),
        ])
        self.assertEqual((result["created"], result["clients_created"]), (2, 1))
        carla = Client.objects.get(salon=self.salon, phone="+393331112222")
        self.assertEqual((carla.first_name, carla.origin, carla.since), ("Carla", "Import", None))
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 3)

    def test_without_a_phone_the_name_is_matched_in_either_order(self):
        result = import_visits(self.salon, [
            self.visit(10, first_name="R", last_name="Anna", phone=""),      # cognome prima
            self.visit(12, first_name="Zoe", last_name="Ignota", phone=""),  # nessuna scheda
        ])
        self.assertEqual((result["created"], result["skipped"]), (1, 1))
        self.assertEqual(Appointment.objects.get(salon=self.salon).client, self.anna)
        self.assertEqual(result["errors"][0]["row"], 1)
        self.assertIn("nessuna scheda", result["errors"][0]["reason"])
        self.assertFalse(Client.objects.filter(first_name="Zoe").exists())

    def test_without_a_phone_two_clients_with_the_same_name_are_not_guessed(self):
        Client.objects.create(salon=self.salon, first_name="Anna", last_name="R", phone="+393330000009")
        result = import_visits(self.salon, [self.visit(phone="")])
        self.assertEqual((result["created"], result["skipped"]), (0, 1))
        self.assertIn("2 schede", result["errors"][0]["reason"])

    def test_an_operator_who_cannot_do_the_service_refuses_only_that_visit(self):
        nails_only = self.operator("Sara", services=[self.man60])
        result = import_visits(self.salon, [
            # la scheda nuova di questa visita rifiutata non deve restare in rubrica
            self.visit(10, first_name="Carla", phone="+393331112222", items=[self.item(self.cut30, nails_only)]),
            self.visit(12),
        ])
        self.assertEqual((result["created"], result["skipped"], result["clients_created"]), (1, 1, 0))
        self.assertEqual(result["errors"], [
            {"row": 0, "reason": "Operatrice non idonea per il servizio selezionato"},
        ])
        self.assertFalse(Client.objects.filter(phone="+393331112222").exists())

    def test_a_visit_over_another_or_outside_the_shift_enters_marked_forced(self):
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        result = import_visits(self.salon, [self.visit(10), self.visit(20)])
        self.assertEqual((result["created"], [w["row"] for w in result["warnings"]]), (2, [0, 1]))
        self.assertEqual(
            list(Appointment.objects.filter(client=self.anna).order_by("start").values_list("forced", flat=True)),
            [True, True],
        )

    def test_two_services_of_the_same_client_side_by_side_are_not_forced(self):
        # pedicure con Giulia e manicure con Marta nello stesso momento: è una seduta sola
        result = import_visits(self.salon, [
            self.visit(10, items=[self.item(self.cut30, self.giulia, 60)]),
            self.visit(10, 30, items=[self.item(self.man60, self.giulia, 60)]),
        ])
        self.assertEqual((result["created"], result["warnings"]), (2, []))

    def test_past_visits_and_impossible_values_are_refused(self):
        yesterday = aware(self.day, 10) - dt.timedelta(days=11)
        result = import_visits(self.salon, [
            self.visit(start=yesterday),
            self.visit(11, items=[self.item(duration_min=0)]),
            self.visit(12, items=[self.item(price=Decimal("-1"))]),
        ])
        self.assertEqual((result["created"], result["skipped"]), (0, 3))
        self.assertEqual([e["row"] for e in result["errors"]], [0, 1, 2])
        self.assertFalse(Appointment.objects.filter(salon=self.salon).exists())

    def test_an_archived_client_is_reported_with_her_profile(self):
        Client.objects.filter(pk=self.anna.pk).update(is_active=False)
        result = import_visits(self.salon, [self.visit()])
        self.assertEqual(result["errors"][0]["client_id"], self.anna.id)

    def test_endpoint_needs_the_agenda_scope_and_logs_once(self):
        body = {"visits": [{
            "first_name": "Anna", "last_name": "R", "phone": self.anna.phone,
            "start": aware(self.day, 10).isoformat(),
            "items": [{"service_id": self.cut30.id, "operator_id": self.giulia.id, "duration_min": 45, "price": "36.00"}],
        }]}
        url = "/api/agenda/appointments/import"
        self.assertEqual(self.post(url, body, self.staff_auth(("clients",), email="rubrica@caccia22.it")).status_code, 403)
        response = self.post(url, body, self.staff_auth())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            {k: response.json()[k] for k in ("created", "duplicates", "skipped", "clients_created")},
            {"created": 1, "duplicates": 0, "skipped": 0, "clients_created": 0},
        )
        log = ActivityLog.objects.get(salon=self.salon, type="appointment.imported")
        self.assertEqual(log.payload["created"], 1)
        self.assertEqual(Appointment.objects.get(salon=self.salon).items.get().price, Decimal("36.00"))
