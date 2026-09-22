"""Probe temporanei del revisore 11 (consegna outbox). DA CANCELLARE a fine revisione."""

import datetime as dt
from io import StringIO
from unittest.mock import MagicMock, patch

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.agenda import services
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.management.commands import flush_outbox
from apps.core.models import OutboxEvent, Salon
from apps.core.services import emit_event
from apps.staff.models import Operator


@override_settings(YOURANG_API_URL="https://yourang.example/events")
class OutboxDeliveryProbe(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+393331234567")
        self.op = Operator.objects.create(salon=self.salon, first_name="Giulia")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.svc = Service.objects.create(salon=self.salon, category=cat, name_it="Piega",
                                          duration_min=60, price=30)
        day = timezone.localdate() + dt.timedelta(days=5)
        self.start = timezone.make_aware(dt.datetime.combine(day, dt.time(10, 0)))
        self.appt = Appointment.objects.create(salon=self.salon, client=self.client_obj,
                                               operator=self.op, start=self.start)
        AppointmentService.objects.create(appointment=self.appt, service=self.svc, operator=self.op,
                                          duration_min=60, price=30)

    def test_a_retried_confirmation_arrives_after_the_cancellation(self):
        base = timezone.now()
        clock = {"now": base}
        delivered = []
        failures = {"n": 2}

        def post(url, json, headers):
            response = MagicMock()
            if json["event_type"] == "appointment.created" and failures["n"] > 0:
                failures["n"] -= 1
                response.status_code, response.text = 502, "bad gateway"
            else:
                response.status_code, response.text = 200, ""
                delivered.append((json["event_type"], json["payload"].get("start")))
            return response

        with patch("django.utils.timezone.now", side_effect=lambda: clock["now"]), \
                patch("httpx.Client.post", side_effect=post):
            services.emit_appointment_event(self.appt, "appointment.created")
            clock["now"] = base + dt.timedelta(seconds=31)
            flush_outbox.flush_pending()          # 502: attempts=1, riprova fra 30 s
            clock["now"] = base + dt.timedelta(seconds=40)
            services.cancel_appointment(self.appt, reason="malattia")  # dal salone
            clock["now"] = base + dt.timedelta(seconds=62)
            flush_outbox.flush_pending()          # 502 di nuovo: riprova fra 60 s
            clock["now"] = base + dt.timedelta(seconds=71)
            flush_outbox.flush_pending()          # parte l'annullamento
            clock["now"] = base + dt.timedelta(seconds=123)
            flush_outbox.flush_pending()          # parte la conferma
        kinds = [k for k, _ in delivered if k.startswith("appointment.")]
        self.assertEqual(kinds, ["appointment.cancelled", "appointment.created"])

    def test_a_merge_committed_after_the_listing_is_sent_with_the_old_payload(self):
        base = timezone.now()
        clock = {"now": base}
        posted = []

        def post(url, json, headers):
            posted.append(json)
            return MagicMock(status_code=200, text="")

        real_claim = flush_outbox._claim

        def claim_after_merge(event):
            # la correzione della reception era partita a 29,9 s (trattenuta ancora
            # attiva) e fa commit solo adesso, dopo che il worker ha letto la coda
            saved = clock["now"]
            clock["now"] = base + dt.timedelta(seconds=29.9)
            self.appt.start = self.start + dt.timedelta(hours=1)
            self.appt.save(update_fields=["start"])
            services.emit_appointment_event(self.appt, "appointment.moved")
            clock["now"] = saved
            return real_claim(event)

        with patch("django.utils.timezone.now", side_effect=lambda: clock["now"]), \
                patch("httpx.Client.post", side_effect=post), \
                patch.object(flush_outbox, "_claim", side_effect=claim_after_merge):
            event = services.emit_appointment_event(self.appt, "appointment.created")
            clock["now"] = base + dt.timedelta(seconds=30.5)
            flush_outbox.flush_pending()
        self.assertEqual(len(posted), 1)
        self.assertEqual(posted[0]["payload"]["start"], self.start.isoformat())  # orario vecchio
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.Status.SENT)
        # e il payload fuso (11:00) è stato sovrascritto con quello vecchio
        self.assertEqual(event.payload["start"], self.start.isoformat())

    def test_the_backlog_leaves_whatever_its_age(self):
        otp = emit_event(self.salon, "client.otp", {"code": "123456", "phone": "+393331234567"})
        past = emit_event(self.salon, "appointment.created",
                          {"start": (timezone.now() - dt.timedelta(days=40)).isoformat()})
        promo = emit_event(self.salon, "communication.send", {"text": "Saldi di agosto"})
        OutboxEvent.objects.filter(pk__in=[otp.pk, past.pk, promo.pk]).update(
            created_at=timezone.now() - dt.timedelta(days=45)
        )
        with patch("httpx.Client.post", return_value=MagicMock(status_code=200, text="")) as post:
            sent, failed = flush_outbox.flush_pending()
        self.assertEqual((sent, failed), (3, 0))
        self.assertEqual(post.call_count, 3)

    @override_settings(YOURANG_API_URL="")
    def test_without_url_nothing_is_ever_purged(self):
        old = emit_event(self.salon, "appointment.created", {"phone": "+393331234567"})
        OutboxEvent.objects.filter(pk=old.pk).update(
            status=OutboxEvent.Status.SUPERSEDED, created_at=timezone.now() - dt.timedelta(days=90)
        )
        cmd = flush_outbox.Command()
        cmd.stdout = StringIO()
        cmd.handle(limit=200, loop=False, interval=1, purge_days=30)
        self.assertTrue(OutboxEvent.objects.filter(pk=old.pk).exists())
