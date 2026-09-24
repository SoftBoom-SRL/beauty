"""Feed live e stream SSE: biglietto monouso, permessi riletti, keep-alive,
eventi committati fuori ordine.

Caccia ai bug del 22/09: 08-11 + 10-12, 08-12, 08-13 + 18-10 (contratto C20).
"""

import datetime as dt
import json
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from common.auth import create_staff_tokens

from .. import views
from ..models import ActivityLog, Salon
from ..services import log_activity


def _frames_events(frames):
    """Eventi consegnati, frame per frame."""
    out = []
    for frame in frames:
        if "event: events" in frame:
            out.append(json.loads(frame.split("data: ", 1)[1])["events"])
    return out


class _Member(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="S", slug="s")
        self.user = User.objects.create_user(email="mara@x.it", password="pw-lunga-123")
        self.role = Role.objects.create(salon=self.salon, name="Reception", scopes=["agenda", "sales"])
        self.membership = Membership.objects.create(user=self.user, salon=self.salon, role=self.role)

    def _auth(self):
        tokens = create_staff_tokens(self.user, self.salon)
        return {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def _ticket(self):
        res = self.client.post("/api/core/activity/stream-ticket", **self._auth())
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["ticket"]

    def _stream(self, ticket, after=None):
        url = f"/api/core/activity/stream?ticket={ticket}" + (f"&after={after}" if after else "")
        return self.client.get(url)


class StreamTicketTests(_Member):
    """08-11 + 10-12: il biglietto era riusabile per 10 minuti e con permessi congelati."""

    def test_a_ticket_opens_one_stream_only(self):
        ticket = self._ticket()
        with patch.object(views, "STREAM_MAX_SECONDS", 0):
            first = self._stream(ticket)
            self.assertEqual(first.status_code, 200)
            b"".join(first.streaming_content)
            again = self._stream(ticket)
        self.assertEqual(again.status_code, 403)

    def test_removal_from_the_salon_invalidates_the_ticket(self):
        ticket = self._ticket()
        self.membership.delete()
        self.assertEqual(self._stream(ticket).status_code, 403)

    def test_a_password_change_invalidates_the_ticket(self):
        ticket = self._ticket()
        self.user.set_password("nuova-password-456")
        self.user.save(update_fields=["password", "token_version"])
        self.assertEqual(self._stream(ticket).status_code, 403)

    def test_a_deactivated_user_cannot_open_the_stream(self):
        ticket = self._ticket()
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self._stream(ticket).status_code, 403)

    def test_the_stream_uses_the_permissions_of_now(self):
        ticket = self._ticket()
        # dopo il biglietto la titolare le toglie la cassa
        self.role.scopes = ["agenda"]
        self.role.save(update_fields=["scopes"])
        before = log_activity(self.salon, "appointment.created", "Punto di partenza")
        log_activity(self.salon, "sale.created", "Incasso € 80")
        log_activity(self.salon, "appointment.moved", "Spostato")
        with patch.object(views, "STREAM_MAX_SECONDS", 0.05):
            stream = self._stream(ticket, after=before.id)
            self.assertEqual(stream.status_code, 200)
            body = b"".join(stream.streaming_content).decode()
        self.assertIn("appointment.moved", body)
        self.assertNotIn("sale.created", body)

    def test_an_open_stream_stops_soon_after_the_removal(self):
        ticket = self._ticket()
        with patch.object(views, "STREAM_MAX_SECONDS", 5), patch.object(views, "STREAM_ACCESS_CHECK_SECONDS", 0):
            stream = self._stream(ticket)
            frames = iter(stream.streaming_content)
            self.assertIn(b"event: ready", next(frames))
            self.membership.delete()
            log_activity(self.salon, "appointment.created", "Dopo la rimozione")
            rest = b"".join(frames).decode()
        self.assertIn("event: bye", rest)
        self.assertNotIn("Dopo la rimozione", rest)

    def test_a_permission_removed_mid_stream_stops_those_events(self):
        start = log_activity(self.salon, "appointment.created", "Partenza")
        log_activity(self.salon, "sale.created", "Incasso")
        log_activity(self.salon, "appointment.moved", "Spostato")
        with patch.object(views, "STREAM_ACCESS_CHECK_SECONDS", 0):
            frames = list(
                views.event_generator(
                    self.salon.id, start.id, scopes=["agenda", "sales"], max_seconds=0.05, poll=0,
                    access_check=lambda: (False, ["agenda"]),
                )
            )
        delivered = [e["type"] for batch in _frames_events(frames) for e in batch]
        self.assertEqual(delivered, ["appointment.moved"])


class KeepaliveTests(TestCase):
    """08-12: gli eventi invisibili a chi ascolta sopprimevano il keep-alive."""

    def test_a_ping_is_sent_even_while_invisible_events_keep_coming(self):
        salon = Salon.objects.create(name="S", slug="s")
        log_activity(salon, "appointment.created", "base")
        real_sleep = views.time.sleep

        def busy_sleep(seconds):
            # a ogni giro arriva una vendita, che un'operatrice «solo agenda» non vede
            log_activity(salon, "sale.created", "Vendita € 50")
            real_sleep(0.005)

        with patch.object(views, "STREAM_KEEPALIVE_SECONDS", 0.05), patch.object(views.time, "sleep", busy_sleep):
            frames = list(views.event_generator(salon.id, 0, scopes=["agenda"], max_seconds=0.4, poll=0.01))
        self.assertTrue(any(f.startswith(": ping") for f in frames))
        self.assertEqual(_frames_events(frames), [])


class LateCommitTests(_Member):
    """08-13 + 18-10: un evento con id più basso committato dopo uno più alto."""

    def _late_event(self, event_id, type_="appointment.created", age_seconds=0):
        event = ActivityLog.objects.create(id=event_id, salon=self.salon, type=type_, summary=f"late {event_id}")
        if age_seconds:
            ActivityLog.objects.filter(pk=event.pk).update(
                created_at=timezone.now() - dt.timedelta(seconds=age_seconds)
            )
        return event

    def test_the_stream_delivers_an_event_that_shows_up_below_the_cursor(self):
        ActivityLog.objects.create(id=1000, salon=self.salon, type="appointment.created", summary="dopo")
        real_sleep = views.time.sleep
        calls = []

        def commit_late(seconds):
            if not calls:
                # la transazione con l'id 999 committa solo adesso
                self._late_event(999)
                self._late_event(998, age_seconds=120)  # fuori finestra: resta perso
            calls.append(seconds)
            real_sleep(0)

        with patch.object(views.time, "sleep", commit_late):
            frames = list(views.event_generator(self.salon.id, 0, scopes=["agenda"], max_seconds=0.2, poll=0))
        delivered = [e["id"] for batch in _frames_events(frames) for e in batch]
        # consegnato una volta sola, anche se resta nella finestra per altri giri
        self.assertEqual(delivered, [999])
        self.assertIn('"cursor": 1000', frames[0])

    def test_a_fresh_stream_does_not_replay_the_window(self):
        log_activity(self.salon, "appointment.created", "appena prima di aprire")
        frames = list(views.event_generator(self.salon.id, 0, scopes=["agenda"], max_seconds=0.05, poll=0))
        self.assertEqual(_frames_events(frames), [])

    def test_polling_delivers_it_too(self):
        ActivityLog.objects.create(id=1000, salon=self.salon, type="appointment.created", summary="dopo")
        self._late_event(999)
        self._late_event(997, type_="sale.created")
        self._late_event(998, age_seconds=120)
        auth = self._auth()
        # un'operatrice con la sola agenda: il filtro per area vale anche qui
        self.role.scopes = ["agenda"]
        self.role.save(update_fields=["scopes"])
        data = self.client.get("/api/core/activity/feed?after=1000", **auth).json()
        self.assertEqual([e["id"] for e in data["events"]], [999])
        self.assertEqual(data["cursor"], 1000)
