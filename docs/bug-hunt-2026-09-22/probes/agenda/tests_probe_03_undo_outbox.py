"""Probe temporanei del revisore 03 (torna indietro + messaggi trattenuti). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.test import override_settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import ActivityLog, DepositRule, OutboxEvent
from common.auth import create_staff_tokens

from .models import Appointment, WaitlistEntry
from .services import cancel_appointment, create_appointment, edit_appointment, move_appointment
from .tests import AgendaTestBase, _aware


class ProbeBase(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda", "sales"])
        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        Membership.objects.create(user=self.user, salon=self.salon, role=self.role)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }

    def _book(self, hour=10):
        return create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, hour), via="dashboard", actor=self.user,
        )

    def _undo(self, body=None):
        return self.client.post(
            "/api/agenda/undo", data=json.dumps(body or {}),
            content_type="application/json", **self.auth,
        )

    def _all_sent(self):
        """La conferma (e tutto quello che c'era) è partita da un pezzo."""
        OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).update(
            status=OutboxEvent.Status.SENT, sent_at=timezone.now(), attempts=1
        )

    def _pending(self, key_prefix="appointment:"):
        return list(
            OutboxEvent.objects.filter(
                status=OutboxEvent.Status.PENDING, coalesce_key__startswith=key_prefix
            ).order_by("id")
        )


class UndoDropsEarlierHeldChanges(ProbeBase):
    def test_move_move_undo_loses_the_first_move(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()  # prenotata giorni fa: la cliente sa «alle 10»
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)  # A -> B
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)  # B -> C (sbaglio)
            res = self._undo()  # torna a B
        self.assertEqual(res.status_code, 200, res.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 14))
        pending = self._pending()
        # ATTESO: resta un evento che dice alla cliente «spostato alle 14».
        self.assertTrue(pending, "nessun evento: la cliente crede ancora alle 10")

    def test_move_edit_undo_edit_loses_the_move(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            edit_appointment(appointment, note="nota sbagliata", actor=self.user)
            res = self._undo()  # annulla SOLO la nota
        self.assertEqual(res.status_code, 200, res.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.start, _aware(self.day, 14))
        self.assertTrue(self._pending(), "lo spostamento alle 14 non parte più")

    def test_move_cancel_undo_cancel_loses_the_move(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            cancel_appointment(appointment, reason="dito scivolato", actor=self.user)
            res = self._undo()  # annulla l'annullamento
        self.assertEqual(res.status_code, 200, res.content)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        self.assertEqual(appointment.start, _aware(self.day, 14))
        self.assertTrue(self._pending(), "lo spostamento alle 14 non parte più")


class FreedSlotMerge(ProbeBase):
    def test_two_moves_announce_the_wrong_slot(self):
        WaitlistEntry.objects.create(
            salon=self.salon, client=self.client_obj, service=self.svc60,
        )
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        freed = [
            parse_datetime(e.payload["start"])
            for e in self._pending("slot:")
        ]
        # ATTESO: le 10 (occupate da giorni, ora libere). Le 14 erano libere prima.
        self.assertIn(_aware(self.day, 10), freed, f"annunciati: {freed}")


class MovedPayloadAfterMerge(ProbeBase):
    def test_old_start_is_the_intermediate_one(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertEqual(parse_datetime(event.payload["old_start"]), _aware(self.day, 10))

    def test_moved_then_edited_loses_old_start(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            edit_appointment(appointment, note="ciao", actor=self.user)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertIn("old_start", event.payload)

    def test_late_undo_of_a_move_sends_moved_without_old_start(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            self._all_sent()  # lo spostamento è partito
            res = self._undo()
        self.assertEqual(res.status_code, 200, res.content)
        (event,) = self._pending()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertIn("old_start", event.payload)


class UndoCreateWithDepositLink(ProbeBase):
    def test_link_stays_open_and_payment_is_lost(self):
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appointment = self._book(10)
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REQUIRED)
        # _maybe_deposit_link: link creato e messaggio partito (mai trattenuto)
        Appointment.objects.filter(id=appointment.id).update(
            deposit_payment_link="https://checkout.stripe.test/c/pay/cs_1",
            deposit_checkout_session_id="cs_1",
        )
        with patch("apps.sales.stripe_service.expire_deposit_checkout") as expire:
            res = self._undo()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(Appointment.objects.filter(id=appointment.id).exists())
        # la sessione di pagamento resta aperta
        self.assertFalse(expire.called)
        # la cliente paga il link ricevuto: il webhook lo scarta in silenzio
        from apps.sales.api import _payment_intent_succeeded

        before = ActivityLog.objects.count()
        _payment_intent_succeeded(
            {"id": "pi_1", "amount_received": 1000},
            {"appointment_id": str(appointment.id), "salon_id": str(self.salon.id), "kind": "deposit"},
        )
        self.assertEqual(ActivityLog.objects.count(), before)  # nessuna traccia, nessun rimborso
        self.fail("undo della creazione con link caparra: sessione aperta, pagamento perso")


class UndoNoShowAfterCharge(ProbeBase):
    def test_undo_no_show_after_the_card_was_charged(self):
        from apps.sales.models import Sale
        from apps.sales.services import record_no_show_charge

        from .services import mark_no_show

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            mark_no_show(appointment, reason="non venuta", actor=self.user)
        # addebito no-show: carta addebitata e vendita registrata (sales.api.charge_no_show)
        Appointment.objects.filter(id=appointment.id).update(no_show_payment_intent_id="pi_ns")
        sale = record_no_show_charge(self.salon, appointment, amount=Decimal("50.00"), actor=self.user)
        self.assertIsNotNone(sale)
        res = self._undo()
        appointment.refresh_from_db()
        # ATTESO: 409 («il conto è in cassa»)
        self.assertEqual(
            res.status_code, 409,
            f"undo passato: stato={appointment.status}, vendita no-show ancora agganciata="
            f"{Sale.objects.filter(appointment=appointment).exists()}",
        )


class ClaimVersusMerge(ProbeBase):
    @override_settings(YOURANG_API_URL="https://yourang.test/hook", YOURANG_API_KEY="k")
    def test_worker_sends_the_stale_payload_and_overwrites_the_merge(self):
        from apps.core.management.commands.flush_outbox import _claim, deliver_event

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            # il worker ha letto l'evento (senza lock) nell'istante in cui la
            # trattenuta scadeva...
            stale = OutboxEvent.objects.select_related("salon").get(event_type="appointment.created")
            # ...e intanto al banco si corregge l'orario: la fusione vede
            # l'evento ancora trattenuto e ci scrive dentro le 16
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        merged = OutboxEvent.objects.get(id=stale.id)
        self.assertEqual(parse_datetime(merged.payload["start"]), _aware(self.day, 16))
        self.assertGreater(merged.next_attempt_at, timezone.now())  # trattenuto di nuovo

        sent = []

        class FakeResponse:
            status_code = 200
            text = "ok"

        class FakeClient:
            def post(self, url, json=None, headers=None):
                sent.append(json)
                return FakeResponse()

        self.assertTrue(_claim(stale), "il claim non ricontrolla la trattenuta")
        deliver_event(stale, client=FakeClient())
        self.assertEqual(len(sent), 1)
        after = OutboxEvent.objects.get(id=stale.id)
        self.assertEqual(
            parse_datetime(sent[0]["payload"]["start"]), _aware(self.day, 16),
            f"partito con le {sent[0]['payload']['start']}; a db ora: {after.payload['start']} ({after.status})",
        )


class AppCancelWithinHold(ProbeBase):
    def test_waitlist_joined_while_slot_was_taken_is_never_told(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="app",
            )
            # un'altra cliente non trova posto e si mette in lista d'attesa
            WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
            cancel_appointment(appointment, by_client=True)
        self.assertTrue(
            OutboxEvent.objects.filter(event_type="slot.freed").exists(),
            "slot.freed mai emesso: chi si è messa in lista d'attesa non lo saprà",
        )


class StaffCancelsAppBookingWithinHold(ProbeBase):
    def test_client_booked_in_app_is_not_told(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="app",
            )
            # la cliente ha visto «prenotato» nell'app; il salone la annulla subito
            cancel_appointment(appointment, reason="operatrice malata", actor=self.user)
        self.assertTrue(
            OutboxEvent.objects.filter(
                status=OutboxEvent.Status.PENDING, event_type="appointment.cancelled"
            ).exists(),
            "nessun messaggio di annullamento a chi ha prenotato dall'app",
        )


class DelaySwitchedOffWithHeldEvents(ProbeBase):
    def test_the_correction_overtakes_the_stale_confirmation(self):
        from apps.core.models import SalonSettings

        SalonSettings.objects.update_or_create(salon=self.salon, defaults={"automation_delay_seconds": 30})
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            # il titolare passa a «Subito» mentre la conferma è ancora ferma
            SalonSettings.objects.filter(salon=self.salon).update(automation_delay_seconds=0)
            move_appointment(appointment, _aware(self.day, 16), actor=self.user)
        created = OutboxEvent.objects.get(event_type="appointment.created")
        moved = OutboxEvent.objects.get(event_type="appointment.moved")
        # lo spostamento parte subito, la conferma (con le 10) 30 s dopo
        self.assertIsNone(moved.next_attempt_at)
        self.assertGreater(created.next_attempt_at, timezone.now())
        self.assertEqual(parse_datetime(created.payload["start"]), _aware(self.day, 16),
                         "la conferma che parte per ultima porta ancora le 10")


class PanelUndoIsAReverseForcedMove(ProbeBase):
    def test_reverse_move_sends_a_phantom_move_and_marks_forced(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            self._all_sent()
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            # «Annulla» del pannello: applyMove al contrario con force=true
            move_appointment(appointment, _aware(self.day, 10), actor=self.user, force=True)
        appointment.refresh_from_db()
        pending = self._pending()
        self.assertEqual(appointment.start, _aware(self.day, 10))
        self.assertEqual(
            pending, [],
            f"forced={appointment.forced}; parte comunque: "
            f"{[(e.event_type, e.payload.get('old_start'), e.payload['start']) for e in pending]}; "
            f"slot annunciati: {[e.payload['start'] for e in self._pending('slot:')]}",
        )


class StaleItemIdsAfterUndo(ProbeBase):
    def test_edit_with_ids_seen_before_the_undo_reprices_the_visit(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            old_item = appointment.items.get()
            self.svc60.price = Decimal("65.00")  # listino aggiornato dopo la prenotazione
            self.svc60.save(update_fields=["price"])
            move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            self.assertEqual(self._undo().status_code, 200)
            # il pannello aperto (o l'altra postazione) ha ancora l'id di prima
            edit_appointment(
                appointment,
                items=[{"id": old_item.id, "service_id": self.svc60.id, "operator_id": self.op1.id,
                        "duration_min": 75}],
                actor=self.user,
            )
        item = appointment.items.get()
        self.assertEqual(item.price, Decimal("50.00"), f"prezzo diventato {item.price}")


class UndoFreesASlotSilently(ProbeBase):
    def test_undo_of_a_known_booking_frees_the_slot_without_telling_the_waitlist(self):
        WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            self._book(10)
            self._all_sent()  # la conferma è partita: lo slot era occupato per tutti
            self.assertEqual(self._undo().status_code, 200)
        self.assertTrue(
            OutboxEvent.objects.filter(event_type="slot.freed").exists(),
            "lo slot delle 10 si è liberato ma la lista d'attesa non lo saprà",
        )


class UndoCancelAfterAutomaticRefund(ProbeBase):
    def test_message_blames_a_colleague(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appointment = self._book(10)
            Appointment.objects.filter(id=appointment.id).update(
                deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("10.00"),
                deposit_payment_intent_id="pi_dep",
            )
            with patch(
                "apps.sales.stripe_service.refund_deposit",
                return_value={"id": "re_1", "amount": 1000, "status": "succeeded"},
            ):
                cancel_appointment(appointment, reason="dito scivolato", actor=self.user)
            res = self._undo()
        self.assertEqual(res.status_code, 200, res.json())


class ReleaseWhileAMoveIsHeld(ProbeBase):
    def test_moved_goes_out_after_the_release(self):
        from apps.core.models import SalonSettings

        from .services import process_deposit_holds

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"deposit_hold_minutes": 30, "automation_delay_seconds": 30}
        )
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        with patch("apps.sales.stripe_service.payments_enabled", return_value=True):
            with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
                with patch("apps.clients.services.client_facts", return_value={}):
                    appointment = self._book(10)
                self._all_sent()
                move_appointment(appointment, _aware(self.day, 14), actor=self.user)
            Appointment.objects.filter(id=appointment.id).update(
                deposit_due_at=timezone.now() - dt.timedelta(seconds=1)
            )
            process_deposit_holds(self.salon)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CANCELLED)
        self.assertEqual(
            [e.event_type for e in self._pending()], [],
            "resta in coda uno «spostato» che partirà DOPO «posto liberato»",
        )
