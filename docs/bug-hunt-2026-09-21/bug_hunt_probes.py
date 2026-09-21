"""Bug-hunt probes — 21/09/2026.

Ogni test RIPRODUCE un comportamento sospetto: l'asserzione descrive quello che
il codice faceva il 21/09/2026, non quello che dovrebbe fare. Dati sintetici,
Stripe finto.

STORICO — tutti i difetti di questa tornata sono stati corretti (i dodici qui
riprodotti più B27, emerso durante le correzioni), quindi queste prove ORA
FALLISCONO: è la conferma che il comportamento è cambiato (l'unica che passa
ancora è P2c, che era già una controprova). Il file resta come documentazione di
quello che è stato trovato e di come è stato riprodotto; gli esiti di allora sono
in probe-results.log. I test di regressione, che asseriscono il comportamento
CORRETTO, vivono nelle suite delle app:

  B15  apps/agenda/tests.py    SplitCollisionTests
  B16  apps/agenda/tests.py    BugHunt21SeptemberTests
  B17  apps/sales/tests.py     BugHunt21SeptemberTests
  B18  apps/agenda/tests.py    BugHunt21SeptemberTests
  B19  apps/dashboard/test/agenda-lib.test.js  (npm test)
  B20  nessun test: il badge del trascinamento sta dentro il JSX di DayGrid
  B21  apps/agenda/tests.py    BugHunt21SeptemberTests
  B22  apps/insights/tests.py  OccupancyAfterStaffChangesTests
  B23  apps/dashboard/test/agenda-lib.test.js  (npm test)
  B24  apps/agenda/tests.py    BugHunt21SeptemberTests
  B25  apps/sales/tests.py     BugHunt21SeptemberTests
  B26  apps/marketing/tests.py LoyaltyRewardIssueTests

Esecuzione (dalla cartella backend/):
  PYTHONPATH=../docs/bug-hunt-2026-09-21 \
  DATABASE_URL=sqlite:////tmp/beauty-bughunt.sqlite3 \
    .venv/bin/python manage.py test bug_hunt_probes --noinput

Le prove frontend stanno accanto a questo file: agenda-probes.test.js.
"""
import datetime as dt
import json
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.accounts.models import Membership, User
from apps.agenda.models import Appointment, AppointmentService, WaitlistEntry
from apps.agenda import services as agenda_services
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Location, Salon, SalonSettings
from apps.staff.models import Operator, WeeklyShift
from common.auth import create_staff_tokens, create_client_tokens


class Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="Probe", slug="probe")
        self.settings = SalonSettings.objects.create(
            salon=self.salon,
            agenda_fill="free",
            slot_interval_min=15,
            # apertura 09:00–18:00 tutti i giorni
            opening_hours_week={str(d): [["09:00", "18:00"]] for d in range(7)},
        )
        self.location = Location.objects.create(salon=self.salon, name="Sede", is_default=True)
        self.customer = Client.objects.create(
            salon=self.salon, first_name="Prova", last_name="Sintetica", phone="+393330000001"
        )
        self.user = User.objects.create_user(email="probe@example.test", password="Probe-Password-123")
        Membership.objects.create(salon=self.salon, user=self.user, is_owner=True)
        self.headers = {"HTTP_AUTHORIZATION": "Bearer " + create_staff_tokens(self.user, self.salon)["access"]}
        self.category = ServiceCategory.objects.create(salon=self.salon, name_it="Cat")
        self.op = self.make_operator("Giulia")
        self.op2 = self.make_operator("Marta")
        self.svc_a = self.make_service("Taglio", duration=60, price=40)
        self.svc_b = self.make_service("Piega", duration=30, price=20)
        self.day = timezone.localdate() + dt.timedelta(days=7)

    def make_operator(self, name, active=True):
        op = Operator.objects.create(salon=self.salon, first_name=name, last_name="Rossi", active=active, location=self.location)
        for weekday in range(7):
            WeeklyShift.objects.create(operator=op, weekday=weekday, start_min=9 * 60, end_min=18 * 60)
        return op

    def make_service(self, name, *, duration, price, soak=0):
        svc = Service.objects.create(
            salon=self.salon, category=self.category, name_it=name,
            duration_min=duration, soak_min=soak, price=price,
        )
        svc.operators.add(self.op, self.op2)
        return svc

    def at(self, hour, minute=0, day=None):
        return timezone.make_aware(dt.datetime.combine(day or self.day, dt.time(hour, minute)))

    def make_visit(self, items, *, start_hour=10, operator=None, **fields):
        """items = [(service, operator, duration, soak)] concatenati da start."""
        operator = operator or items[0][1]
        appt = Appointment.objects.create(
            salon=self.salon, location=self.location, client=self.customer,
            operator=operator, start=self.at(start_hour), **fields,
        )
        for index, (svc, op, duration, soak) in enumerate(items):
            AppointmentService.objects.create(
                appointment=appt, service=svc, operator=op,
                duration_min=duration, soak_min=soak, price=svc.price, order=index,
            )
        return appt

    def post(self, path, body, headers=None):
        return self.client.post(
            path, json.dumps(body, default=str), content_type="application/json",
            **(headers if headers is not None else self.headers),
        )


class P1SplitFirstService(Base):
    """Staccare il PRIMO servizio sposta indietro quelli rimasti."""

    def test_detaching_the_first_service_drags_the_rest_earlier(self):
        appt = self.make_visit(
            [(self.svc_a, self.op, 60, 0), (self.svc_b, self.op, 30, 0)], start_hour=10
        )
        first, second = list(appt.items.order_by("order"))
        self.assertEqual(appt.start, self.at(10))           # visita 10:00–11:30
        second_was_at = appt.start + dt.timedelta(minutes=first.duration_min)
        self.assertEqual(second_was_at, self.at(11))        # la piega era alle 11:00

        original, created = agenda_services.split_appointment(
            appt, first.id, self.at(15), actor=self.user
        )
        original.refresh_from_db()
        # Il servizio staccato va alle 15:00, come chiesto.
        self.assertEqual(created.start, self.at(15))
        # …ma la PIEGA, che nessuno ha toccato, non è più alle 11:00: la catena
        # riparte da `start`, quindi scivola alle 10:00.
        self.assertEqual(original.start, self.at(10))
        remaining = list(original.items.order_by("order"))
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0].id, second.id)
        self.assertEqual(original.end, self.at(10, 30))
        print("PROBE P1: staccato il 1º servizio → la piega passa da 11:00 a 10:00 senza che nessuno l'abbia spostata")

    def test_the_rest_is_dragged_over_another_client(self):
        """Lo slittamento può finire sopra un altro appuntamento: 409, e la
        dashboard ritenta con force=True (sections/agenda/index.jsx)."""
        appt = self.make_visit(
            [(self.svc_a, self.op, 60, 0), (self.svc_b, self.op, 30, 0)], start_hour=10
        )
        first = appt.items.order_by("order").first()
        # un'altra cliente occupa le 10:00–11:00 della stessa operatrice
        other_client = Client.objects.create(
            salon=self.salon, first_name="Altra", last_name="Cliente", phone="+393330000002"
        )
        other = Appointment.objects.create(
            salon=self.salon, location=self.location, client=other_client,
            operator=self.op, start=self.at(10),
        )
        AppointmentService.objects.create(
            appointment=other, service=self.svc_a, operator=self.op,
            duration_min=60, soak_min=0, price=self.svc_a.price, order=0,
        )
        with self.assertRaises(HttpError) as caught:
            agenda_services.split_appointment(appt, first.id, self.at(15), actor=self.user)
        self.assertEqual(caught.exception.status_code, 409)
        # con force (quello che fa la dashboard dopo il 409) la piega finisce
        # sopra l'altra cliente
        appt.refresh_from_db()
        original, created = agenda_services.split_appointment(
            appt, first.id, self.at(15), actor=self.user, force=True
        )
        original.refresh_from_db()
        self.assertEqual(original.start, self.at(10))   # sovrapposta a `other`
        print("PROBE P1b: il 409 nasce dallo slittamento, e col force la piega si accavalla a un'altra cliente")


class P2MoveOfAFormerStylist(Base):
    """Spostare l'appuntamento di un'operatrice disattivata: la dashboard manda
    sempre `operator_id`, l'API lo cerca con active=True → 404."""

    def test_day_view_move_of_an_inactive_operator_appointment_returns_404(self):
        appt = self.make_visit([(self.svc_a, self.op, 60, 0)], start_hour=10)
        self.op.active = False
        self.op.save(update_fields=["active"])

        # la vista giorno mostra ancora la colonna (API: orphan operators)
        day = self.client.get(f"/api/agenda/day?date={self.day.isoformat()}", **self.headers)
        self.assertEqual(day.status_code, 200)
        rows = day.json()
        inactive_rows = [r for r in rows if r["operator"]["id"] == self.op.id]
        self.assertEqual(len(inactive_rows), 1)
        self.assertTrue(inactive_rows[0]["operator"]["inactive"])
        self.assertEqual(len(inactive_rows[0]["appointments"]), 1)

        # DayGrid → index.jsx moveAppt: manda SEMPRE operator_id, anche quando
        # l'operatrice non cambia
        response = self.post(
            f"/api/agenda/appointments/{appt.id}/move",
            {"start": self.at(11).isoformat(), "operator_id": self.op.id, "force": False},
        )
        self.assertEqual(response.status_code, 404, response.content)
        appt.refresh_from_db()
        self.assertEqual(appt.start, self.at(10))   # non spostato
        print("PROBE P2: spostare nella stessa colonna un appuntamento di un'operatrice disattivata → 404 Not Found")

    def test_multi_service_visit_of_an_inactive_operator_cannot_be_reassigned(self):
        appt = self.make_visit(
            [(self.svc_a, self.op, 60, 0), (self.svc_b, self.op, 30, 0)], start_hour=10
        )
        self.op.active = False
        self.op.save(update_fields=["active"])
        # visita multi-servizio: DayGrid manda l'operatrice PRINCIPALE, anche
        # trascinando sulla colonna di una collega attiva
        response = self.post(
            f"/api/agenda/appointments/{appt.id}/move",
            {"start": self.at(12).isoformat(), "operator_id": appt.operator_id, "force": False},
        )
        self.assertEqual(response.status_code, 404, response.content)
        print("PROBE P2b: una visita multi-servizio di un'operatrice disattivata non si sposta né si riassegna (404)")

    def test_without_operator_id_the_same_move_works(self):
        appt = self.make_visit([(self.svc_a, self.op, 60, 0)], start_hour=10)
        self.op.active = False
        self.op.save(update_fields=["active"])
        response = self.post(
            f"/api/agenda/appointments/{appt.id}/move", {"start": self.at(11).isoformat()}
        )
        self.assertEqual(response.status_code, 200, response.content)
        print("PROBE P2c: lo stesso spostamento SENZA operator_id riesce → è il parametro a farlo fallire")


class P3CheckoutOverwrite(Base):
    """Il checkout salva l'appuntamento per intero: quello che cambia durante la
    richiesta (es. la caparra incassata da Stripe) viene riscritto all'indietro."""

    def test_checkout_full_save_reverts_a_deposit_paid_meanwhile(self):
        appt = self.make_visit(
            [(self.svc_a, self.op, 60, 0)], start_hour=10,
            deposit_status=Appointment.DepositStatus.REQUIRED,
            deposit_amount=Decimal("20.00"),
        )
        real_finalize = None
        from apps.sales import api as sales_api

        def finalize_and_interleave(*args, **kwargs):
            # il webhook Stripe arriva mentre il checkout è in corso
            Appointment.objects.filter(pk=appt.pk).update(
                deposit_status=Appointment.DepositStatus.PAID,
                deposit_payment_intent_id="pi_probe_123",
            )
            return real_finalize(*args, **kwargs)

        real_finalize = sales_api.finalize_sale
        with patch.object(sales_api, "finalize_sale", side_effect=finalize_and_interleave):
            response = self.post(
                f"/api/sales/checkout/{appt.id}",
                {
                    "blocks": [{"operator_id": self.op.id, "lines": [
                        {"line_type": "service", "service_id": self.svc_a.id, "qty": 1, "unit_price": "40.00"}
                    ]}],
                    "payments": [{"method": "cash", "amount": "40.00"}],
                },
            )
        self.assertEqual(response.status_code, 200, response.content)
        appt.refresh_from_db()
        self.assertEqual(appt.status, "closed")
        # la caparra incassata durante la richiesta è stata cancellata
        self.assertEqual(appt.deposit_status, Appointment.DepositStatus.REQUIRED)
        self.assertEqual(appt.deposit_payment_intent_id, "")
        print("PROBE P3: il save() completo del checkout riporta la caparra a «richiesta» e perde il PaymentIntent")


class P4ManualRefundAmount(Base):
    """La conferma manuale del rimborso non scrive l'importo rimborsato."""

    def test_manual_refund_leaves_the_refunded_amount_at_zero(self):
        appt = self.make_visit(
            [(self.svc_a, self.op, 60, 0)], start_hour=10,
            deposit_status=Appointment.DepositStatus.REFUND_DUE,
            deposit_amount=Decimal("30.00"),
        )
        agenda_services.mark_deposit_refunded(appt, actor=self.user)
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_status, Appointment.DepositStatus.REFUNDED)
        self.assertEqual(appt.deposit_refunded_amount, Decimal("0.00"))
        self.assertEqual(appt.deposit_refunds, {})
        print("PROBE P4: caparra «rimborsata» a mano, deposit_refunded_amount resta 0,00")


class P5FreedSlotDuration(Base):
    """slot.freed dichiara solo il tempo attivo: la posa non c'è."""

    def test_freed_slot_duration_ignores_the_soak(self):
        colour = self.make_service("Colore", duration=30, price=60, soak=60)
        appt = self.make_visit([(colour, self.op, 30, 60)], start_hour=10)
        WaitlistEntry.objects.create(
            salon=self.salon, client=self.customer, service=colour,
            status=WaitlistEntry.Status.ACTIVE,
        )
        with patch("apps.agenda.services.emit_event") as emit:
            agenda_services.free_slot_event(appt)
        payload = emit.call_args[0][2]
        self.assertEqual(appt.total_duration_min, 90)   # la cliente resta 90'
        self.assertEqual(payload["duration_min"], 30)   # ma lo slot ne dichiara 30
        print("PROBE P5: slot.freed dichiara 30' per una visita che occupa 90' (posa esclusa)")


class P6MovePastClosing(Base):
    """La creazione rifiuta una posa che finisce dopo la chiusura; lo spostamento
    la accetta (manca `_ensure_within_opening`)."""

    def test_move_accepts_what_creation_refuses(self):
        colour = self.make_service("Colore", duration=30, price=60, soak=60)
        # apertura fino alle 18:00, turno 09:00–18:00 → 17:30 + 30' + 60' = 19:00
        with self.assertRaises(HttpError) as caught:
            agenda_services.create_appointment(
                self.salon, self.customer,
                [{"service_id": colour.id, "operator_id": self.op.id}],
                self.at(17, 30), via=Appointment.CreatedVia.DASHBOARD, location=self.location,
            )
        self.assertEqual(caught.exception.status_code, 409)

        appt = self.make_visit([(colour, self.op, 30, 60)], start_hour=10)
        moved = agenda_services.move_appointment(appt, self.at(17, 30), actor=self.user)
        moved.refresh_from_db()
        self.assertEqual(moved.start, self.at(17, 30))
        self.assertEqual(moved.end, self.at(19))        # posa oltre la chiusura
        self.assertFalse(moved.forced)                  # e non è marcato come forzato
        print("PROBE P6: spostamento alle 17:30 accettato (fine posa 19:00, chiusura 18:00); la creazione dà 409")

    def test_client_app_can_do_the_same(self):
        colour = self.make_service("Colore", duration=30, price=60, soak=60)
        appt = self.make_visit([(colour, self.op, 30, 60)], start_hour=10)
        token = create_client_tokens(self.customer)["access"]
        response = self.post(
            f"/api/agenda/client/appointments/{appt.id}/move",
            {"start": self.at(17, 30).isoformat()},
            headers={"HTTP_AUTHORIZATION": "Bearer " + token},
        )
        self.assertEqual(response.status_code, 200, response.content)
        appt.refresh_from_db()
        self.assertEqual(appt.end, self.at(19))
        print("PROBE P6b: anche l'app cliente può spostare la visita oltre la chiusura")


class P7GiftCardQty(Base):
    """Più gift card sulla stessa riga: la vendita ne collega solo l'ultima."""

    def test_only_the_last_card_is_linked_to_the_sale_line(self):
        from apps.marketing.models import GiftCard
        from apps.sales.services import finalize_sale
        from apps.sales.models import Sale, SaleLine

        sale = finalize_sale(
            self.salon,
            kind=Sale.Kind.POS,
            blocks=[{"operator_id": self.op.id, "lines": [
                {"line_type": "gift_card", "value": "50.00", "qty": 3}
            ]}],
            payments=[{"method": "cash", "amount": "150.00"}],
            actor=self.user,
        )
        cards = list(GiftCard.objects.filter(salon=self.salon).order_by("id"))
        self.assertEqual(len(cards), 3)
        linked = list(SaleLine.objects.filter(sale=sale).values_list("gift_card_id", flat=True))
        self.assertEqual(linked, [cards[-1].id])
        orphans = [c for c in cards if not SaleLine.objects.filter(gift_card=c).exists()]
        self.assertEqual(len(orphans), 2)
        print("PROBE P7: 3 gift card emesse, 1 sola collegata alla riga; 2 restano senza vendita")


class P8OccupancyOfFormerStylists(Base):
    """Occupazione: i turni di un'operatrice disattivata escono dal denominatore,
    i suoi appuntamenti restano nel numeratore."""

    def test_deactivating_a_stylist_inflates_past_occupancy(self):
        from apps.insights import services as insights

        day = timezone.localdate() - dt.timedelta(days=1)
        for operator in (self.op, self.op2):
            appt = Appointment.objects.create(
                salon=self.salon, location=self.location, client=self.customer,
                operator=operator, start=self.at(10, day=day),
                status=Appointment.Status.CLOSED,
            )
            AppointmentService.objects.create(
                appointment=appt, service=self.svc_a, operator=operator,
                duration_min=180, soak_min=0, price=self.svc_a.price, order=0,
            )
        before = insights.kpis(self.salon, "custom", date_from=day, date_to=day)["occupancy_pct"]
        self.op2.active = False
        self.op2.save(update_fields=["active"])
        after = insights.kpis(self.salon, "custom", date_from=day, date_to=day)["occupancy_pct"]
        # 6 ore prenotate su 18 di turno → 33,3%; disattivando Marta il turno
        # sparisce ma i suoi 180' restano: 6 ore su 9 → 66,7%
        self.assertAlmostEqual(before, 33.3, places=1)
        self.assertAlmostEqual(after, 66.7, places=1)
        print(f"PROBE P8: occupazione di ieri {before}% → {after}% solo perché un'operatrice è stata disattivata")


class P9LoyaltyFakeCashIn(Base):
    """Il premio «servizio omaggio» scrive a registro un incasso mai avvenuto."""

    def test_free_service_reward_logs_a_gift_card_cash_in(self):
        from apps.core.models import ActivityLog
        from apps.marketing.models import LoyaltyProgram
        from apps.sales.models import Sale
        from apps.sales.services import finalize_sale

        LoyaltyProgram.objects.create(
            salon=self.salon, name="Timbri", threshold=1,
            earn_metric=LoyaltyProgram.EarnMetric.PER_VISIT, earn_ratio=Decimal("1"),
            reward_type=LoyaltyProgram.RewardType.FREE_SERVICE, reward_service=self.svc_a,
            reward_value=Decimal("0"),
        )
        finalize_sale(
            self.salon, kind=Sale.Kind.POS,
            blocks=[{"operator_id": self.op.id, "lines": [
                {"line_type": "service", "service_id": self.svc_a.id, "qty": 1, "unit_price": "40.00"}
            ]}],
            payments=[{"method": "cash", "amount": "40.00"}],
            client=self.customer, actor=self.user,
        )
        paid_logs = list(ActivityLog.objects.filter(salon=self.salon, type="giftcard.paid"))
        self.assertEqual(len(paid_logs), 1)
        self.assertIn("Incasso gift card", paid_logs[0].summary)
        self.assertIn("40", paid_logs[0].summary)
        self.assertEqual(paid_logs[0].payload.get("method"), "loyalty")
        print(f"PROBE P9: registro attività → «{paid_logs[0].summary}» per un premio che non ha incassato nulla")
