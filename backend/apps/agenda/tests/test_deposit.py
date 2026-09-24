"""Caparra lato agenda: calcolo, scadenza e sollecito, rilascio e ripristino, rimborsi."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import ActivityLog, DepositRule, OutboxEvent, Salon, SalonSettings
from common.auth import create_staff_tokens
from common.testing import aware

from ..models import Appointment, AppointmentService
from ..services import compute_deposit, create_appointment, get_free_slots
from .base import AgendaTestBase, RealShiftsTestBase, _aware


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
        from ..services import process_deposit_holds

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
        from ..services import process_deposit_holds, schedule_deposit_hold

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
        from ..services import process_deposit_holds

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
        from ..services import process_deposit_holds, released_appointments, restore_released

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
        from ..services import process_deposit_holds

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

        from ..services import process_deposit_holds

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
        from ..services import split_appointment

        appointment = self._paid_visit(Decimal("60.00"))  # totale 80, caparra 60
        first = appointment.items.order_by("order").first()  # il servizio da 50
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, created = split_appointment(
                appointment, first.id, _aware(self.day, 15)
            )
        original.refresh_from_db()
        self.assertEqual(original.total_price, Decimal("30.00"))
        # La caparra versata non si tocca (02-01): abbassarla faceva sparire
        # l'eccedenza dalla quota detraibile. Il checkout detrae fino al totale
        # e restituisce da sé i 30 in più.
        self.assertEqual(original.deposit_amount, Decimal("60.00"))
        self.assertEqual(original.deposit_credit, Decimal("60.00"))
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.excess")
        self.assertEqual(log.payload["amount"], "30.00")
        self.assertEqual(created.deposit_amount, Decimal("0.00"))

    def test_removing_a_service_brings_the_deposit_down_to_the_new_total(self):
        from ..services import edit_appointment

        appointment = self._paid_visit(Decimal("60.00"))
        first = appointment.items.order_by("order").first()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            edit_appointment(
                appointment,
                items=[{"id": first.id, "service_id": self.svc60.id, "operator_id": self.op1.id}],
            )
        appointment.refresh_from_db()
        self.assertEqual(appointment.total_price, Decimal("50.00"))
        # versata = incassata: resta 60, al checkout se ne detraggono 50 (02-01)
        self.assertEqual(appointment.deposit_amount, Decimal("60.00"))
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.excess").exists()
        )

    def test_a_deposit_that_still_fits_is_left_alone(self):
        from ..services import edit_appointment

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
        from ..services import record_deposit_refund

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
        from ..services import restore_released

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
        from ..services import restore_released

        appointment = self._released()
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            restore_released(appointment)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_payment_link, "")
        # l'id della sessione resta: serve a chiudere quella vecchia su Stripe
        self.assertEqual(appointment.deposit_checkout_session_id, "cs_old")

    def test_restoring_does_not_overwrite_a_refund_arrived_meanwhile(self):
        from ..services import restore_released

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


# ---- 02-18 + 04-05 + 10-09: /released chiede l'agenda -------------------------


class ReleasedScopeTests(RealShiftsTestBase):
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


# ---- 04-09: walk-in e visite registrate a posteriori ---------------------------


class DepositForPastStartTests(RealShiftsTestBase):
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


class DepositNetOfGiftCardsTests(RealShiftsTestBase):
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


class PaidDepositOnAShorterVisitTests(AgendaTestBase):
    """02-01, 05-06: ridurre la visita non fa perdere quello che la cliente ha versato."""

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
            deposit_payment_intent_id="pi_dep",
        )
        appointment.refresh_from_db()
        return appointment

    def _split_first(self, appointment):
        from ..services import split_appointment

        first = appointment.items.order_by("order").first()  # il servizio da 50
        with self._windows({self.op1.id: [(8 * 60, 20 * 60)]}):
            original, _created = split_appointment(appointment, first.id, _aware(self.day, 15))
        original.refresh_from_db()
        return original

    def test_the_checkout_still_sees_the_whole_excess(self):
        original = self._split_first(self._paid_visit(Decimal("70.00")))  # visita ora da 30
        self.assertEqual(original.deposit_amount, Decimal("70.00"))
        self.assertEqual(original.deposit_credit, Decimal("70.00"))
        # al conto si detraggono 30, i 40 in più tornano alla cliente
        self.assertEqual(original.deposit_credit - min(original.deposit_credit, original.total_price), Decimal("40.00"))
        log = ActivityLog.objects.get(salon=self.salon, type="deposit.excess")
        self.assertEqual(log.payload["amount"], "40.00")

    def test_refunding_the_excess_by_hand_does_not_eat_the_credit_twice(self):
        from ..services import record_deposit_refund

        original = self._split_first(self._paid_visit(Decimal("70.00")))
        # il titolare restituisce i 40 dalla dashboard Stripe
        record_deposit_refund(original, refund_id="re_excess", cents=4000, status="succeeded")
        original.refresh_from_db()
        # versati 70, tornati 40: in cassa ne restano 30, quanto la visita
        self.assertEqual(original.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(original.deposit_credit, Decimal("30.00"))

    def test_the_checkout_gives_the_excess_back(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        original = self._split_first(self._paid_visit(Decimal("70.00")))
        user = User.objects.create_user(email="cassa22@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa22", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        item = original.items.get()
        body = {
            "blocks": [{"operator_id": self.op1.id, "lines": [
                {"line_type": "service", "service_id": item.service_id, "qty": 1, "unit_price": str(item.price)},
            ]}],
            "payments": [],
        }
        refunded = {"id": "re_ex", "amount": 4000, "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self.client.post(
                f"/api/sales/checkout/{original.id}", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["sale"]["deposit_deducted"], "30.00")
        self.assertEqual(refund.call_args.kwargs["amount_cents"], 4000)
        original.refresh_from_db()
        self.assertEqual(original.deposit_refunded_amount, Decimal("40.00"))


class RefundEventsOrderTests(AgendaTestBase):
    """05-14, 02-21: lo stato della caparra non dipende dall'ordine degli eventi Stripe."""

    def _paid(self, amount="30.00"):
        return Appointment.objects.create(
            salon=self.salon, client=self.client_obj, operator=self.op1, start=_aware(self.day, 10),
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=Decimal(amount),
            deposit_payment_intent_id="pi_dep",
        )

    def test_a_late_pending_event_does_not_undo_a_succeeded_refund(self):
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="succeeded")
        # arriva in ritardo `refund.created`, con lo stato che aveva allora
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="pending")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("30.00"))

    def test_the_charge_refunded_total_is_remembered(self):
        from ..services import record_deposit_refund

        appointment = self._paid()
        # rimborso di 10 dalla dashboard Stripe: prima arriva `charge.refunded`…
        record_deposit_refund(appointment, floor_cents=1000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        # …poi il suo `refund.created`, che non lo conta una seconda volta
        record_deposit_refund(appointment, refund_id="re_dash", cents=1000, status="succeeded")
        # e un rimborso diverso che fallisce non tocca i 10 già restituiti
        record_deposit_refund(appointment, refund_id="re_2", cents=500, status="failed")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))

    def test_a_failure_after_charge_refunded_puts_the_money_back(self):
        """Il pavimento resta il massimo visto: un rimborso poi fallito non lo abbassa
        da solo. Prima la caparra restava «rimborsata» con i soldi ancora al salone."""
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, floor_cents=3000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDED)
        record_deposit_refund(appointment, refund_id="re_1", cents=3000, status="failed")
        appointment.refresh_from_db()
        # stato e importo insieme: niente restituito, la caparra torna detraibile
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("30.00"))
        self.assertTrue(
            ActivityLog.objects.filter(salon=self.salon, type="deposit.refund_update").exists()
        )

    def test_a_pending_refund_counted_in_charge_refunded_is_not_subtracted_twice(self):
        """Se Stripe conta nel totale del `charge.refunded` anche il rimborso in corso,
        la cassa detraeva 10 invece di 20 e il rimborso risultava già fatto."""
        from apps.sales.models import DepositRefund
        from apps.sales.services import deposit_retained

        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="pending")
        record_deposit_refund(appointment, floor_cents=1000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDING)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(deposit_retained(appointment), Decimal("20.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))
        self.assertFalse(DepositRefund.objects.filter(appointment=appointment).exists())
        # riuscito: dieci restituiti, una volta sola
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="succeeded")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.PAID)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("10.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))

    def test_a_whole_refund_still_pending_is_not_yet_refunded(self):
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_all", cents=3000, status="pending")
        record_deposit_refund(appointment, floor_cents=3000)
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_status, Appointment.DepositStatus.REFUNDING)
        self.assertEqual(appointment.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("0.00"))

    def test_a_partial_pending_refund_never_costs_the_client_the_rest(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        from ..models import AppointmentService
        from ..services import record_deposit_refund

        appointment = self._paid()
        AppointmentService.objects.create(
            appointment=appointment, service=self.svc60, operator=self.op1,
            duration_min=60, price=Decimal("50.00"),
        )
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="pending")
        appointment.refresh_from_db()
        user = User.objects.create_user(email="cassa25@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Cassa25", scopes=["sales"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        # la cassa vede la quota detraibile e incassa il resto del conto
        due = Decimal("50.00") - appointment.deposit_credit
        body = {
            "blocks": [{"operator_id": self.op1.id, "lines": [
                {"line_type": "service", "service_id": self.svc60.id, "qty": 1, "unit_price": "50.00"},
            ]}],
            "payments": [{"method": "cash", "amount": str(due)}] if due else [],
        }
        refunded = {"id": "re_rest", "amount": int((Decimal("20.00") - appointment.deposit_credit) * 100),
                    "status": "succeeded"}
        with patch("apps.sales.stripe_service.refund_payment_intent", return_value=refunded) as refund:
            res = self.client.post(
                f"/api/sales/checkout/{appointment.id}", data=json.dumps(body),
                content_type="application/json", **auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        deducted = Decimal(res.json()["sale"]["deposit_deducted"])
        # dei 30 versati: 10 stanno tornando, il resto è detratto o restituito qui
        given_back = Decimal(refund.call_args.kwargs["amount_cents"]) / 100 if refund.called else Decimal("0")
        self.assertEqual(deducted + given_back, Decimal("20.00"))

    def test_a_pending_partial_refund_leaves_the_rest_deductible(self):
        """02-21: con 10 € in restituzione la cassa detrae i 20 rimasti, non zero."""
        from ..services import record_deposit_refund

        appointment = self._paid()
        record_deposit_refund(appointment, refund_id="re_p", cents=1000, status="pending")
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))

    def test_a_refund_written_by_hand_is_not_counted_again(self):
        """Un rimborso scritto dall'admin senza la sua riga resta un rimborso."""
        from apps.sales.services import deposit_retained

        appointment = self._paid()
        Appointment.objects.filter(pk=appointment.pk).update(deposit_refunded_amount=Decimal("10.00"))
        appointment.refresh_from_db()
        self.assertEqual(deposit_retained(appointment), Decimal("20.00"))
        self.assertEqual(appointment.deposit_credit, Decimal("20.00"))


class DepositHoldFollowsTheVisitTests(AgendaTestBase):
    """02-04, 02-16: scadenza e sollecito seguono il termine vero, non un inizio che non c'è più."""

    def _settings(self, hold, reminder=0):
        from apps.core.models import DepositRule, Salon, SalonSettings

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"deposit_hold_minutes": hold, "deposit_reminder_minutes": reminder}
        )
        DepositRule.objects.create(
            salon=self.salon, name="Sempre", conditions={}, amount_type="fixed", amount=Decimal("10.00")
        )
        self.salon = Salon.objects.get(pk=self.salon.pk)
        enabled = patch("apps.sales.stripe_service.payments_enabled", return_value=True)
        enabled.start()
        self.addCleanup(enabled.stop)

    def _book(self, start):
        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            with patch("apps.clients.services.client_facts", return_value={}):
                appointment = create_appointment(
                    self.salon, self.client_obj,
                    [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
                    start, via="dashboard", force=True,
                )
        appointment.refresh_from_db()
        return appointment

    def _move(self, appointment, start):
        from ..services import move_appointment

        with self._windows({self.op1.id: [(0, 24 * 60)]}):
            move_appointment(appointment, start, force=True)
        appointment.refresh_from_db()

    def test_a_last_minute_booking_moved_later_is_not_released_at_the_old_time(self):
        from ..services import process_deposit_holds

        self._settings(hold=24 * 60)
        booked_at = timezone.now()
        start = booked_at + dt.timedelta(hours=2)
        appointment = self._book(start)
        self.assertEqual(appointment.deposit_due_at, appointment.start)  # tagliata all'inizio
        self._move(appointment, _aware(self.day, 10))  # «spostami a martedì prossimo»
        result = process_deposit_holds(self.salon, now=start + dt.timedelta(minutes=1))
        self.assertEqual(result["released"], 0)
        appointment.refresh_from_db()
        self.assertEqual(appointment.status, Appointment.Status.CONFIRMED)
        # la scadenza mostrata è di nuovo quella vera: 24 ore dalla prenotazione
        self.assertAlmostEqual(
            (appointment.deposit_due_at - booked_at).total_seconds(), 24 * 3600, delta=60
        )
        # e allo scadere delle 24 ore, se non paga, lo slot si libera
        result = process_deposit_holds(self.salon, now=booked_at + dt.timedelta(hours=24, minutes=1))
        self.assertEqual(result["released"], 1)

    def test_a_visit_moved_earlier_gets_the_deadline_cut_on_the_new_start(self):
        from ..services import process_deposit_holds

        self._settings(hold=24 * 60)
        appointment = self._book(_aware(self.day, 10))
        soon = timezone.now() + dt.timedelta(hours=2)
        self._move(appointment, soon)
        process_deposit_holds(self.salon, now=timezone.now())
        appointment.refresh_from_db()
        self.assertEqual(appointment.deposit_due_at, appointment.start)
        # a visita cominciata non la si libera più
        result = process_deposit_holds(self.salon, now=appointment.start + dt.timedelta(minutes=5))
        self.assertEqual(result["released"], 0)

    def test_a_deadline_from_before_the_fix_follows_the_move_too(self):
        from ..services import process_deposit_holds

        self._settings(hold=24 * 60)
        now = timezone.now()
        appointment = self._book(now + dt.timedelta(hours=2))
        # riga scritta prima di `deposit_hold_until`: solo la scadenza tagliata
        Appointment.objects.filter(pk=appointment.pk).update(deposit_hold_until=None)
        self._move(appointment, _aware(self.day, 10))
        result = process_deposit_holds(self.salon, now=now + dt.timedelta(hours=2, minutes=1))
        self.assertEqual(result["released"], 0)

    def test_no_reminder_right_after_a_last_minute_booking(self):
        from ..services import process_deposit_holds

        self._settings(hold=60, reminder=30)
        now = timezone.now()
        self._book(now + dt.timedelta(minutes=20))
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=1))["reminded"], 0)
        # il sollecito cadrebbe dopo la scadenza (all'inizio della visita): non parte
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=19))["reminded"], 0)

    def test_the_reminder_still_comes_when_it_falls_before_the_cut_deadline(self):
        from ..services import process_deposit_holds

        self._settings(hold=60, reminder=10)
        now = timezone.now()
        self._book(now + dt.timedelta(minutes=40))
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=5))["reminded"], 0)
        self.assertEqual(process_deposit_holds(self.salon, now=now + dt.timedelta(minutes=11))["reminded"], 1)
