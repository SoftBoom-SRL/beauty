"""Probe temporaneo del revisore 08 — DA CANCELLARE."""

from datetime import date, datetime, timedelta
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Salon
from apps.sales.models import Sale
from apps.staff.models import Operator, WeeklyShift

from .services import kpis, occupancy_by_weekday


def _aware(y, m, d, h=10, mi=0):
    return timezone.make_aware(datetime(y, m, d, h, mi))


class ProbeRebooking(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.op = Operator.objects.create(salon=self.salon, first_name="Op", last_name="X")
        self.cl = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")

    def test_past_period_rebooking_ignores_next_visit_already_closed(self):
        # visita chiusa ad agosto, prossima visita a settembre (già avvenuta: closed)
        Appointment.objects.create(salon=self.salon, client=self.cl, operator=self.op,
                                   start=_aware(2026, 8, 20), status="closed")
        Appointment.objects.create(salon=self.salon, client=self.cl, operator=self.op,
                                   start=_aware(2026, 9, 10), status="closed")
        r = kpis(self.salon, "month", date(2026, 8, 15))
        print("\nrebooking agosto (prossima visita 10/9 chiusa):", r["rebooking_rate"])
        # la stessa situazione vista dal mese in corso darebbe 1.0 finché la visita è futura
        self.assertEqual(r["rebooking_rate"], 1.0)


class ProbeNewClientsImport(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.op = Operator.objects.create(salon=self.salon, first_name="Op", last_name="X")

    def test_imported_address_book_counts_as_new(self):
        today = timezone.localdate()
        # 50 clienti importate oggi (since = oggi, come fa import_clients / sync Yourang)
        for i in range(50):
            Client.objects.create(salon=self.salon, first_name=f"C{i}", phone=f"+3933311{i:05d}",
                                  since=today)
        # una di loro, cliente storica (visita 1 anno fa), torna oggi
        old = Client.objects.get(first_name="C0")
        Appointment.objects.create(salon=self.salon, client=old, operator=self.op,
                                   start=timezone.now() - timedelta(days=365), status="closed")
        Appointment.objects.create(salon=self.salon, client=old, operator=self.op,
                                   start=timezone.now().replace(hour=9, minute=0), status="closed")
        r = kpis(self.salon, "month", today)
        print("\nnew_clients dopo import di 50 schede:", r["new_clients"], "returning:", r["returning_clients"])
        self.assertEqual(r["new_clients"], 0)
        self.assertEqual(r["returning_clients"], 1)


class ProbeNoShowDilution(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.op = Operator.objects.create(salon=self.salon, first_name="Op", last_name="X")
        self.cl = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")

    def test_future_appointments_dilute_noshow_rate(self):
        now = timezone.now()
        # passato: 5 chiusi, 5 no-show  → tasso reale 50%
        for i in range(5):
            Appointment.objects.create(salon=self.salon, client=self.cl, operator=self.op,
                                       start=now - timedelta(hours=10 + i), status="closed")
            Appointment.objects.create(salon=self.salon, client=self.cl, operator=self.op,
                                       start=now - timedelta(hours=20 + i), status="no_show")
        # futuro nello stesso periodo: 10 confermati (non possono ancora essere no-show)
        for i in range(10):
            Appointment.objects.create(salon=self.salon, client=self.cl, operator=self.op,
                                       start=now + timedelta(minutes=30 + i), status="confirmed")
        r = kpis(self.salon, "year", timezone.localdate())
        print("\nnoshow_rate con 10 appuntamenti futuri nel periodo:", r["noshow_rate"])
        self.assertEqual(r["noshow_rate"], 0.5)


class ProbeOccupancyInactiveOperator(TestCase):
    def test_inactive_operator_bookings_count_but_capacity_does_not(self):
        salon = Salon.objects.create(name="S", slug="s")
        cat = ServiceCategory.objects.create(salon=salon, name_it="C")
        svc = Service.objects.create(salon=salon, category=cat, name_it="P", duration_min=60, price=25)
        cl = Client.objects.create(salon=salon, first_name="Anna", phone="+393331112233")
        ops = []
        for n in range(2):
            op = Operator.objects.create(salon=salon, first_name=f"Op{n}", last_name="X")
            WeeklyShift.objects.create(operator=op, week_index=0, weekday=2, start_min=540, end_min=600)
            ops.append(op)
        # mercoledì 1 luglio 2026: ognuna ha 60' di turno e 60' prenotati → 100%
        # ma prenotiamo solo 60' su 120' totali → 50%
        a = Appointment.objects.create(salon=salon, client=cl, operator=ops[1],
                                       start=_aware(2026, 7, 1, 9), status="closed")
        AppointmentService.objects.create(appointment=a, service=svc, operator=ops[1], duration_min=60, price=25)
        before = next(r for r in occupancy_by_weekday(salon, "month", date(2026, 7, 1)) if r["weekday"] == 2)
        ops[1].active = False
        ops[1].save(update_fields=["active"])
        after = next(r for r in occupancy_by_weekday(salon, "month", date(2026, 7, 1)) if r["weekday"] == 2)
        print("\noccupazione luglio (mer) prima/dopo disattivazione:", before, after)
        self.assertEqual(before["occupancy_pct"], after["occupancy_pct"])


class ProbeRefundedDeposit(TestCase):
    def test_refunded_deposit_stays_in_cash_in(self):
        salon = Salon.objects.create(name="S", slug="s")
        op = Operator.objects.create(salon=salon, first_name="Op", last_name="X")
        cl = Client.objects.create(salon=salon, first_name="Anna", phone="+393331112233")
        appt = Appointment.objects.create(salon=salon, client=cl, operator=op,
                                          start=timezone.now() + timedelta(days=2), status="cancelled",
                                          deposit_status="refunded", deposit_amount=Decimal("30"),
                                          deposit_refunded_amount=Decimal("30"))
        Sale.objects.create(salon=salon, kind="pos", client=cl, deposit_appointment=appt, total=Decimal("30"))
        r = kpis(salon, "month", timezone.localdate())
        print("\ncash_in con caparra rimborsata:", r["cash_in"], r["deposit_cashed"])
        self.assertEqual(r["cash_in"], 0)
