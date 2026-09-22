"""PROBE TEMPORANEO revisore 02 (ciclo di vita dell'appuntamento). Da cancellare.

Ogni test asserisce il comportamento CORRETTO: se fallisce, il difetto c'è.
"""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone
from django.utils.dateparse import parse_datetime
from ninja.errors import HttpError

from apps.core.models import DepositRule, OutboxEvent, Salon, SalonSettings
from common.auth import create_client_tokens, create_staff_tokens

from .models import Appointment, AppointmentService
from .services import (
    cancel_appointment,
    create_appointment,
    move_appointment,
)
from .tests import AgendaTestBase, _aware


def _staff(salon, email="probe02@theparlour.it", scopes=("agenda", "sales")):
    from apps.accounts.models import Membership, Role, User

    user = User.objects.create_user(email=email, password="x" * 10)
    role = Role.objects.create(salon=salon, name=f"R {email}", scopes=list(scopes))
    Membership.objects.create(user=user, salon=salon, role=role)
    auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}
    return user, auth


class P01InactiveColumn(AgendaTestBase):
    def test_reassign_from_deactivated_operator_column(self):
        from apps.staff.models import Operator

        self.op2.services.add(self.svc60, self.svc30)
        wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}
        with self._windows(wide):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
        Operator.objects.filter(pk=self.op1.pk).update(active=False)
        user, auth = _staff(self.salon)
        with self._windows(wide):
            # quello che mandano griglia, settimana e pannello: colonna di partenza = op1
            res = self.client.post(
                f"/api/agenda/appointments/{appt.id}/move",
                data=json.dumps({
                    "start": appt.start.isoformat(),
                    "operator_id": self.op2.id,
                    "from_operator_id": self.op1.id,
                }),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)


class P02HoldAfterMove(AgendaTestBase):
    def setUp(self):
        SalonSettings.objects.create(salon=self.salon, deposit_hold_minutes=24 * 60)
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def test_moving_a_last_minute_booking_later_does_not_release_it_at_the_old_time(self):
        from .services import process_deposit_holds

        start = timezone.now() + dt.timedelta(hours=2)
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appt = create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    start, via="dashboard", force=True,
                )
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_due_at, appt.start)  # scadenza tagliata all'inizio
        # la cliente chiama: «spostami a martedì prossimo»
        move_appointment(appt, _aware(self.day, 10), force=True)
        result = process_deposit_holds(self.salon, now=start + dt.timedelta(minutes=1))
        appt.refresh_from_db()
        self.assertEqual(result["released"], 0, "rilasciato all'ora del VECCHIO appuntamento")
        self.assertEqual(appt.status, Appointment.Status.CONFIRMED)


class P03ShrinkThenStripeRefund(AgendaTestBase):
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
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=deposit,
            deposit_payment_intent_id="pi_probe",
        )
        appointment.refresh_from_db()
        return appointment

    def test_refunding_the_excess_on_stripe_does_not_eat_the_credit_twice(self):
        from .services import record_deposit_refund, split_appointment

        appointment = self._paid_visit(Decimal("70.00"))  # totale 80, caparra 70 pagata
        first = appointment.items.order_by("order").first()  # servizio da 50
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, created = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        self.assertEqual(original.deposit_amount, Decimal("30.00"))  # «40 € da rimborsare»
        # lo staff fa quello che dice il registro: rimborsa i 40 su Stripe
        record_deposit_refund(original, refund_id="re_excess", cents=4000, status="succeeded")
        original.refresh_from_db()
        # la cliente ha versato 70, ne ha riavuti 40: in cassa restano 30, pari alla visita
        self.assertEqual(original.deposit_credit, Decimal("30.00"))

    def test_without_manual_refund_checkout_refunds_nothing(self):
        from .services import split_appointment

        appointment = self._paid_visit(Decimal("70.00"))
        first = appointment.items.order_by("order").first()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, created = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        # al checkout: credito detraibile e totale del conto
        total = original.total_price
        credit = original.deposit_credit
        excess_seen_by_checkout = credit - min(credit, total)
        # la cliente ha versato 70 per due visite che ora valgono 30 + 50 (la staccata
        # non ha caparra): 40 sono suoi. Il checkout dovrebbe vederli.
        self.assertEqual(excess_seen_by_checkout, Decimal("40.00"))


class P04ShrinkWhileRequired(AgendaTestBase):
    def test_old_link_amount_is_accepted_and_the_overpayment_is_lost(self):
        from apps.sales.api import _apply_deposit_payment
        from apps.sales.models import Sale

        from .services import split_appointment

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
            deposit_status=Appointment.DepositStatus.REQUIRED, deposit_amount=Decimal("70.00"),
            deposit_payment_link="https://checkout.stripe.test/old", deposit_checkout_session_id="cs_old",
        )
        appointment.refresh_from_db()
        first = appointment.items.order_by("order").first()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, _ = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        self.assertEqual(original.deposit_amount, Decimal("30.00"))
        self.assertEqual(original.deposit_payment_link, "https://checkout.stripe.test/old")  # link a 70
        # la cliente paga il link che ha in mano: 70 €
        outcome = _apply_deposit_payment(original, "pi_old_link", {"amount_received": 7000})
        original.refresh_from_db()
        sale = Sale.objects.filter(deposit_appointment=original).first()
        self.assertIsNotNone(sale)
        # incassati 70 su Stripe: la vendita-caparra (o un rimborso) deve render conto di 70
        self.assertEqual(sale.total, Decimal("70.00"), f"outcome={outcome}, registrati {sale.total}")


class P05NoShowStates(AgendaTestBase):
    def _book(self, start):
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            return create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                start, via="dashboard", force=True,
            )

    def test_no_show_refused_after_check_in(self):
        from .services import check_in, mark_no_show

        appt = self._book(timezone.now() - dt.timedelta(minutes=10))
        check_in(appt)
        with self.assertRaises(HttpError):
            mark_no_show(appt)

    def test_no_show_refused_before_the_start(self):
        from .services import mark_no_show

        appt = self._book(_aware(self.day, 15))  # fra una settimana
        with self.assertRaises(HttpError):
            mark_no_show(appt)


class P06FreedSlot(AgendaTestBase):
    def test_no_show_does_not_announce_a_past_slot(self):
        from .services import mark_no_show

        self._no_automation_delay()
        start = timezone.now() - dt.timedelta(hours=3)
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                start, via="dashboard", force=True,
            )
        mark_no_show(appt)
        freed = OutboxEvent.objects.filter(event_type="slot.freed").first()
        self.assertIsNone(
            freed, f"slot.freed per uno slot finito da ore: {freed and freed.payload}"
        )

    def test_a_quarter_hour_nudge_does_not_free_the_whole_visit(self):
        self._no_automation_delay()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard",
            )
            move_appointment(appt, _aware(self.day, 10, 15))
        freed = OutboxEvent.objects.filter(event_type="slot.freed").first()
        # 10:00-11:00 → 10:15-11:15: libero davvero c'è solo 10:00-10:15
        self.assertTrue(
            freed is None or freed.payload["duration_min"] <= 15,
            f"annunciato {freed and freed.payload}",
        )


class P07MergedEvents(AgendaTestBase):
    def setUp(self):
        self.user, self.auth = _staff(self.salon, email="merge@theparlour.it", scopes=("agenda",))

    def _book(self):
        return create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard", actor=self.user,
        )

    def test_two_moves_keep_the_time_the_client_knows(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 11), actor=self.user)
            move_appointment(appt, _aware(self.day, 12), actor=self.user)
        pending = OutboxEvent.objects.get(status=OutboxEvent.Status.PENDING, event_type="appointment.moved")
        self.assertEqual(parse_datetime(pending.payload["start"]), _aware(self.day, 12))
        # la cliente sa delle 10: il messaggio deve dire «dalle 10 alle 12»
        self.assertEqual(parse_datetime(pending.payload["old_start"]), _aware(self.day, 10))

    def test_move_then_resize_keeps_old_start(self):
        from .services import edit_appointment

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 12), actor=self.user)
            item = appt.items.get()
            edit_appointment(
                appt,
                items=[{"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id, "duration_min": 75}],
                actor=self.user,
            )
        pending = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).exclude(event_type="slot.freed")
        self.assertEqual(pending.count(), 1)
        event = pending.get()
        self.assertEqual(event.event_type, "appointment.moved")
        self.assertIn("old_start", event.payload, f"payload senza orario di prima: {sorted(event.payload)}")

    def test_move_cancel_undo_still_tells_the_client_about_the_move(self):
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 15), actor=self.user)
            cancel_appointment(appt, actor=self.user)
            res = self.client.post(
                "/api/agenda/undo", data="{}", content_type="application/json", **self.auth
            )
        self.assertEqual(res.status_code, 200, res.content)
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CONFIRMED)
        self.assertEqual(appt.start, _aware(self.day, 15))
        alive = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).exclude(event_type="slot.freed")
        # la cliente sa ancora delle 10: qualcuno deve dirle delle 15
        self.assertTrue(
            any(parse_datetime(e.payload.get("start")) == _aware(self.day, 15) for e in alive),
            f"in coda: {[(e.event_type, e.payload.get('start')) for e in alive]}",
        )


class P10UndoNoShowAfterCharge(AgendaTestBase):
    def test_undo_refused_once_the_no_show_is_charged(self):
        from apps.sales.services import record_no_show_charge

        from .services import mark_no_show

        user, auth = _staff(self.salon, email="ns@theparlour.it")
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                timezone.now() - dt.timedelta(minutes=30), via="dashboard", actor=user, force=True,
            )
        mark_no_show(appt, actor=user)
        # addebito no-show riuscito (quello che fa POST /sales/appointments/{id}/charge-no-show)
        Appointment.objects.filter(pk=appt.pk).update(no_show_payment_intent_id="pi_ns")
        appt.refresh_from_db()
        record_no_show_charge(self.salon, appt, amount=Decimal("50.00"), actor=user)
        res = self.client.post("/api/agenda/undo", data="{}", content_type="application/json", **auth)
        appt.refresh_from_db()
        self.assertEqual(
            res.status_code, 409,
            f"undo accettato: stato {appt.status}, addebito {appt.no_show_payment_intent_id}",
        )


class P11UndoCreateWithDepositLink(AgendaTestBase):
    def test_undo_of_a_booking_closes_the_payment_link(self):
        user, auth = _staff(self.salon, email="dl@theparlour.it")
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appt = create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    _aware(self.day, 10), via="dashboard", actor=user,
                )
        self.assertEqual(appt.deposit_status, Appointment.DepositStatus.REQUIRED)
        # link caparra già mandato (ensure_deposit_link in POST /appointments): campi fuori istantanea
        Appointment.objects.filter(pk=appt.pk).update(
            deposit_payment_link="https://checkout.stripe.test/x", deposit_checkout_session_id="cs_x",
        )
        with patch("apps.sales.stripe_service.expire_deposit_checkout") as expire:
            res = self.client.post("/api/agenda/undo", data="{}", content_type="application/json", **auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(Appointment.objects.filter(pk=appt.pk).exists())
        self.assertTrue(expire.called, "la sessione Stripe della caparra resta pagabile")

    def test_payment_of_a_deleted_booking_is_refunded(self):
        from apps.sales.api import _payment_intent_succeeded

        with patch("apps.sales.stripe_service.refund_payment_intent") as refund:
            _payment_intent_succeeded(
                {"id": "pi_ghost", "amount_received": 1000},
                {"appointment_id": "999999", "kind": "deposit", "salon_id": str(self.salon.id)},
            )
        self.assertTrue(refund.called, "pagamento di un appuntamento sparito: nessun rimborso")


class P12ClientMoveInactiveOperator(AgendaTestBase):
    def test_client_can_move_to_a_slot_the_app_offered(self):
        from apps.staff.models import Operator

        self.op2.services.add(self.svc60, self.svc30)
        mapping = {self.op1.id: [(9 * 60, 12 * 60)], self.op2.id: [(9 * 60, 18 * 60)]}
        start = _aware(self.day, 10)
        with self._windows(mapping):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                start, via="app",
            )
        Operator.objects.filter(pk=self.op1.pk).update(active=False)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"}
        target_day = self.day + dt.timedelta(days=1)
        with self._windows(mapping):
            res = self.client.get(
                "/api/agenda/client/availability",
                {"date": target_day.isoformat(), "items": "[]", "exclude_appointment_id": appt.id},
                **auth,
            )
            self.assertEqual(res.status_code, 200, res.content)
            offered = [s["start"] for s in res.json()]
            afternoon = next(s for s in offered if parse_datetime(s).astimezone(timezone.get_current_timezone()).hour >= 14)
            res = self.client.post(
                f"/api/agenda/client/appointments/{appt.id}/move",
                data=json.dumps({"start": afternoon}),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, f"orario proposto dall'app e poi rifiutato: {res.content}")


class P13ReleasedScope(AgendaTestBase):
    def test_released_list_needs_agenda_scope(self):
        user, auth = _staff(self.salon, email="mag@theparlour.it", scopes=("inventory",))
        res = self.client.get("/api/agenda/released", **auth)
        self.assertEqual(res.status_code, 403, res.content)


class P15ImmediateReminder(AgendaTestBase):
    def setUp(self):
        SalonSettings.objects.create(salon=self.salon, deposit_hold_minutes=60, deposit_reminder_minutes=30)
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def test_reminder_does_not_fire_right_after_a_last_minute_booking(self):
        from .services import process_deposit_holds

        now = timezone.now()
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    now + dt.timedelta(minutes=20), via="app", force=True,
                )
        result = process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=1))
        # «il sollecito parte dopo deposit_reminder_minutes» (30') dalla prenotazione
        self.assertEqual(result["reminded"], 0, "sollecito dopo un minuto dalla prenotazione")


class P16SplitShiftsTheRest(AgendaTestBase):
    def test_detaching_a_middle_service_leaves_the_others_where_they_were(self):
        from .services import split_appointment

        self.op2.services.add(self.svc60, self.svc30)
        wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}
        with self._windows(wide):
            visit = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},  # 10:00-11:00
                    {"service_id": self.svc30.id, "operator_id": self.op1.id},  # 11:00-11:30
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},  # 11:30-12:00 (op2)
                ],
                _aware(self.day, 10), via="dashboard",
            )
            from apps.clients.models import Client

            other = Client.objects.create(salon=self.salon, first_name="Anna", last_name="Neri", phone="+390000000009")
            create_appointment(
                self.salon, other,
                [{"service_id": self.svc30.id, "operator_id": self.op2.id}],
                _aware(self.day, 11), via="dashboard",
            )  # op2 occupata 11:00-11:30
            middle = visit.items.order_by("order")[1]
            # come fa la griglia: prima senza forzare, al 409 si forza
            try:
                split_appointment(visit, middle.id, _aware(self.day, 15), client_overlap_ok=True)
                forced = False
            except HttpError as err:
                self.assertEqual(err.status_code, 409)
                split_appointment(visit, middle.id, _aware(self.day, 15), force=True, client_overlap_ok=True)
                forced = True
        visit.refresh_from_db()
        items = list(visit.items.order_by("order"))
        offset = visit.start + dt.timedelta(minutes=items[0].duration_min + items[0].soak_min)
        # il servizio di op2 era alle 11:30 e l'anteprima lo lasciava lì
        self.assertEqual(
            timezone.localtime(offset).strftime("%H:%M"), "11:30",
            f"slittato su un'altra cliente (forzato={forced})",
        )


class P17UndoEatsEarlierMessages(AgendaTestBase):
    def setUp(self):
        self.user, self.auth = _staff(self.salon, email="undo17@theparlour.it", scopes=("agenda",))

    def _book(self):
        return create_appointment(
            self.salon, self.client_obj,
            [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, 10), via="dashboard", actor=self.user,
        )

    def _undo(self):
        return self.client.post("/api/agenda/undo", data="{}", content_type="application/json", **self.auth)

    def _alive_about(self, when):
        alive = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).exclude(event_type="slot.freed")
        return [e for e in alive if parse_datetime(e.payload.get("start")) == when], list(
            alive.values_list("event_type", "status")
        )

    def test_move_resize_undo_resize(self):
        from .services import edit_appointment

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 15), actor=self.user)
            item = appt.items.get()
            edit_appointment(
                appt,
                items=[{"id": item.id, "service_id": self.svc60.id, "operator_id": self.op1.id, "duration_min": 75}],
                actor=self.user,
            )
            res = self._undo()  # annulla SOLO l'allungamento
        self.assertEqual(res.status_code, 200, res.content)
        appt.refresh_from_db()
        self.assertEqual(appt.start, _aware(self.day, 15))  # lo spostamento resta
        about, alive = self._alive_about(_aware(self.day, 15))
        self.assertTrue(about, f"nessun messaggio sullo spostamento alle 15 (in coda: {alive})")

    def test_move_checkin_undo_checkin(self):
        from .services import check_in

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = self._book()
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 15), actor=self.user)
            check_in(appt, actor=self.user)
            res = self._undo()  # annulla SOLO il check-in
        self.assertEqual(res.status_code, 200, res.content)
        appt.refresh_from_db()
        self.assertEqual(appt.start, _aware(self.day, 15))
        about, alive = self._alive_about(_aware(self.day, 15))
        self.assertTrue(about, f"nessun messaggio sullo spostamento alle 15 (in coda: {alive})")


class P19FreedSlotWrongOperator(AgendaTestBase):
    def test_column_change_announces_the_operator_who_is_actually_free(self):
        from apps.staff.models import Operator

        op3 = Operator.objects.create(salon=self.salon, first_name="Sara", last_name="Blu", color="#CCCCCC")
        self.op2.services.add(self.svc60, self.svc30)
        op3.services.add(self.svc60, self.svc30)
        self._no_automation_delay()
        wide = {o.id: [(8 * 60, 20 * 60)] for o in (self.op1, self.op2, op3)}
        with self._windows(wide):
            visit = create_appointment(
                self.salon, self.client_obj,
                [
                    {"service_id": self.svc60.id, "operator_id": self.op1.id},
                    {"service_id": self.svc30.id, "operator_id": self.op2.id},
                ],
                _aware(self.day, 10), via="dashboard",
            )
            # il gruppo di op2 passa a op3, stesso orario
            move_appointment(visit, visit.start, operator=op3, from_operator=self.op2)
        freed = OutboxEvent.objects.get(event_type="slot.freed")
        # si è liberata op2 (11:00-11:30), non op1
        self.assertEqual(freed.payload["operator_id"], self.op2.id, freed.payload)


class P20ReleaseWhileMoveHeld(AgendaTestBase):
    def setUp(self):
        SalonSettings.objects.create(salon=self.salon, deposit_hold_minutes=30)
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def test_release_does_not_leave_a_move_message_behind(self):
        from .services import process_deposit_holds

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appt = create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    _aware(self.day, 10), via="app",
                )
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 15))  # trattenuto 30 s
        appt.refresh_from_db()
        process_deposit_holds(self.salon, now=appt.deposit_due_at + dt.timedelta(seconds=1))
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CANCELLED)
        alive = set(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).values_list("event_type", flat=True)
        )
        self.assertNotIn("appointment.moved", alive, f"dopo «posto liberato» parte anche lo spostamento: {alive}")


class P21RefundLeavesTheTill(AgendaTestBase):
    def test_a_refunded_deposit_is_not_cash_in(self):
        from apps.sales.services import today_summary

        from .services import mark_deposit_cashed, mark_deposit_refunded

        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("20.00")
        )
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appt = create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    _aware(self.day, 10), via="dashboard",
                )
        mark_deposit_cashed(appt, method="cash")          # 20 € in contanti al banco
        cancel_appointment(appt, reason="imprevisto")     # il salone annulla: da rimborsare
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_status, Appointment.DepositStatus.REFUND_DUE)
        mark_deposit_refunded(appt)                       # 20 € restituiti dalla cassa
        summary = today_summary(self.salon)
        self.assertEqual(summary["cash_in"], Decimal("0.00"), summary)


class P22UndoOntoANewBooking(AgendaTestBase):
    def test_undoing_a_move_does_not_land_on_a_client_booked_meanwhile(self):
        from apps.clients.models import Client

        user, auth = _staff(self.salon, email="undo22@theparlour.it", scopes=("agenda",))
        other = Client.objects.create(salon=self.salon, first_name="Anna", last_name="Neri", phone="+390000000007")
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard", actor=user,
            )
            move_appointment(appt, _aware(self.day, 15), actor=user)
            # nel frattempo l'app (o una collega) prenota Anna alle 10, ora libere
            create_appointment(
                self.salon, other,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="app",
            )
            res = self.client.post("/api/agenda/undo", data="{}", content_type="application/json", **auth)
        active_at_10 = Appointment.objects.filter(
            start=_aware(self.day, 10), status=Appointment.Status.CONFIRMED
        ).count()
        self.assertTrue(
            res.status_code == 409 or active_at_10 == 1,
            f"undo {res.status_code}: {active_at_10} clienti con op1 alle 10",
        )


class P23EditSameClientOverlap(AgendaTestBase):
    def test_resizing_next_to_the_same_client_is_not_forced(self):
        from .services import edit_appointment

        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                _aware(self.day, 10), via="dashboard", client_overlap_ok=True,
            )
            second = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc30.id, "operator_id": self.op1.id}],
                _aware(self.day, 10, 30), via="dashboard", client_overlap_ok=True,
            )
            self.assertFalse(second.forced)
            item = second.items.get()
            # come la griglia: prima senza forzare, al 409 si forza
            try:
                edit_appointment(second, items=[{"id": item.id, "service_id": self.svc30.id, "operator_id": self.op1.id, "duration_min": 40}])
            except HttpError as err:
                self.assertEqual(err.status_code, 409)
                edit_appointment(second, items=[{"id": item.id, "service_id": self.svc30.id, "operator_id": self.op1.id, "duration_min": 40}], force=True)
        second.refresh_from_db()
        self.assertFalse(second.forced, "allungare accanto alla stessa cliente la marca «forzata»")


class P24CheckInBackwards(AgendaTestBase):
    def test_check_in_does_not_undo_an_in_progress_treatment(self):
        from .services import check_in, start_appointment

        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                timezone.now(), via="dashboard", force=True,
            )
        start_appointment(appt)
        try:
            check_in(appt)  # seconda postazione con la scheda vecchia
        except HttpError:
            pass
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.IN_PROGRESS)


class P25PartialPendingRefund(AgendaTestBase):
    def test_a_pending_partial_refund_keeps_the_rest_deductible(self):
        from .services import record_deposit_refund

        appt = Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=_aware(self.day, 10),
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal("30.00"),
            deposit_payment_intent_id="pi_p",
        )
        record_deposit_refund(appt, refund_id="re_p", cents=1000, status="pending")
        appt.refresh_from_db()
        # 10 in restituzione, 20 restano del salone e vanno detratti al checkout
        self.assertEqual(appt.deposit_credit, Decimal("20.00"), appt.deposit_status)
