"""Test essenziali dell'agenda.

I modelli di clients/staff/catalog sono usati direttamente (esistono a livello
di progetto integrato); `shift_windows` e `client_facts` vengono mockati per
isolare l'algoritmo dell'agenda dalla logica interna delle altre app.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import ActivityLog, DepositRule, OutboxEvent, Salon, SalonSettings
from common.auth import create_staff_tokens

from .models import Appointment, AppointmentService, Pause, WaitlistEntry
from .services import (
    cancel_appointment,
    compute_deposit,
    create_appointment,
    get_free_slots,
    move_appointment,
)


def _aware(day: dt.date, hour: int, minute: int = 0) -> dt.datetime:
    return timezone.make_aware(dt.datetime.combine(day, dt.time(hour, minute)))


class AgendaTestBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator

        cls.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        cls.client_obj = Client.objects.create(
            salon=cls.salon,
            first_name="Sofia",
            last_name="Ricci",
            phone="+390000000001",
        )
        category = ServiceCategory.objects.create(
            salon=cls.salon, name_it="Unghie", color="#FFD1DC", order=0
        )
        cls.svc60 = Service.objects.create(
            salon=cls.salon,
            category=category,
            name_it="Manicure completa",
            duration_min=60,
            price=Decimal("50.00"),
        )
        cls.svc30 = Service.objects.create(
            salon=cls.salon,
            category=category,
            name_it="Copertura gel",
            duration_min=30,
            price=Decimal("30.00"),
        )
        cls.op1 = Operator.objects.create(
            salon=cls.salon, first_name="Giulia", last_name="Bianchi", color="#AACCEE"
        )
        cls.op2 = Operator.objects.create(
            salon=cls.salon, first_name="Marta", last_name="Verdi", color="#EECCAA"
        )
        # op1 idonea a entrambi i servizi; op2 a nessuno (verifica idoneità)
        cls.op1.services.add(cls.svc60, cls.svc30)
        # data futura per evitare il filtro "niente slot nel passato"
        cls.day = timezone.localdate() + dt.timedelta(days=7)

    def _windows(self, mapping):
        """Patcha shift_windows: mapping = {operator_id: [(start_min, end_min), ...]}."""
        return patch(
            "apps.staff.services.shift_windows",
            side_effect=lambda operator, date: mapping.get(operator.id, []),
        )


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
        from .api import _item_out

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


class ComputeDepositTests(AgendaTestBase):
    def setUp(self):
        self.rule = DepositRule.objects.create(
            salon=self.salon,
            name="Bassa affidabilità",
            conditions={
                "op": "and",
                "rules": [{"field": "reliability", "cmp": "lt", "value": 60}],
            },
            amount_type=DepositRule.AmountType.PERCENT,
            amount=Decimal("30"),
            priority=0,
        )

    def test_percent_rule_matches_facts(self):
        with patch(
            "apps.clients.services.client_facts", return_value={"reliability": 50}
        ):
            self.assertEqual(
                compute_deposit(self.salon, self.client_obj, Decimal("100")),
                Decimal("30.00"),
            )

    def test_no_matching_rule_returns_zero(self):
        with patch(
            "apps.clients.services.client_facts", return_value={"reliability": 90}
        ):
            self.assertEqual(
                compute_deposit(self.salon, self.client_obj, Decimal("100")),
                Decimal("0.00"),
            )

    def test_deposit_always_uses_first_active_rule(self):
        self.client_obj.deposit_always = True
        # le condizioni NON matcherebbero: deposit_always prende comunque la prima regola
        with patch(
            "apps.clients.services.client_facts", return_value={"reliability": 90}
        ):
            self.assertEqual(
                compute_deposit(self.salon, self.client_obj, Decimal("200")),
                Decimal("60.00"),
            )

    def test_fixed_rule_and_priority_fallback(self):
        DepositRule.objects.create(
            salon=self.salon,
            name="Default fisso",
            conditions={},  # condizioni vuote: matcha sempre
            amount_type=DepositRule.AmountType.FIXED,
            amount=Decimal("20"),
            priority=1,
        )
        with patch(
            "apps.clients.services.client_facts", return_value={"reliability": 90}
        ):
            self.assertEqual(
                compute_deposit(self.salon, self.client_obj, Decimal("100")),
                Decimal("20.00"),
            )


class CreateAppointmentTests(AgendaTestBase):
    def test_collision_raises_409(self):
        mapping = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}
        items = [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        with self._windows(mapping):
            first = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 10), via="dashboard"
            )
            self.assertEqual(first.status, Appointment.Status.CONFIRMED)
            self.assertEqual(first.operator_id, self.op1.id)
            self.assertEqual(first.total_price, Decimal("50.00"))

            # stesso slot (sovrapposto): 409
            with self.assertRaises(HttpError) as caught:
                create_appointment(
                    self.salon,
                    self.client_obj,
                    items,
                    _aware(self.day, 10, 30),
                    via="dashboard",
                )
            self.assertEqual(caught.exception.status_code, 409)

            # anche in auto-assegnazione: op1 occupata, op2 non idonea -> 409
            with self.assertRaises(HttpError) as caught:
                create_appointment(
                    self.salon,
                    self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": None}],
                    _aware(self.day, 10, 30),
                    via="dashboard",
                )
            self.assertEqual(caught.exception.status_code, 409)

            # slot adiacente libero: ok
            second = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 11), via="dashboard"
            )
            self.assertEqual(second.status, Appointment.Status.CONFIRMED)

        self.assertEqual(
            OutboxEvent.objects.filter(event_type="appointment.created").count(), 2
        )

    def test_snapshot_and_deposit_none_without_rules(self):
        mapping = {self.op1.id: [(8 * 60, 20 * 60)]}
        items = [
            {"service_id": self.svc60.id, "operator_id": None},
            {"service_id": self.svc30.id, "operator_id": None},
        ]
        with self._windows(mapping):
            appointment = create_appointment(
                self.salon, self.client_obj, items, _aware(self.day, 9), via="app"
            )
        self.assertEqual(appointment.total_duration_min, 90)
        self.assertEqual(appointment.total_price, Decimal("80.00"))
        self.assertEqual(appointment.end, _aware(self.day, 10, 30))
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.NONE)
        self.assertEqual(appointment.created_via, "app")


class CancelAppointmentTests(AgendaTestBase):
    def _make(self, start, deposit_status=Appointment.DepositStatus.PAID):
        return Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=self.op1,
            start=start,
            deposit_status=deposit_status,
            deposit_amount=Decimal("15.00"),
        )

    def test_salon_cancelling_at_the_last_minute_does_not_punish_the_client(self):
        # Il test di prima pretendeva caparra trattenuta e `cancelled_late` da un
        # annullamento senza attore, cioè fatto dal salone: blindava il difetto.
        # L'app cliente rifiuta l'annullamento sotto le 24 ore, quindi l'unico
        # modo di arrivare qui a due ore dalla visita è che sia la reception ad
        # annullare (l'operatrice si è ammalata): la cliente non deve perdere la
        # caparra né finire fra le inaffidabili.
        appointment = self._make(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, reason="imprevisto")
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)
        self.assertFalse(appointment.cancelled_late)
        self.assertEqual(
            appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE
        )
        self.assertEqual(appointment.cancel_reason, "imprevisto")
        types = set(OutboxEvent.objects.values_list("event_type", flat=True))
        self.assertIn("appointment.cancelled", types)
        self.assertIn("slot.freed", types)

    def test_late_cancel_by_the_client_forfeits_deposit(self):
        # La penale resta, ma solo per chi annulla all'ultimo: la cliente.
        appointment = self._make(timezone.now() + dt.timedelta(hours=2))
        cancel_appointment(appointment, reason="non ce la faccio", by_client=True)
        appointment.refresh_from_db()
        self.assertTrue(appointment.cancelled_late)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.FORFEITED)

    def test_client_cancelling_in_time_gets_the_deposit_back(self):
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment, by_client=True)
        appointment.refresh_from_db()
        self.assertFalse(appointment.cancelled_late)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE)

    def test_mark_deposit_refunded_also_writes_how_much_came_back(self):
        # La scheda diceva «Caparra 15 · Rimborsato 0 · Stato: rimborsata».
        from .services import mark_deposit_refunded

        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        appointment.refresh_from_db()
        mark_deposit_refunded(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("15.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("0.00"))

    def test_early_cancel_without_stripe_leaves_deposit_refund_due(self):
        # Nessun rimborso è avvenuto (Stripe non configurato, caparra incassata in
        # salone): lo stato deve dirlo, non fingere «rimborsata».
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        appointment.refresh_from_db()
        self.assertFalse(appointment.cancelled_late)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE)
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refund_due").exists()
        )

    def test_early_cancel_refunds_on_stripe_when_possible(self):
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        appointment.deposit_payment_intent_id = "pi_test_123"
        appointment.save(update_fields=["deposit_payment_intent_id"])
        refunded = {"id": "re_test_1", "amount": 1500, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_deposit", return_value=refunded) as refund:
            cancel_appointment(appointment)
        refund.assert_called_once_with(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refunded").exists()
        )

    def test_mark_deposit_refunded_manually(self):
        from .services import mark_deposit_refunded

        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        appointment.refresh_from_db()
        mark_deposit_refunded(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        with self.assertRaises(HttpError) as caught:
            mark_deposit_refunded(appointment)
        self.assertEqual(caught.exception.status_code, 400)

    def test_cancelled_appointment_is_not_editable(self):
        appointment = self._make(timezone.now() + dt.timedelta(hours=72))
        cancel_appointment(appointment)
        with self.assertRaises(HttpError) as caught:
            cancel_appointment(appointment)
        self.assertEqual(caught.exception.status_code, 400)


class AppointmentEditApiTests(AgendaTestBase):
    """PUT /appointments/{id} con durate editabili + add/remove servizi + GET singolo."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(
            email="sole@theparlour.it", password="theparlour"
        )
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["agenda"])
        Membership.objects.create(
            user=self.user, salon=self.salon, role=role, is_owner=True
        )
        tokens = create_staff_tokens(self.user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}
        # finestra ampia per op1: le durate di listino entrano comodamente
        self.mapping = {self.op1.id: [(8 * 60, 20 * 60)]}

    def _put(self, path, payload):
        return self.client.put(
            path,
            data=json.dumps(payload),
            content_type="application/json",
            **self.auth,
        )

    def _make(self, items, start_hour=10, windows=None):
        with self._windows(windows or self.mapping):
            return create_appointment(
                self.salon,
                self.client_obj,
                items,
                _aware(self.day, start_hour),
                via="dashboard",
            )

    # (d) GET singolo appuntamento
    def test_get_single_appointment(self):
        appointment = self._make(
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        resp = self.client.get(
            f"/api/agenda/appointments/{appointment.id}", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["id"], appointment.id)
        self.assertEqual(body["total_duration_min"], 60)
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["service_id"], self.svc60.id)
        self.assertEqual(body["items"][0]["duration_min"], 60)

    def test_get_unknown_appointment_404(self):
        resp = self.client.get("/api/agenda/appointments/999999", **self.auth)
        self.assertEqual(resp.status_code, 404)

    # (a) override durata persiste (NON re-snapshottata dal listino)
    def test_put_duration_override_persists(self):
        appointment = self._make(
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        item = appointment.items.get()
        payload = {
            "items": [
                {
                    "id": item.id,
                    "service_id": self.svc60.id,
                    "operator_id": self.op1.id,
                    "duration_min": 90,  # override; il listino è 60
                }
            ]
        }
        with self._windows(self.mapping):
            resp = self._put(f"/api/agenda/appointments/{appointment.id}", payload)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["duration_min"], 90)
        self.assertEqual(body["total_duration_min"], 90)
        # persistito e NON riportato al valore di listino (60)
        appointment.refresh_from_db()
        self.assertEqual(appointment.items.get().duration_min, 90)

    def test_put_zero_duration_falls_back_to_catalog(self):
        appointment = self._make(
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        item = appointment.items.get()
        payload = {
            "items": [
                {
                    "id": item.id,
                    "service_id": self.svc60.id,
                    "operator_id": self.op1.id,
                    "duration_min": 0,  # non valido: resta la durata della visita (60)
                }
            ]
        }
        with self._windows(self.mapping):
            resp = self._put(f"/api/agenda/appointments/{appointment.id}", payload)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["items"][0]["duration_min"], 60)

    # (b) aggiunta di un servizio (voce senza id) accodata come blocco successivo
    def test_put_add_item_appends_block(self):
        appointment = self._make(
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        item = appointment.items.get()
        payload = {
            "items": [
                {"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id},
                {"service_id": self.svc30.id, "operator_id": self.op1.id},  # nuovo
            ]
        }
        with self._windows(self.mapping):
            resp = self._put(f"/api/agenda/appointments/{appointment.id}", payload)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(len(body["items"]), 2)
        self.assertEqual(body["items"][0]["service_id"], self.svc60.id)
        self.assertEqual(body["items"][1]["service_id"], self.svc30.id)
        self.assertEqual([i["order"] for i in body["items"]], [0, 1])
        self.assertEqual(body["total_duration_min"], 90)
        self.assertEqual(body["total_price"], "80.00")

    # (c) rimozione di un servizio (voce omessa dalla lista)
    def test_put_remove_item(self):
        appointment = self._make(
            [
                {"service_id": self.svc60.id, "operator_id": self.op1.id},
                {"service_id": self.svc30.id, "operator_id": self.op1.id},
            ]
        )
        self.assertEqual(appointment.items.count(), 2)
        first = appointment.items.order_by("order").first()
        payload = {
            "items": [
                {"id": first.id, "service_id": self.svc60.id, "operator_id": self.op1.id}
            ]
        }
        with self._windows(self.mapping):
            resp = self._put(f"/api/agenda/appointments/{appointment.id}", payload)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(len(body["items"]), 1)
        self.assertEqual(body["items"][0]["service_id"], self.svc60.id)
        self.assertEqual(body["total_duration_min"], 60)
        self.assertEqual(appointment.items.count(), 1)

    # (e) override durata che non ci sta più (sfora il turno) -> 409, DB invariato
    def test_put_duration_override_out_of_window_409(self):
        narrow = {self.op1.id: [(9 * 60, 11 * 60)]}
        appointment = self._make(
            [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
            start_hour=10,
            windows=narrow,
        )
        item = appointment.items.get()
        payload = {
            "items": [
                {
                    "id": item.id,
                    "service_id": self.svc30.id,
                    "operator_id": self.op1.id,
                    "duration_min": 120,  # 10:00-12:00 sfora la finestra (chiude alle 11:00)
                }
            ]
        }
        with self._windows(narrow):
            resp = self._put(f"/api/agenda/appointments/{appointment.id}", payload)
        self.assertEqual(resp.status_code, 409, resp.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.items.get().duration_min, 30)

    def test_put_empty_items_400(self):
        appointment = self._make(
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        resp = self._put(
            f"/api/agenda/appointments/{appointment.id}", {"items": []}
        )
        self.assertEqual(resp.status_code, 400)

    # Il GET singolo non oscura le rotte con suffisso letterale (/check-in, /margin, /move).
    def test_action_routes_not_shadowed_by_get(self):
        appointment = self._make(
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        )
        resp = self.client.post(
            f"/api/agenda/appointments/{appointment.id}/check-in", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["status"], Appointment.Status.CHECKED_IN)

        resp = self.client.get(
            f"/api/agenda/appointments/{appointment.id}/margin", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIn("margin", resp.json())


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


class ClientBookingApiTests(AgendaTestBase):
    """API app cliente: niente prenotazioni nel passato né su servizi disattivati;
    lo spostamento cerca la disponibilità con le operatrici originarie ed esclude
    l'appuntamento che si sta spostando."""

    def setUp(self):
        from common.auth import create_client_tokens

        tokens = create_client_tokens(self.client_obj)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}
        windows = self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]})
        windows.start()
        self.addCleanup(windows.stop)

    def _post(self, url, body):
        return self.client.post(url, data=json.dumps(body), content_type="application/json", **self.auth)

    def _availability(self, items, **extra):
        params = {"date": self.day.isoformat(), "items": json.dumps(items), **extra}
        res = self.client.get("/api/agenda/client/availability", params, **self.auth)
        return res

    def test_past_booking_rejected(self):
        yesterday = timezone.localdate() - dt.timedelta(days=1)
        res = self._post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.svc60.id}], "start": _aware(yesterday, 10).isoformat()},
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Appointment.objects.count(), 0)

    def test_inactive_service_rejected_everywhere(self):
        self.svc60.active = False
        self.svc60.save(update_fields=["active"])
        res = self._post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.svc60.id}], "start": _aware(self.day, 10).isoformat()},
        )
        self.assertEqual(res.status_code, 404, res.content)
        self.assertEqual(self._availability([{"service_id": self.svc60.id}]).status_code, 404)
        self.assertEqual(Appointment.objects.count(), 0)

    def test_client_booking_lands_on_the_default_location(self):
        from apps.core.models import Location

        Location.objects.create(salon=self.salon, name="Secondaria")
        default = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        res = self._post(
            "/api/agenda/client/appointments",
            {"items": [{"service_id": self.svc60.id}], "start": _aware(self.day, 10).isoformat()},
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["location_id"], default.id)

    def test_move_availability_uses_original_operator_and_excludes_itself(self):
        # op2 diventa idonea: senza vincolo di operatrice la disponibilità la
        # proporrebbe, ma lo spostamento conserva op1 → 409. Con operator_id
        # negli items i due calcoli coincidono.
        self.op2.services.add(self.svc60)
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000002")
        create_appointment(
            self.salon, other, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 12), via="dashboard",
        )
        mine = create_appointment(
            self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="app",
        )

        upcoming = self.client.get("/api/agenda/client/appointments", **self.auth).json()["upcoming"]
        self.assertEqual(upcoming[0]["services"][0]["operator_id"], self.op1.id)

        loose = [s["start"] for s in self._availability([{"service_id": self.svc60.id}]).json()]
        self.assertIn(_aware(self.day, 12).isoformat(), loose)  # su op2: lo spostamento lo rifiuterebbe

        items = [{"service_id": self.svc60.id, "operator_id": self.op1.id}]
        strict = [s["start"] for s in self._availability(items).json()]
        self.assertNotIn(_aware(self.day, 12).isoformat(), strict)
        self.assertNotIn(_aware(self.day, 10).isoformat(), strict)  # occupato da sé stesso…

        excluded = [s["start"] for s in self._availability(items, exclude_appointment_id=mine.id).json()]
        self.assertIn(_aware(self.day, 10).isoformat(), excluded)  # …salvo escludersi
        self.assertIn(_aware(self.day, 14).isoformat(), excluded)

        res = self._post(f"/api/agenda/client/appointments/{mine.id}/move", {"start": _aware(self.day, 14).isoformat()})
        self.assertEqual(res.status_code, 200, res.content)
        res = self._post(f"/api/agenda/client/appointments/{mine.id}/move", {"start": _aware(self.day, 12).isoformat()})
        self.assertEqual(res.status_code, 409, res.content)

    def test_move_availability_inherits_operators_when_items_omit_them(self):
        # Anche un client che non passa operator_id ottiene, con exclude_appointment_id,
        # la disponibilità calcolata sulle operatrici dell'appuntamento da spostare.
        self.op2.services.add(self.svc60)
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000004")
        create_appointment(
            self.salon, other, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 12), via="dashboard",
        )
        mine = create_appointment(
            self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="app",
        )
        res = self._availability([{"service_id": self.svc60.id}], exclude_appointment_id=mine.id)
        self.assertEqual(res.status_code, 200, res.content)
        slots = res.json()
        starts = [s["start"] for s in slots]
        self.assertNotIn(_aware(self.day, 12).isoformat(), starts)  # op1 è occupata: niente slot su op2
        self.assertIn(_aware(self.day, 10).isoformat(), starts)
        self.assertTrue(all(a["operator_id"] == self.op1.id for s in slots for a in s["assignment"]))

    def test_cannot_exclude_someone_elses_appointment(self):
        from apps.clients.models import Client

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000003")
        theirs = create_appointment(
            self.salon, other, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard",
        )
        res = self._availability([{"service_id": self.svc60.id}], exclude_appointment_id=theirs.id)
        self.assertEqual(res.status_code, 404)


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


class ForcedBookingTests(AgendaTestBase):
    """Lo staff può andare oltre le regole: fuori turno, centro chiuso, sovrapposizione."""

    def _staff(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="force@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def test_force_creates_outside_shift_and_over_other_bookings(self):
        auth = self._staff()
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            body = {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                "start": _aware(self.day, 20).isoformat(),  # fuori turno
            }
            res = self.client.post("/api/agenda/appointments", data=json.dumps(body), content_type="application/json", **auth)
            self.assertEqual(res.status_code, 409)
            res = self.client.post("/api/agenda/appointments", data=json.dumps({**body, "force": True}), content_type="application/json", **auth)
            self.assertEqual(res.status_code, 200, res.content)
            self.assertTrue(res.json()["forced"])
            # sovrapposizione sulla stessa operatrice, sempre forzata
            body["start"] = _aware(self.day, 20, 30).isoformat()
            res = self.client.post("/api/agenda/appointments", data=json.dumps({**body, "force": True}), content_type="application/json", **auth)
            self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(Appointment.objects.filter(forced=True).count(), 2)

    def test_force_never_bypasses_operator_eligibility(self):
        auth = self._staff()
        body = {
            "client_id": self.client_obj.id,
            "items": [{"service_id": self.svc60.id, "operator_id": self.op2.id}],  # op2 non abilitata
            "start": _aware(self.day, 10).isoformat(),
            "force": True,
        }
        with self._windows({self.op2.id: [(9 * 60, 18 * 60)]}):
            res = self.client.post("/api/agenda/appointments", data=json.dumps(body), content_type="application/json", **auth)
        self.assertEqual(res.status_code, 400)

    def test_client_api_cannot_force(self):
        from common.auth import create_client_tokens

        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            res = self.client.post(
                "/api/agenda/client/appointments",
                data=json.dumps({"items": [{"service_id": self.svc60.id}], "start": _aware(self.day, 20).isoformat(), "force": True}),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 409)

    def test_forced_move_skips_validation(self):
        with self._windows({self.op1.id: [(9 * 60, 13 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            with self.assertRaises(HttpError):
                move_appointment(appointment, _aware(self.day, 19))
            move_appointment(appointment, _aware(self.day, 19), force=True)
        appointment.refresh_from_db()
        self.assertEqual(timezone.localtime(appointment.start).hour, 19)
        self.assertTrue(appointment.forced)


class SplitAppointmentTests(AgendaTestBase):
    def test_split_moves_one_service_to_its_own_appointment(self):
        from .services import split_appointment

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
        from .services import split_appointment

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


class DepositHoldTests(AgendaTestBase):
    """Caparra con scadenza: sollecito, rilascio automatico con traccia, ripristino."""

    def setUp(self):
        # hold 30 e sollecito 10: con 20/10 «dieci minuti prima della scadenza» e
        # «dieci minuti dopo la prenotazione» cadevano sullo stesso istante, e il
        # test non distingueva più le due formule.
        SalonSettings.objects.create(salon=self.salon, deposit_hold_minutes=30, deposit_reminder_minutes=10)
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        # La scadenza esiste solo dove si può pagare online: qui si finge di sì.
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def _book(self):
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                return create_appointment(
                    self.salon, self.client_obj, [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    _aware(self.day, 10), via="app",
                )

    def test_booking_gets_a_due_date(self):
        appointment = self._book()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REQUIRED)
        self.assertIsNotNone(appointment.deposit_due_at)
        minutes = (appointment.deposit_due_at - timezone.now()).total_seconds() / 60
        self.assertTrue(29 < minutes <= 30)

    def test_without_online_payments_no_deadline_is_set(self):
        # Senza Stripe nessun link parte: fissare la scadenza significava
        # annullare da sola ogni prenotazione con caparra.
        with patch("apps.sales.stripe_service.payments_enabled", return_value=False):
            appointment = self._book()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REQUIRED)
        self.assertIsNone(appointment.deposit_due_at)
        from .services import process_deposit_holds

        result = process_deposit_holds(self.salon, now=timezone.now() + dt.timedelta(hours=3))
        self.assertEqual(result["released"], 0)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)

    def test_the_deadline_never_goes_past_the_start_of_the_visit(self):
        # Prenotazione presa dieci minuti prima della visita con un'ora di hold:
        # la scadenza cadeva a visita iniziata e il posto si liberava con la
        # cliente già sotto le mani dell'operatrice.
        SalonSettings.objects.filter(salon=self.salon).update(deposit_hold_minutes=60)
        self.salon = Salon.objects.get(pk=self.salon.pk)
        start = timezone.now() + dt.timedelta(minutes=10)
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=start,
            deposit_status=Appointment.DepositStatus.REQUIRED, deposit_amount=Decimal("10.00"),
        )
        from .services import process_deposit_holds, schedule_deposit_hold

        schedule_deposit_hold(appointment)
        self.assertEqual(appointment.deposit_due_at, start)
        # e una volta cominciata, la visita non si annulla più da sola
        result = process_deposit_holds(self.salon, now=start + dt.timedelta(minutes=5))
        self.assertEqual(result["released"], 0)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)

    def test_a_deposit_cashed_at_the_counter_keeps_the_slot(self):
        from apps.accounts.models import Membership, Role, User

        appointment = self._book()
        self.assertIsNotNone(appointment.deposit_due_at)
        user = User.objects.create_user(email="cassa@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda", "sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        res = self.client.post(
            f"/api/agenda/appointments/{appointment.id}/deposit-cashed",
            data=json.dumps({"method": "cash"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["deposit_status"], Appointment.DepositStatus.PAID)
        appointment.refresh_from_db()
        self.assertIsNone(appointment.deposit_due_at)
        # e il termine non la tocca più
        from .services import process_deposit_holds

        self.assertEqual(
            process_deposit_holds(self.salon, now=timezone.now() + dt.timedelta(hours=2))["released"],
            0,
        )
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.cashed").exists()
        )
        # una seconda registrazione non raddoppia l'incasso
        res = self.client.post(
            f"/api/agenda/appointments/{appointment.id}/deposit-cashed",
            data=json.dumps({"method": "cash"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_reminder_then_release_with_trace_and_restore(self):
        from .services import process_deposit_holds, released_appointments, restore_released

        appointment = self._book()
        now = timezone.now()
        self.assertEqual(process_deposit_holds(self.salon, now=now), {"reminded": 0, "released": 0})
        # Il sollecito parte `deposit_reminder_minutes` DOPO la prenotazione
        # (10'), non 10' prima della scadenza (che è a 30'): con hold 20 le due
        # letture coincidevano e il test non distingueva le due formule.
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=5))["reminded"], 0)
        result = process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=11))
        self.assertEqual(result, {"reminded": 1, "released": 0})
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=12))["reminded"], 0)
        self.assertTrue(OutboxEvent.objects.filter(event_type="deposit.reminder").exists())
        # dopo 30 minuti: slot liberato, traccia per richiamare
        result = process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=31))
        self.assertEqual(result["released"], 1)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)
        self.assertTrue(appointment.auto_released)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REQUIRED)
        self.assertIn(appointment.id, [a.id for a in released_appointments(self.salon)])
        self.assertTrue(OutboxEvent.objects.filter(event_type="appointment.released_unpaid").exists())
        self.assertTrue(OutboxEvent.objects.filter(event_type="slot.freed").exists())
        # lo slot è di nuovo libero
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            starts = [s["start"] for s in get_free_slots(self.salon, self.day, [{"service_id": self.svc60.id, "operator_id": self.op1.id}])]
            self.assertIn(_aware(self.day, 10).isoformat(), starts)
            # ripristino: torna confermato con una nuova scadenza
            restore_released(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        self.assertFalse(appointment.auto_released)
        self.assertIsNotNone(appointment.deposit_due_at)

    def test_paid_deposit_is_never_released(self):
        from .services import process_deposit_holds

        appointment = self._book()
        appointment.deposit_status = Appointment.DepositStatus.PAID
        appointment.deposit_due_at = None
        appointment.save()
        result = process_deposit_holds(self.salon, now=timezone.now() + dt.timedelta(hours=2))
        self.assertEqual(result["released"], 0)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)

    def test_released_list_and_restore_api(self):
        from apps.accounts.models import Membership, Role, User

        from .services import process_deposit_holds

        user = User.objects.create_user(email="rail@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        appointment = self._book()
        process_deposit_holds(self.salon, now=timezone.now() + dt.timedelta(minutes=31))
        res = self.client.get("/api/agenda/released", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([a["id"] for a in res.json()], [appointment.id])
        self.assertTrue(res.json()[0]["auto_released"])
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            res = self.client.post(f"/api/agenda/appointments/{appointment.id}/restore", data="{}", content_type="application/json", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["status"], "confirmed")
        self.assertEqual(self.client.get("/api/agenda/released", **auth).json(), [])


class SmartSlotsTests(AgendaTestBase):
    """Disponibilità intelligente: niente orari che lascerebbero buchi invendibili."""

    def test_recommended_flags_and_client_filtering(self):
        from common.auth import create_client_tokens

        from .services import smart_slots

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
        from .services import smart_slots

        self.assertEqual(smart_slots(self.salon, [{"start": "x", "assignment": [], "recommended": False}]), [{"start": "x", "assignment": [], "recommended": False}])


class RangeAndGiftTests(AgendaTestBase):
    def _staff(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="range@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

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
        self.assertEqual([g["code"] for g in out["gifts"]], [card.code])
        self.assertEqual(out["gifts"][0]["service_id"], self.svc60.id)
        detail = self.client.get(f"/api/agenda/appointments/{appointment.id}", **auth).json()
        self.assertEqual(len(detail["gifts"]), 1)


class SplitCollisionTests(AgendaTestBase):
    """Lo stacca-e-sposta non deve creare sovrapposizioni: né con i servizi che
    restano nella visita, né con altre clienti quando la catena residua scala."""

    def test_detached_service_cannot_overlap_the_services_that_stay(self):
        from .services import split_appointment

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

    def test_remaining_chain_is_revalidated_when_the_first_service_leaves(self):
        from apps.clients.models import Client

        from .services import split_appointment

        other = Client.objects.create(salon=self.salon, first_name="Altra", last_name="Cliente", phone="+390000000009")
        self.op2.services.add(self.svc30)
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}):
            # visita: 10:00 svc60 (op1) + 11:00 svc30 (op2)
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}, {"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 10), via="dashboard",
            )
            # op2 è occupata alle 10:00 da un'altra cliente
            create_appointment(
                self.salon, other, [{"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 10), via="dashboard",
            )
            first = appointment.items.order_by("order").first()
            # staccando il primo servizio, svc30 scalerebbe a 10:00 sopra l'altra cliente
            with self.assertRaises(HttpError) as caught:
                split_appointment(appointment, first.id, _aware(self.day, 15))
            self.assertEqual(caught.exception.status_code, 409)
        appointment.refresh_from_db()
        self.assertEqual(appointment.items.count(), 2)
        self.assertEqual(timezone.localtime(appointment.start).hour, 10)
        # forzando, lo staff se ne assume la responsabilità
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}):
            original, created = split_appointment(appointment, appointment.items.order_by("order").first().id, _aware(self.day, 15), force=True)
        self.assertEqual(original.items.count(), 1)
        self.assertEqual(timezone.localtime(created.start).hour, 15)


class BugHuntAgendaTests(AgendaTestBase):
    """Difetti trovati nella ricerca bug del 17/09/2026."""

    def test_the_client_app_cannot_move_an_appointment_into_the_past(self):
        """Prenotare nel passato era già vietato; spostarci un appuntamento no."""
        from .services import move_appointment

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
        from .services import _busy_map

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
        from .api import MAX_ITEMS_PER_REQUEST, _parse_items_param

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

        from .api import gift_index

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

        from .api import gift_index

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

        from .services import resolve_items

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

        from .services import _slot_is_recommended

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


class ConcurrentTransitionTests(AgendaTestBase):
    """Due postazioni che lavorano sullo stesso appuntamento.

    Ogni mutazione decideva sullo stato che l'istanza aveva quando la richiesta
    era entrata, e salvava tutti i campi: chi spostava un appuntamento appena
    annullato da un'altra postazione lo riportava in agenda come confermato.
    """

    def _appointment(self):
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
        return appointment

    def test_a_move_on_a_stale_copy_cannot_undo_a_cancellation(self):
        from .services import cancel_appointment, move_appointment

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)  # copia letta prima
        cancel_appointment(appointment)

        with self._windows({self.op1.id: [(0, 1440)]}):
            with self.assertRaises(HttpError) as caught:
                move_appointment(stale, appointment.start + dt.timedelta(hours=2))
        self.assertEqual(caught.exception.status_code, 400)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)

    def test_a_move_does_not_overwrite_a_deposit_paid_meanwhile(self):
        from .services import move_appointment

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)
        # La caparra arriva (webhook Stripe) mentre lo spostamento è in volo.
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("20.00")
        )
        with self._windows({self.op1.id: [(0, 1440)]}):
            move_appointment(stale, appointment.start + dt.timedelta(hours=2))
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_amount, Decimal("20.00"))

    def test_check_in_is_refused_on_an_appointment_cancelled_meanwhile(self):
        from .services import cancel_appointment, check_in

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)
        cancel_appointment(appointment)
        with self.assertRaises(HttpError):
            check_in(stale)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)


class AvailabilityMatchesBookingTests(AgendaTestBase):
    """Quello che la ricerca propone, la conferma deve accettarlo."""

    def setUp(self):
        from common.auth import create_client_tokens

        tokens = create_client_tokens(self.client_obj)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

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


class StaleCopyEditTests(AgendaTestBase):
    """PUT appuntamento: niente più decisioni (e salvataggi) su una copia vecchia."""

    def _appointment(self, **extra):
        return Appointment.objects.create(
            salon=self.salon,
            client=self.client_obj,
            operator=self.op1,
            start=_aware(self.day, 10),
            **extra,
        )

    def test_editing_a_note_cannot_resurrect_an_appointment_cancelled_meanwhile(self):
        from .services import edit_appointment

        appointment = self._appointment()
        stale = Appointment.objects.get(pk=appointment.pk)  # copia entrata con la richiesta
        cancel_appointment(appointment, reason="chiuso per lutto")

        with self.assertRaises(HttpError) as caught:
            edit_appointment(stale, note="richiamare")
        self.assertEqual(caught.exception.status_code, 400)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)
        self.assertEqual(appointment.cancel_reason, "chiuso per lutto")

    def test_editing_a_note_does_not_undo_a_deposit_paid_meanwhile(self):
        from .services import edit_appointment

        appointment = self._appointment(
            deposit_status=Appointment.DepositStatus.REQUIRED,
            deposit_amount=Decimal("20.00"),
            deposit_due_at=timezone.now() + dt.timedelta(minutes=30),
        )
        stale = Appointment.objects.get(pk=appointment.pk)
        # Il webhook Stripe registra il pagamento mentre la nota è in volo.
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID,
            deposit_payment_intent_id="pi_123",
            deposit_due_at=None,
        )
        edit_appointment(stale, note="allergica alla formaldeide")

        appointment.refresh_from_db()
        self.assertEqual(appointment.note, "allergica alla formaldeide")
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_payment_intent_id, "pi_123")
        self.assertIsNone(appointment.deposit_due_at)

    def test_editing_the_services_keeps_the_price_agreed_with_the_client(self):
        """Il listino può cambiare: la visita vale quello che valeva quando è stata presa."""
        from .services import create_appointment, edit_appointment

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            item = appointment.items.get()
            self.assertEqual(item.price, Decimal("50.00"))
            # il titolare ritocca il listino e alza anche la posa
            self.svc60.price = Decimal("70.00")
            self.svc60.soak_min = 20
            self.svc60.save(update_fields=["price", "soak_min"])
            edit_appointment(
                appointment,
                items=[{
                    "id": item.id,
                    "service_id": self.svc60.id,
                    "operator_id": self.op1.id,
                    "duration_min": 75,  # si allunga solo la durata
                }],
            )
        item = appointment.items.get()
        self.assertEqual(item.duration_min, 75)
        self.assertEqual(item.price, Decimal("50.00"))  # prezzo concordato
        self.assertEqual(item.soak_min, 0)              # posa dello snapshot
        self.assertEqual(appointment.total_price, Decimal("50.00"))
        self.svc60.price = Decimal("50.00")
        self.svc60.soak_min = 0
        self.svc60.save(update_fields=["price", "soak_min"])

    def test_a_service_added_now_takes_todays_price(self):
        from .services import create_appointment, edit_appointment

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            item = appointment.items.get()
            edit_appointment(
                appointment,
                items=[
                    {"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},
                ],
            )
        added = appointment.items.order_by("order").last()
        self.assertEqual(added.price, self.svc30.price)
        # la modifica dei servizi va anche in coda per il promemoria alla cliente
        self.assertTrue(OutboxEvent.objects.filter(event_type="appointment.updated").exists())


class DepositFitsTheVisitTests(AgendaTestBase):
    """La caparra non può superare quello che resta da pagare: il conto va chiuso."""

    def _paid_visit(self, deposit):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=deposit
        )
        appointment.refresh_from_db()
        return appointment

    def test_detaching_a_service_brings_the_deposit_down_to_the_new_total(self):
        from .services import split_appointment

        appointment = self._paid_visit(Decimal("60.00"))  # totale 80, caparra 60
        first = appointment.items.order_by("order").first()  # il servizio da 50
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, created = split_appointment(
                appointment, first.id, _aware(self.day, 15)
            )
        original.refresh_from_db()
        self.assertEqual(original.total_price, Decimal("30.00"))
        self.assertEqual(original.deposit_amount, Decimal("30.00"))
        # resta pagata: i 30 ancora in cassa si detraggono al checkout
        self.assertEqual(original.deposit_credit, Decimal("30.00"))
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.refund_due")
        self.assertEqual(log.payload["amount"], "30.00")
        self.assertEqual(created.deposit_amount, Decimal("0.00"))

    def test_removing_a_service_brings_the_deposit_down_to_the_new_total(self):
        from .services import edit_appointment

        appointment = self._paid_visit(Decimal("60.00"))
        first = appointment.items.order_by("order").first()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            edit_appointment(
                appointment,
                items=[{"id": first.id, "service_id": self.svc60.id, "operator_id": self.op1.id}],
            )
        appointment.refresh_from_db()
        self.assertEqual(appointment.total_price, Decimal("50.00"))
        self.assertEqual(appointment.deposit_amount, Decimal("50.00"))
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refund_due").exists()
        )

    def test_a_deposit_that_still_fits_is_left_alone(self):
        from .services import edit_appointment

        appointment = self._paid_visit(Decimal("20.00"))
        first = appointment.items.order_by("order").first()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            edit_appointment(
                appointment,
                items=[{"id": first.id, "service_id": self.svc60.id, "operator_id": self.op1.id}],
            )
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_amount, Decimal("20.00"))
        self.assertFalse(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refund_due").exists()
        )


class RefundConcurrencyTests(AgendaTestBase):
    """I rimborsi parziali si sommano, non si sovrascrivono."""

    def test_two_partial_refunds_add_up(self):
        from .services import record_deposit_refund

        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1,
            start=_aware(self.day, 10),
            deposit_status=Appointment.DepositStatus.PAID,
            deposit_amount=Decimal("30.00"),
        )
        first = Appointment.objects.get(pk=appointment.pk)
        second = Appointment.objects.get(pk=appointment.pk)  # due worker, due copie
        record_deposit_refund(first, refund_id="re_1", cents=1500, status="succeeded")
        record_deposit_refund(second, refund_id="re_2", cents=1500, status="succeeded")

        appointment.refresh_from_db()
        self.assertEqual(set(appointment.deposit_refunds), {"re_1", "re_2"})
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("30.00"))
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertEqual(appointment.deposit_credit, Decimal("0.00"))


class RestoreReleasedTests(AgendaTestBase):
    """Ripristino di uno slot liberato: una volta sola, e con un link pagabile."""

    def _released(self):
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1,
            start=_aware(self.day, 10),
            status=Appointment.Status.CANCELLED,
            auto_released=True,
            deposit_status=Appointment.DepositStatus.REQUIRED,
            deposit_amount=Decimal("10.00"),
            deposit_payment_link="https://pay.example/scaduto",
            deposit_checkout_session_id="cs_old",
        )
        AppointmentService.objects.create(
            appointment=appointment, service=self.svc60, operator=self.op1,
            duration_min=60, soak_min=0, price=self.svc60.price, order=0,
        )
        return appointment

    def test_the_second_restore_click_is_refused(self):
        from .services import restore_released

        appointment = self._released()
        stale = Appointment.objects.get(pk=appointment.pk)  # la seconda operatrice
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            restore_released(appointment)
            with self.assertRaises(HttpError) as caught:
                restore_released(stale)
        self.assertEqual(caught.exception.status_code, 400)
        # una sola conferma alla cliente
        self.assertEqual(OutboxEvent.objects.filter(event_type="appointment.created").count(), 1)

    def test_restoring_drops_the_expired_payment_link(self):
        from .services import restore_released

        appointment = self._released()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            restore_released(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_payment_link, "")
        # l'id della sessione resta: serve a chiudere quella vecchia su Stripe
        self.assertEqual(appointment.deposit_checkout_session_id, "cs_old")

    def test_restoring_does_not_overwrite_a_refund_arrived_meanwhile(self):
        from .services import restore_released

        appointment = self._released()
        stale = Appointment.objects.get(pk=appointment.pk)
        Appointment.objects.filter(pk=appointment.pk).update(
            deposit_status=Appointment.DepositStatus.REFUND_DUE,
            deposit_payment_intent_id="pi_abc",
        )
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            restore_released(stale)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUND_DUE)
        self.assertEqual(appointment.deposit_payment_intent_id, "pi_abc")


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
        from .services import edit_appointment

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


class WaitlistTests(AgendaTestBase):
    """Lista d'attesa: iscrizione, elenco, cancellazione e abbinamento allo slot libero."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_client_tokens

        self.client_auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"
        }
        user = User.objects.create_user(email="desk@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.staff_auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

    def _subscribe(self, body):
        return self.client.post(
            "/api/agenda/client/waitlist",
            data=json.dumps(body),
            content_type="application/json",
            **self.client_auth,
        )

    def test_subscribe_list_and_leave(self):
        res = self._subscribe({"service_id": self.svc60.id, "preference": "morning"})
        self.assertEqual(res.status_code, 200, res.content)
        entry_id = res.json()["id"]
        self.assertEqual(res.json()["status"], WaitlistEntry.Status.ACTIVE)

        listed = self.client.get("/api/agenda/waitlist", **self.staff_auth)
        self.assertEqual([e["id"] for e in listed.json()], [entry_id])
        self.assertEqual(listed.json()[0]["client_name"], self.client_obj.full_name)

        marked = self.client.post(
            f"/api/agenda/waitlist/{entry_id}/contacted", **self.staff_auth
        )
        self.assertEqual(marked.json()["status"], WaitlistEntry.Status.CONTACTED)
        self.assertEqual(self.client.get("/api/agenda/waitlist", **self.staff_auth).json(), [])

        gone = self.client.delete(
            f"/api/agenda/client/waitlist/{entry_id}", **self.client_auth
        )
        self.assertEqual(gone.status_code, 200, gone.content)
        self.assertFalse(WaitlistEntry.objects.filter(id=entry_id).exists())
        # la cancellazione lascia traccia: l'operatrice sa perché è sparita
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="waitlist.deleted").exists()
        )

    def test_bad_preference_and_bad_days_are_refused(self):
        self.assertEqual(
            self._subscribe({"service_id": self.svc60.id, "preference": "quandocapita"}).status_code,
            400,
        )
        self.assertEqual(
            self._subscribe(
                {"service_id": self.svc60.id, "preference": "exact", "exact_days": [9]}
            ).status_code,
            400,
        )

    def test_a_freed_slot_names_the_people_waiting_for_that_service(self):
        mine = WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc60, operator=self.op1
        )
        any_operator = WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc60
        )
        other_service = WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc30
        )
        contacted = WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc60,
            status=WaitlistEntry.Status.CONTACTED,
        )
        with self._windows({self.op1.id: [(9 * 60, 18 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            cancel_appointment(appointment)
        freed = OutboxEvent.objects.filter(event_type="slot.freed").latest("id")
        self.assertEqual(
            set(freed.payload["matching_waitlist"]), {mine.id, any_operator.id}
        )
        self.assertNotIn(other_service.id, freed.payload["matching_waitlist"])
        self.assertNotIn(contacted.id, freed.payload["matching_waitlist"])


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


class ReadEndpointsTests(AgendaTestBase):
    """Permessi e limiti delle rotte di lettura dell'agenda."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="mag@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Magazzino", scopes=["inventory"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }

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


class RequestValidationTests(AgendaTestBase):
    """Richieste malformate: risposta di validazione, non 500."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="val@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }

    def _post(self, path, body):
        return self.client.post(
            path, data=json.dumps(body), content_type="application/json", **self.auth
        )

    def test_a_start_without_timezone_is_refused(self):
        res = self._post(
            "/api/agenda/appointments",
            {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc60.id}],
                "start": f"{self.day.isoformat()}T10:00:00",  # senza offset
            },
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Appointment.objects.exists())

    def test_a_reason_longer_than_the_column_is_refused(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
        res = self._post(
            f"/api/agenda/appointments/{appointment.id}/cancel", {"reason": "x" * 300}
        )
        self.assertEqual(res.status_code, 422, res.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)

    def test_too_many_services_in_one_request_are_refused(self):
        res = self._post(
            "/api/agenda/appointments",
            {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc60.id}] * 50,
                "start": _aware(self.day, 10).isoformat(),
            },
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Appointment.objects.exists())

    def test_a_pause_can_be_created_moved_and_removed(self):
        created = self._post(
            "/api/agenda/pauses",
            {
                "operator_id": self.op1.id,
                "start": _aware(self.day, 12).isoformat(),
                "duration_min": 30,
                "note": "pranzo",
            },
        )
        self.assertEqual(created.status_code, 200, created.content)
        pause_id = created.json()["id"]
        moved = self.client.put(
            f"/api/agenda/pauses/{pause_id}",
            data=json.dumps({
                "operator_id": self.op1.id,
                "start": _aware(self.day, 13).isoformat(),
                "duration_min": 45,
                "note": "pranzo lungo",
            }),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        self.assertEqual(moved.json()["duration_min"], 45)
        self.assertEqual(moved.json()["note"], "pranzo lungo")
        pause = Pause.objects.get(pk=pause_id)
        self.assertEqual(timezone.localtime(pause.start).hour, 13)
        gone = self.client.delete(f"/api/agenda/pauses/{pause_id}", **self.auth)
        self.assertEqual(gone.status_code, 200, gone.content)
        self.assertFalse(Pause.objects.exists())

    def test_a_pause_note_longer_than_the_column_is_refused(self):
        res = self._post(
            "/api/agenda/pauses",
            {
                "operator_id": self.op1.id,
                "start": _aware(self.day, 12).isoformat(),
                "duration_min": 30,
                "note": "n" * 300,
            },
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(Pause.objects.exists())


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
