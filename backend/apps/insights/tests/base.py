"""Basi comuni ai test degli insight.

`_aware(y, m, d, h=10, mi=0)` dà data e ora nel fuso del progetto a partire da
anno, mese e giorno: non è `common.testing.aware`, che vuole una data.
`_Base`: un salone con un'operatrice; `_client` crea clienti con telefoni
sempre diversi, `_appt` un appuntamento, con `booked_at` per retrodatarne la
prenotazione.
"""

from datetime import datetime

from django.test import TestCase
from django.utils import timezone

from apps.agenda.models import Appointment
from apps.clients.models import Client
from apps.core.models import Salon
from apps.staff.models import Operator


def _aware(y, m, d, h=10, mi=0):
    return timezone.make_aware(datetime(y, m, d, h, mi))


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.op = Operator.objects.create(salon=self.salon, first_name="Op", last_name="X")
        self._n = 0

    def _client(self, name="Anna", **kwargs):
        self._n += 1
        return Client.objects.create(
            salon=self.salon, first_name=name, phone=f"+39333111{self._n:04d}", **kwargs
        )

    def _appt(self, client, start, status="closed", booked_at=None):
        appt = Appointment.objects.create(
            salon=self.salon, client=client, operator=self.op, start=start, status=status
        )
        if booked_at is not None:
            Appointment.objects.filter(pk=appt.pk).update(created_at=booked_at)
        return appt
