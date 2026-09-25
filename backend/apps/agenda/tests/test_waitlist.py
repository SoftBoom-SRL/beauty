"""Lista d'attesa: iscrizione dall'app, elenco dello staff, avvisi quando uno slot si libera.

Le classi con un reperto della caccia del 22/09 nella docstring (NN-MM)
descrivono il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt

from django.utils import timezone

from apps.core.models import ActivityLog, OutboxEvent
from common.testing import bearer, client_bearer, post_json

from ..models import WaitlistEntry
from ..services.appointments import create_appointment
from ..services.transitions import cancel_appointment
from .base import AgendaTestBase, MessagesTestBase, _aware


class WaitlistTests(AgendaTestBase):
    """Lista d'attesa: iscrizione, elenco, cancellazione e abbinamento allo slot libero."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.client_auth = client_bearer(self.client_obj)
        user = User.objects.create_user(email="desk@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role)
        self.staff_auth = bearer(user, self.salon)

    def _subscribe(self, body):
        return post_json(self.client, "/api/agenda/client/waitlist", body, **self.client_auth)

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
        self._no_automation_delay()
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


class LateJoinerOfTheWaitlistTests(MessagesTestBase):
    """03-10: chi si è messa in lista mentre lo slot era occupato viene avvisata."""

    def test_only_who_joined_after_the_booking_hears_of_it(self):
        before = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        WaitlistEntry.objects.filter(pk=before.pk).update(created_at=timezone.now() - dt.timedelta(hours=1))
        appointment = self._book(10)
        later = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        cancel_appointment(appointment, actor=self.user)
        (event,) = self._pending("slot:")
        self.assertEqual(event.payload["matching_waitlist"], [later.id])

    def test_nobody_new_nothing_said(self):
        early = WaitlistEntry.objects.create(salon=self.salon, client=self.client_obj, service=self.svc60)
        WaitlistEntry.objects.filter(pk=early.pk).update(created_at=timezone.now() - dt.timedelta(hours=1))
        appointment = self._book(10)
        cancel_appointment(appointment, actor=self.user)
        self.assertEqual(self._pending("slot:"), [])
