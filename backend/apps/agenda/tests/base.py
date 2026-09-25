"""Basi e aiuti condivisi dai test dell'agenda: qui solo quello che serve a più moduli.

Due saloni di prova, per due modi di trattare i turni:

- `AgendaTestBase`: i modelli di clients/staff/catalog sono usati direttamente
  (esistono a livello di progetto integrato); `shift_windows` e `client_facts`
  vengono mockati per isolare l'algoritmo dell'agenda dalla logica interna
  delle altre app.
- `RealShiftsTestBase`: turni veri (WeeklyShift), niente mock di
  `shift_windows`: nella caccia del 22/09 i difetti stavano proprio nel punto
  in cui ricerca e conferma guardavano cose diverse.
"""

import datetime as dt
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import OutboxEvent, Salon, SalonSettings
from common.testing import aware, bearer, client_bearer, post_json, put_json

from ..models import Appointment, AppointmentService
from ..services import availability as S
from ..services.appointments import create_appointment

# Turno di 24 ore per `_windows`, nei test dove i turni non c'entrano.
WIDE = [(0, 24 * 60)]

# È `aware` di common.testing, col nome che usano da sempre i test scritti su
# AgendaTestBase.
_aware = aware


def hm(iso):
    return f"{timezone.localtime(dt.datetime.fromisoformat(iso)):%H:%M}"


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

    def _no_automation_delay(self):
        """Eventi verso Yourang senza trattenuta: uno per gesto, come prima.

        Serve ai test che guardano un evento specifico mentre creano e
        modificano nello stesso istante: col ritardo di serie quei due gesti si
        fondono in un evento solo (è il punto di `AutomationDelayTests`).
        """
        from apps.core.models import SalonSettings

        SalonSettings.objects.update_or_create(
            salon=self.salon, defaults={"automation_delay_seconds": 0}
        )

    def _undo(self, body=None):
        """«Torna indietro» chiesto con l'header staff che il setUp mette in `self.auth`."""
        return post_json(self.client, "/api/agenda/undo", body or {}, **self.auth)


class RealShiftsTestBase(TestCase):
    """Due operatrici (Giulia prima in ordine, Marta seconda), turno 9–19 tutti i giorni."""

    @classmethod
    def setUpTestData(cls):
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator

        cls.salon = Salon.objects.create(name="Caccia 22", slug="caccia-22-agenda")
        cls.settings_row = SalonSettings.objects.create(
            salon=cls.salon, slot_interval_min=15, agenda_fill="max_revenue",
            automation_delay_seconds=0,
        )
        cls.cat = ServiceCategory.objects.create(salon=cls.salon, name_it="Capelli", color="#FFFFFF", order=0)
        cls.cut30 = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Taglio", duration_min=30, price=Decimal("30.00"),
        )
        cls.color30s20 = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Colore", duration_min=30, soak_min=20,
            price=Decimal("50.00"),
        )
        cls.man60 = Service.objects.create(
            salon=cls.salon, category=cls.cat, name_it="Manicure", duration_min=60, price=Decimal("40.00"),
        )
        cls.giulia = Operator.objects.create(salon=cls.salon, first_name="Giulia", last_name="A", order=0)
        cls.marta = Operator.objects.create(salon=cls.salon, first_name="Marta", last_name="B", order=1)
        for op in (cls.giulia, cls.marta):
            op.services.add(cls.cut30, cls.color30s20, cls.man60)
            cls.shifts(op, 9 * 60, 19 * 60)
        cls.anna = Client.objects.create(salon=cls.salon, first_name="Anna", last_name="R", phone="+393330000001")
        cls.bea = Client.objects.create(salon=cls.salon, first_name="Bea", last_name="S", phone="+393330000002")
        cls.day = timezone.localdate() + dt.timedelta(days=10)

    @staticmethod
    def shifts(op, start_min, end_min):
        from apps.staff.models import WeeklyShift

        WeeklyShift.objects.filter(operator=op).delete()
        for weekday in range(7):
            WeeklyShift.objects.create(
                operator=op, week_index=0, weekday=weekday, start_min=start_min, end_min=end_min,
            )

    def operator(self, first_name, *, services=None, start_min=9 * 60, end_min=19 * 60, **fields):
        from apps.staff.models import Operator

        op = Operator.objects.create(salon=self.salon, first_name=first_name, last_name="Z", **fields)
        op.services.add(*(services or (self.cut30, self.color30s20, self.man60)))
        self.shifts(op, start_min, end_min)
        return op

    def book(self, client, op, start, items):
        """items = [(servizio, durata, posa)] tutti di `op` (o [(servizio, durata, posa, op)])."""
        appointment = Appointment.objects.create(salon=self.salon, client=client, operator=op, start=start)
        for index, entry in enumerate(items):
            service, duration, soak = entry[:3]
            AppointmentService.objects.create(
                appointment=appointment, service=service, operator=entry[3] if len(entry) > 3 else op,
                duration_min=duration, soak_min=soak, price=service.price, order=index,
            )
        return appointment

    def staff_auth(self, scopes=("agenda",), *, email="desk@caccia22.it", owner=False):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.filter(email=email).first()
        if user is None:  # chiamabile più volte nello stesso test
            user = User.objects.create_user(email=email, password="x" * 12)
            role = Role.objects.create(salon=self.salon, name=f"Ruolo {email}", scopes=list(scopes))
            Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=owner)
        return bearer(user, self.salon)

    def client_auth(self, client=None):
        return client_bearer(client or self.anna)

    def post(self, url, body, auth):
        return post_json(self.client, url, body, **auth)

    def put(self, url, body, auth):
        return put_json(self.client, url, body, **auth)

    def slots(self, items, day=None, **kwargs):
        return S.get_free_slots(self.salon, day or self.day, items, **kwargs)


class MessagesTestBase(AgendaTestBase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role)
        self.auth = bearer(self.user, self.salon)
        windows = self._windows({self.op1.id: WIDE, self.op2.id: WIDE})
        windows.start()
        self.addCleanup(windows.stop)

    def _book(self, hour=10, minute=0, via="dashboard", items=None, **kwargs):
        return create_appointment(
            self.salon, self.client_obj,
            items or [{"service_id": self.svc60.id, "operator_id": self.op1.id}],
            _aware(self.day, hour, minute), via=via, actor=self.user, **kwargs,
        )

    def _all_sent(self):
        """Tutto quello che era in coda è arrivato da un pezzo."""
        OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).update(
            status=OutboxEvent.Status.SENT, sent_at=timezone.now(), attempts=1
        )

    def _pending(self, prefix="appointment:"):
        return list(
            OutboxEvent.objects.filter(
                status=OutboxEvent.Status.PENDING, coalesce_key__startswith=prefix
            ).order_by("id")
        )

    def _freed(self):
        return [
            (e.payload["operator_id"], parse_datetime(e.payload["start"]), e.payload["duration_min"])
            for e in self._pending("slot:")
        ]
