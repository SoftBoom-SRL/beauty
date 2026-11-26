"""La «permanenza» della cliente: i suoi appuntamenti dello stesso giorno, uno dopo l'altro."""

import datetime as dt
import json
from decimal import Decimal

from common.auth import create_staff_tokens

from ..models import Appointment
from ..services.appointments import create_appointment
from ..services.stay import move_stay, stay_of
from .base import AgendaTestBase, _aware


class StayTests(AgendaTestBase):
    def setUp(self):
        self.op2.services.add(self.svc60, self.svc30)
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}

    def book(self, op, service, hour, minute=0):
        with self._windows(self.wide):
            return create_appointment(
                self.salon, self.client_obj, [{"service_id": service.id, "operator_id": op.id}],
                _aware(self.day, hour, minute), via="dashboard", force=True, client_overlap_ok=True,
            )

    def test_one_after_the_other_is_one_stay_a_morning_and_an_evening_are_two(self):
        hands = self.book(self.op1, self.svc60, 10)          # 10:00–11:00
        feet = self.book(self.op2, self.svc30, 11)           # 11:00–11:30, attaccati
        brows = self.book(self.op1, self.svc30, 11, 50)      # 20' dopo: stessa permanenza
        evening = self.book(self.op2, self.svc60, 17)        # la sera: un'altra
        cancelled = self.book(self.op2, self.svc30, 12, 15)
        Appointment.objects.filter(pk=cancelled.pk).update(status=Appointment.Status.CANCELLED)
        self.assertEqual([a.pk for a in stay_of(feet)], [hands.pk, feet.pk, brows.pk])
        self.assertEqual([a.pk for a in stay_of(evening)], [evening.pk])
        self.assertEqual([a.pk for a in stay_of(Appointment.objects.get(pk=cancelled.pk))], [cancelled.pk])

    def test_the_endpoint_lists_the_stay_and_what_is_already_billed(self):
        from apps.accounts.models import Membership, User
        from apps.sales.models import Sale

        hands = self.book(self.op1, self.svc60, 10)
        feet = self.book(self.op2, self.svc30, 11)
        sale = Sale.objects.create(salon=self.salon, kind="checkout", appointment=hands, client=self.client_obj, total=Decimal("80"))
        Appointment.objects.filter(pk=feet.pk).update(paid_in_sale=sale, status=Appointment.Status.CLOSED)
        user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        res = self.client.get(
            f"/api/agenda/appointments/{feet.id}/stay",
            HTTP_AUTHORIZATION=f"Bearer {create_staff_tokens(user, self.salon)['access']}",
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = json.loads(res.content)
        self.assertEqual([(v["id"], v["bill_id"]) for v in body], [(hands.id, sale.id), (feet.id, sale.id)])
        self.assertEqual(body[1]["items"][0]["operator_id"], self.op2.id)


class MoveStayTests(AgendaTestBase):
    """Spostare la seduta intera: prima si riprogrammava un appuntamento per
    volta (Beauty Boutique, 11/2026)."""

    def setUp(self):
        self.op2.services.add(self.svc60, self.svc30)
        self.wide = {self.op1.id: [(8 * 60, 20 * 60)], self.op2.id: [(8 * 60, 20 * 60)]}

    def book(self, op, service, hour, minute=0, day=None, client=None):
        with self._windows(self.wide):
            return create_appointment(
                self.salon, client or self.client_obj, [{"service_id": service.id, "operator_id": op.id}],
                _aware(day or self.day, hour, minute), via="dashboard", force=True, client_overlap_ok=True,
            )

    def starts(self, *appointments):
        return [(Appointment.objects.get(pk=a.pk).start, Appointment.objects.get(pk=a.pk).operator_id) for a in appointments]

    def test_the_whole_stay_moves_to_another_day_with_its_stylists(self):
        hands = self.book(self.op1, self.svc60, 10)       # 10:00–11:00 con Giulia
        feet = self.book(self.op2, self.svc30, 11)        # 11:00–11:30 con Marta
        evening = self.book(self.op2, self.svc60, 17)     # un'altra permanenza: resta
        other_day = self.day + dt.timedelta(days=2)
        with self._windows(self.wide):
            moved, mates = move_stay(feet, _aware(other_day, 15))
        self.assertEqual(moved.pk, feet.pk)
        self.assertEqual([a.pk for a in mates], [hands.pk])
        self.assertEqual(self.starts(hands, feet), [
            (_aware(other_day, 14), self.op1.id),
            (_aware(other_day, 15), self.op2.id),
        ])
        self.assertEqual(self.starts(evening), [(_aware(self.day, 17), self.op2.id)])

    def test_half_an_hour_later_on_the_same_day_with_the_same_stylist(self):
        first = self.book(self.op1, self.svc30, 10)       # 10:00–10:30
        second = self.book(self.op1, self.svc30, 10, 30)  # 10:30–11:00, stessa operatrice
        with self._windows(self.wide):
            move_stay(first, _aware(self.day, 10, 30))
        self.assertEqual(self.starts(first, second), [
            (_aware(self.day, 10, 30), self.op1.id),
            (_aware(self.day, 11), self.op1.id),
        ])

    def test_a_busy_slot_for_one_of_them_moves_nobody_and_force_moves_all(self):
        from django.db import transaction
        from ninja.errors import HttpError

        from apps.clients.models import Client

        hands = self.book(self.op1, self.svc60, 10)
        feet = self.book(self.op2, self.svc30, 11)
        other = Client.objects.create(salon=self.salon, first_name="Bea", last_name="S", phone="+390000000002")
        other_day = self.day + dt.timedelta(days=1)
        self.book(self.op2, self.svc30, 12, day=other_day, client=other)   # Marta occupata alle 12
        with self._windows(self.wide), self.assertRaises(HttpError) as err, transaction.atomic():
            move_stay(hands, _aware(other_day, 11))
        self.assertEqual(err.exception.status_code, 409)
        self.assertEqual(self.starts(hands, feet), [
            (_aware(self.day, 10), self.op1.id), (_aware(self.day, 11), self.op2.id),
        ])
        with self._windows(self.wide):
            move_stay(hands, _aware(other_day, 11), force=True)
        self.assertEqual([s for s, _ in self.starts(hands, feet)], [_aware(other_day, 11), _aware(other_day, 12)])

    def test_who_is_already_in_or_paid_stays_where_it_is(self):
        hands = self.book(self.op1, self.svc60, 10)
        feet = self.book(self.op2, self.svc30, 11)
        Appointment.objects.filter(pk=hands.pk).update(status=Appointment.Status.CHECKED_IN)
        with self._windows(self.wide):
            _, mates = move_stay(feet, _aware(self.day, 15))
        self.assertEqual(mates, [])
        self.assertEqual(self.starts(hands)[0][0], _aware(self.day, 10))

    def test_the_endpoint_moves_the_stay_and_lists_who_moved(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="seduta@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        hands = self.book(self.op1, self.svc60, 10)
        feet = self.book(self.op2, self.svc30, 11)
        other_day = self.day + dt.timedelta(days=3)
        with self._windows(self.wide):
            res = self.client.post(
                f"/api/agenda/appointments/{hands.id}/move-stay",
                data=json.dumps({"start": _aware(other_day, 9).isoformat()}),
                content_type="application/json",
                HTTP_AUTHORIZATION=f"Bearer {create_staff_tokens(user, self.salon)['access']}",
            )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["appointment"]["id"], hands.id)
        self.assertEqual(body["moved_ids"], [feet.id])
        self.assertEqual(self.starts(feet)[0][0], _aware(other_day, 10))
