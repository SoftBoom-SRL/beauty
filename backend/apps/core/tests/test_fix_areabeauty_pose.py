"""`manage.py fix_areabeauty_pose`: via le pose inventate dal primo import AreaBeauty."""

import datetime as dt
from decimal import Decimal
from io import StringIO

from django.contrib.contenttypes.models import ContentType
from django.core.management import call_command
from django.test import TestCase

from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ExternalRef, Salon
from apps.sales.models import Sale
from apps.staff.models import Operator

UTC = dt.UTC


class FixPoseTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="Salone", slug="salone")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Mani")
        self.mani = Service.objects.create(salon=self.salon, category=cat, name_it="Manicure", duration_min=45, price=45)
        self.scrub = Service.objects.create(salon=self.salon, category=cat, name_it="Scrub", duration_min=10, price=20, is_addon=True)
        self.piedi = Service.objects.create(salon=self.salon, category=cat, name_it="Pedicure", duration_min=60, price=70)
        self.old = Service.objects.create(salon=self.salon, category=cat, name_it="Vecchio", duration_min=60, soak_min=10, price=70, active=False)
        self.mine = Service.objects.create(salon=self.salon, category=cat, name_it="Colore", duration_min=60, soak_min=30, price=70)
        for i, svc in enumerate((self.old, self.mine)):
            self.ref("servizio", i, svc)
        self.anna = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")
        self.giulia = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="")
        self.marta = Operator.objects.create(salon=self.salon, first_name="Marta", last_name="")

    def ref(self, kind, ext, obj):
        ExternalRef.objects.create(
            salon=self.salon, source="areabeauty", kind=kind, external_id=str(ext),
            content_type=ContentType.objects.get_for_model(type(obj)), object_id=obj.pk,
        )

    def visit(self, start, items, status="closed", kind="appuntamento", ext="r"):
        a = Appointment.objects.create(salon=self.salon, client=self.anna, operator=items[0][1], start=start, status=status)
        for order, (svc, op, dur, soak) in enumerate(items):
            AppointmentService.objects.create(appointment=a, service=svc, operator=op, duration_min=dur, soak_min=soak, price=svc.price, order=order)
        self.ref(kind, ext, a)
        return a

    def run_fix(self, *extra):
        out = StringIO()
        call_command("fix_areabeauty_pose", "--salon", "salone", *extra, stdout=out)
        return out.getvalue()

    def test_gap_becomes_its_own_appointment_and_end_soak_goes(self):
        start = dt.datetime(2026, 10, 1, 8, tzinfo=UTC)
        visit = self.visit(start, [(self.mani, self.giulia, 45, 30), (self.scrub, self.giulia, 0, 0), (self.piedi, self.marta, 60, 0)], ext="r-1")
        sale = Sale.objects.create(salon=self.salon, kind="checkout", appointment=visit, client=self.anna, total=Decimal("135"))
        long_tail = self.visit(dt.datetime(2026, 10, 6, 16, tzinfo=UTC), [(self.mani, self.giulia, 20, 182), (self.scrub, self.giulia, 0, 0)], ext="r-2")
        cancelled = self.visit(start, [(self.mani, self.giulia, 45, 10)], status="cancelled", kind="annullato", ext="a-1")
        untouched = Appointment.objects.create(salon=self.salon, client=self.anna, operator=self.giulia, start=start)
        AppointmentService.objects.create(appointment=untouched, service=self.mine, operator=self.giulia, duration_min=60, soak_min=30, price=70)

        out = self.run_fix()
        self.assertIn("visite divise: 1", out)
        self.assertIn("pose tolte (fine cliente): 2", out)

        self.assertEqual([(i.service_id, i.soak_min) for i in visit.items.order_by("order")], [(self.mani.pk, 0), (self.scrub.pk, 0)])
        part = Appointment.objects.exclude(pk__in=[visit.pk, long_tail.pk, cancelled.pk, untouched.pk]).get()
        self.assertEqual(part.start, start + dt.timedelta(minutes=75))
        self.assertEqual((part.operator_id, part.status, part.paid_in_sale_id), (self.marta.pk, "closed", sale.pk))
        self.assertEqual([(i.service_id, i.soak_min, i.order) for i in part.items.all()], [(self.piedi.pk, 0, 0)])
        self.assertTrue(ExternalRef.objects.filter(kind="appuntamento", external_id=f"diviso:{visit.pk}:1", object_id=part.pk).exists())
        self.assertEqual(list(long_tail.items.values_list("soak_min", flat=True)), [0, 0])
        self.assertEqual(cancelled.items.get().soak_min, 0)
        # Non importato: non si tocca. Il listino: solo i servizi creati disattivati dall'import.
        self.assertEqual(untouched.items.get().soak_min, 30)
        self.old.refresh_from_db()
        self.mine.refresh_from_db()
        self.assertEqual((self.old.soak_min, self.mine.soak_min), (0, 30))
        # Rilanciato non fa più niente.
        self.assertIn("visite divise: 0", self.run_fix())

    def test_dry_run_changes_nothing(self):
        start = dt.datetime(2026, 10, 1, 8, tzinfo=UTC)
        visit = self.visit(start, [(self.mani, self.giulia, 45, 30), (self.piedi, self.marta, 60, 0)])
        out = self.run_fix("--dry-run")
        self.assertIn("visite divise: 1", out)
        self.assertEqual(Appointment.objects.count(), 1)
        self.assertEqual(list(visit.items.values_list("soak_min", flat=True)), [30, 0])

    # --- fix_areabeauty_operatrici --------------------------------------------
    def run_split(self, *extra):
        out = StringIO()
        call_command("fix_areabeauty_operatrici", "--salon", "salone", *extra, stdout=out)
        return out.getvalue()

    def test_colleagues_in_one_visit_become_one_appointment_each(self):
        start = dt.datetime(2026, 10, 20, 8, tzinfo=UTC)
        visit = self.visit(
            start,
            [(self.mani, self.giulia, 45, 0), (self.scrub, self.giulia, 0, 0), (self.piedi, self.marta, 60, 0), (self.mani, self.giulia, 45, 0)],
            status="confirmed", ext="r-3",
        )
        sale = Sale.objects.create(salon=self.salon, kind="checkout", appointment=visit, client=self.anna, total=Decimal("180"))
        same = self.visit(start, [(self.mani, self.giulia, 45, 0), (self.piedi, self.giulia, 60, 0)], ext="r-4")

        out = self.run_split()
        self.assertIn("visite divise: 1", out)
        self.assertIn("appuntamenti nuovi: 2", out)
        self.assertEqual([(i.service_id, i.operator_id) for i in visit.items.order_by("order")], [(self.mani.pk, self.giulia.pk), (self.scrub.pk, self.giulia.pk)])
        parts = list(Appointment.objects.exclude(pk__in=[visit.pk, same.pk]).order_by("start"))
        self.assertEqual(
            [(p.start, p.operator_id, p.status, p.paid_in_sale_id) for p in parts],
            [(start + dt.timedelta(minutes=45), self.marta.pk, "confirmed", sale.pk), (start + dt.timedelta(minutes=105), self.giulia.pk, "confirmed", sale.pk)],
        )
        self.assertEqual(
            sorted(ExternalRef.objects.filter(external_id__startswith="operatrice:").values_list("external_id", flat=True)),
            [f"operatrice:{visit.pk}:1", f"operatrice:{visit.pk}:2"],
        )
        # una sola operatrice: resta com'è; rilanciato non fa più niente
        self.assertEqual(same.items.count(), 2)
        self.assertIn("visite divise: 0", self.run_split())

    def test_colleagues_split_dry_run_changes_nothing(self):
        start = dt.datetime(2026, 10, 20, 8, tzinfo=UTC)
        self.visit(start, [(self.mani, self.giulia, 45, 0), (self.piedi, self.marta, 60, 0)])
        self.assertIn("visite divise: 1", self.run_split("--dry-run"))
        self.assertEqual(Appointment.objects.count(), 1)
