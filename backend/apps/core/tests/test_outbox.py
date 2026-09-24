"""Outbox verso Yourang: consegna, ritentativi, ordine per oggetto, scadenze, pulizia.

Anche la diagnostica per il titolare (GET /api/core/outbox/status) e le
colonne che il codice di prima del deploy deve poter scrivere.
"""

import datetime as dt

from django.db import connection
from django.test import TestCase, override_settings
from django.utils import timezone

from common.testing import bearer

from ..models import OutboxEvent, Salon, SalonSettings
from ..services import emit_event


class FlushOutboxTests(TestCase):
    """La outbox viene consegnata davvero quando YOURANG_API_URL è configurato."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    @override_settings(YOURANG_API_URL="https://yourang.example/events", YOURANG_API_KEY="k")
    def test_delivery_marks_sent_and_failures_are_retried(self):
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import MAX_ATTEMPTS, flush_pending

        from ..models import OutboxEvent

        ok = emit_event(self.salon, "client.otp", {"code": "123456"})
        bad = emit_event(self.salon, "appointment.created", {"appointment_id": 1})

        def fake_post(url, json, headers):
            response = MagicMock()
            response.status_code = 200 if json["event_type"] == "client.otp" else 500
            response.text = "" if response.status_code == 200 else "boom"
            self.assertEqual(headers["Authorization"], "Bearer k")
            self.assertEqual(headers["Idempotency-Key"], f"outbox-{json['id']}")
            return response

        with patch("httpx.Client.post", side_effect=fake_post):
            sent, failed = flush_pending()
        self.assertEqual((sent, failed), (1, 1))
        ok.refresh_from_db()
        bad.refresh_from_db()
        self.assertEqual(ok.status, OutboxEvent.Status.SENT)
        self.assertIsNotNone(ok.sent_at)
        self.assertEqual(bad.status, OutboxEvent.Status.PENDING)
        self.assertEqual(bad.attempts, 1)
        self.assertIn("HTTP 500", bad.last_error)
        # Il ritentativo è rimandato: un secondo giro immediato non lo tocca.
        self.assertIsNotNone(bad.next_attempt_at)
        with patch("httpx.Client.post", side_effect=fake_post):
            self.assertEqual(flush_pending(), (0, 0))

        bad.attempts = MAX_ATTEMPTS - 1
        bad.next_attempt_at = None
        bad.save(update_fields=["attempts", "next_attempt_at"])
        with patch("httpx.Client.post", side_effect=fake_post):
            flush_pending()
        bad.refresh_from_db()
        self.assertEqual(bad.status, OutboxEvent.Status.FAILED)
        self.assertIsNone(bad.next_attempt_at)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_the_wait_before_a_retry_doubles(self):
        from apps.core.management.commands.flush_outbox import _backoff_seconds

        waits = [_backoff_seconds(n) for n in range(1, 9)]
        self.assertEqual(waits[:4], [30, 60, 120, 240])
        self.assertTrue(all(b >= a for a, b in zip(waits, waits[1:])))
        # otto tentativi non si consumano più in quaranta secondi di disservizio
        self.assertGreater(sum(waits), 3600)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_an_event_already_taken_by_another_worker_is_not_sent_twice(self):
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import flush_pending

        from ..models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "123456"})
        calls = []

        def fake_post(url, json, headers):
            calls.append(json["id"])
            response = MagicMock()
            response.status_code = 200
            response.text = ""
            return response

        # un altro worker l'ha già preso in carico un istante fa
        OutboxEvent.objects.filter(pk=event.pk).update(
            status=OutboxEvent.Status.SENDING, claimed_at=timezone.now()
        )
        with patch("httpx.Client.post", side_effect=fake_post):
            self.assertEqual(flush_pending(), (0, 0))
        self.assertEqual(calls, [])

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_the_claim_is_stamped_when_it_really_happens(self):
        """L'ultimo evento di un giro lungo non deve risultare preso in carico
        all'inizio del giro: il worker successivo lo considerava abbandonato
        mentre era ancora in volo e la cliente riceveva due volte lo stesso OTP.
        """
        from datetime import timedelta
        from itertools import count
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import (
            STALE_CLAIM_SECONDS,
            flush_pending,
            release_stale_claims,
        )

        from ..models import OutboxEvent

        first = emit_event(self.salon, "client.otp", {"code": "1"})
        last = emit_event(self.salon, "client.otp", {"code": "2"})
        claims = {}

        def slow_post(url, json, headers):
            claims[json["id"]] = OutboxEvent.objects.get(pk=json["id"]).claimed_at
            return MagicMock(status_code=200, text="")

        # Orologio che avanza di dieci minuti a ogni lettura: è il caso reale di
        # Yourang lento con la coda piena, dove fra il primo e l'ultimo evento
        # del giro passa più della finestra di recupero.
        base = timezone.now()
        ticks = count()
        with patch(
            "django.utils.timezone.now", side_effect=lambda: base + timedelta(minutes=10 * next(ticks))
        ):
            with patch("httpx.Client.post", side_effect=slow_post):
                flush_pending()

        gap = (claims[last.id] - claims[first.id]).total_seconds()
        self.assertGreaterEqual(gap, STALE_CLAIM_SECONDS)  # con l'ora di inizio giro era 0
        # L'ultimo evento, appena preso in carico, non risulta abbandonato.
        OutboxEvent.objects.filter(pk=last.pk).update(
            status=OutboxEvent.Status.SENDING, claimed_at=claims[last.id]
        )
        self.assertEqual(release_stale_claims(now=claims[last.id] + timedelta(seconds=60)), 0)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_an_event_stuck_in_sending_goes_back_in_the_queue(self):
        from datetime import timedelta

        from apps.core.management.commands.flush_outbox import (
            STALE_CLAIM_SECONDS,
            release_stale_claims,
        )

        from ..models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "123456"})
        OutboxEvent.objects.filter(pk=event.pk).update(
            status=OutboxEvent.Status.SENDING,
            claimed_at=timezone.now() - timedelta(seconds=STALE_CLAIM_SECONDS + 60),
        )
        self.assertEqual(release_stale_claims(), 1)
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.Status.PENDING)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_the_access_code_is_wiped_once_the_message_is_delivered(self):
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import flush_pending

        event = emit_event(
            self.salon, "client.otp", {"code": "123456", "phone": "+393331112222"}
        )
        response = MagicMock(status_code=200, text="")
        with patch("httpx.Client.post", return_value=response):
            flush_pending()
        event.refresh_from_db()
        self.assertEqual(event.payload["code"], "***")
        self.assertEqual(event.payload["phone"], "+393331112222")

    def test_delivered_events_are_purged_after_the_retention_window(self):
        from datetime import timedelta

        from apps.core.management.commands.flush_outbox import (
            PURGE_AFTER_DAYS,
            purge_delivered,
        )

        from ..models import OutboxEvent

        old = emit_event(self.salon, "client.otp", {})
        recent = emit_event(self.salon, "client.otp", {})
        failed = emit_event(self.salon, "client.otp", {})
        now = timezone.now()
        OutboxEvent.objects.filter(pk=old.pk).update(
            status=OutboxEvent.Status.SENT, sent_at=now - timedelta(days=PURGE_AFTER_DAYS + 1)
        )
        OutboxEvent.objects.filter(pk=recent.pk).update(
            status=OutboxEvent.Status.SENT, sent_at=now
        )
        OutboxEvent.objects.filter(pk=failed.pk).update(status=OutboxEvent.Status.FAILED)

        self.assertEqual(purge_delivered(), 1)
        self.assertFalse(OutboxEvent.objects.filter(pk=old.pk).exists())
        # quelli recenti e quelli falliti restano: i falliti servono a capire cosa non va
        self.assertTrue(OutboxEvent.objects.filter(pk=recent.pk).exists())
        self.assertTrue(OutboxEvent.objects.filter(pk=failed.pk).exists())

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_an_unexpected_network_error_does_not_escape(self):
        from unittest.mock import patch

        from apps.core.management.commands.flush_outbox import flush_pending

        from ..models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "123456"})
        with patch("httpx.Client.post", side_effect=OSError("rete sparita")):
            self.assertEqual(flush_pending(), (0, 1))
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.Status.PENDING)
        self.assertIn("rete sparita", event.last_error)

    def test_without_url_nothing_is_sent(self):
        from apps.core.management.commands.flush_outbox import Command

        emit_event(self.salon, "client.otp", {"code": "123456"})
        out = Command()
        from io import StringIO

        out.stdout = StringIO()
        with override_settings(YOURANG_API_URL=""):
            out.handle(limit=200, loop=False, interval=1)
        self.assertIn("non configurato", out.stdout.getvalue())


class OutboxStatusApiTests(TestCase):
    """La diagnostica dice al titolare perché un OTP «non arriva»."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="owner2@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = bearer(owner, self.salon)
        staff = User.objects.create_user(email="front2@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front", scopes=["agenda"])
        Membership.objects.create(user=staff, salon=self.salon, role=role)
        self.staff_auth = bearer(staff, self.salon)

    @override_settings(YOURANG_API_URL="")
    def test_without_delivery_url_the_queue_is_reported(self):
        emit_event(self.salon, "client.otp", {"code": "123456"})
        emit_event(self.salon, "appointment.created", {"appointment_id": 1})
        res = self.client.get("/api/core/outbox/status", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        self.assertFalse(data["configured"])
        self.assertEqual(data["pending"], 2)
        self.assertEqual(data["sent_24h"], 0)
        self.assertIn("client.otp", data["pending_types"])
        self.assertIsNotNone(data["oldest_pending_at"])

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_configured_reports_delivered_messages(self):
        from django.utils import timezone

        from ..models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "1"})
        OutboxEvent.objects.filter(pk=event.pk).update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
        data = self.client.get("/api/core/outbox/status", **self.auth).json()
        self.assertTrue(data["configured"])
        self.assertEqual((data["pending"], data["sent_24h"]), (0, 1))
        self.assertIsNotNone(data["last_sent_at"])

    def test_only_the_owner_sees_it(self):
        self.assertEqual(self.client.get("/api/core/outbox/status", **self.staff_auth).status_code, 403)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_scheduled_and_expired_are_counted_apart(self):
        """Una campagna programmata non è una coda ferma; gli scaduti si vedono."""
        from ..models import OutboxEvent

        emit_event(self.salon, "communication.send", {"communication_id": 1}, delay_seconds=3 * 86400)
        late = emit_event(self.salon, "appointment.created", {"appointment_id": 1})
        gone = emit_event(self.salon, "client.otp", {"code": "1"})
        OutboxEvent.objects.filter(pk=gone.pk).update(status=OutboxEvent.Status.EXPIRED)
        data = self.client.get("/api/core/outbox/status", **self.auth).json()
        self.assertEqual((data["pending"], data["scheduled"], data["expired"]), (1, 1, 1))
        self.assertEqual(data["pending_types"], ["appointment.created"])
        late.refresh_from_db()
        self.assertEqual(data["oldest_pending_at"][:19], late.due_at.isoformat()[:19])


# ---------------------------------------------------------------------------
# Caccia ai bug del 22/09 — outbox verso Yourang: colonne, scadenze, consegna.
#
# Ogni test descrive il comportamento giusto: prima delle correzioni fallivano.
# ---------------------------------------------------------------------------


def _insert_without(model, instance, missing: tuple[str, ...]) -> None:
    """INSERT grezzo che non nomina le colonne `missing`: è quello che fa il
    codice di prima del deploy, che quelle colonne non le conosce."""
    fields = [
        f for f in model._meta.concrete_fields
        if not f.primary_key and f.name not in missing
    ]
    columns = ", ".join(connection.ops.quote_name(f.column) for f in fields)
    values = [f.get_db_prep_save(f.pre_save(instance, add=True), connection) for f in fields]
    placeholders = ", ".join(["%s"] * len(fields))
    with connection.cursor() as cursor:
        cursor.execute(
            f"INSERT INTO {connection.ops.quote_name(model._meta.db_table)} "
            f"({columns}) VALUES ({placeholders})",
            values,
        )


class ColumnsAddedBy0009HaveADatabaseDefaultTests(TestCase):
    """11-13: il container vecchio, sul database già migrato, deve poter scrivere."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_an_event_written_by_the_old_code_gets_an_empty_key(self):
        _insert_without(
            OutboxEvent,
            OutboxEvent(salon=self.salon, event_type="client.otp", payload={"code": "1"}),
            missing=("coalesce_key", "due_at"),
        )
        event = OutboxEvent.objects.get(event_type="client.otp")
        self.assertEqual(event.coalesce_key, "")
        self.assertIsNone(event.due_at)

    def test_settings_written_by_the_old_code_get_the_default_delay(self):
        _insert_without(
            SalonSettings, SalonSettings(salon=self.salon), missing=("automation_delay_seconds",)
        )
        self.assertEqual(
            SalonSettings.objects.get(salon=self.salon).automation_delay_seconds, 30
        )


class DueAtTests(TestCase):
    """Da quando un evento è consegnabile: serve a misurarne l'età (11-09)."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_an_immediate_event_is_due_from_its_creation(self):
        before = timezone.now()
        event = emit_event(self.salon, "client.otp", {"code": "1"})
        self.assertIsNone(event.next_attempt_at)
        self.assertGreaterEqual(event.due_at, before)
        self.assertLessEqual(event.due_at, timezone.now())

    def test_a_held_event_is_due_when_the_hold_ends(self):
        event = emit_event(self.salon, "communication.send", {}, delay_seconds=3600)
        self.assertEqual(event.due_at, event.next_attempt_at)
        self.assertGreater(event.due_at, timezone.now() + dt.timedelta(minutes=59))


class UndoEntriesArePurgedTests(TestCase):
    """03-16: le voci scadute se ne vanno anche per chi non fa più gesti."""

    def test_only_expired_entries_are_removed(self):
        from apps.accounts.models import User
        from apps.agenda.models import UndoEntry
        from apps.agenda.undo import UNDO_WINDOW_MINUTES, purge_expired

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        old = UndoEntry.objects.create(salon=salon, actor=user, kind="move", label="vecchia")
        fresh = UndoEntry.objects.create(salon=salon, actor=user, kind="move", label="nuova")
        UndoEntry.objects.filter(pk=old.pk).update(
            created_at=timezone.now() - dt.timedelta(minutes=UNDO_WINDOW_MINUTES + 1)
        )
        self.assertEqual(purge_expired(), 1)
        self.assertFalse(UndoEntry.objects.filter(pk=old.pk).exists())
        self.assertTrue(UndoEntry.objects.filter(pk=fresh.pk).exists())


def _fake_yourang(sent: list, *, failing=()):
    """httpx.Client.post finto: registra (tipo, id) e risponde 502 ai tipi in `failing`."""
    from unittest.mock import MagicMock

    def post(url, json=None, headers=None):
        response = MagicMock()
        if json["event_type"] in failing:
            response.status_code, response.text = 502, "bad gateway"
        else:
            response.status_code, response.text = 200, ""
            sent.append((json["event_type"], json["id"]))
        return response

    return post


@override_settings(YOURANG_API_URL="https://yourang.example/events")
class DeliveryOrderPerObjectTests(TestCase):
    """11-08 / 18-05: gli eventi dello stesso oggetto partono nell'ordine in cui sono nati."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _flush(self, sent, **kwargs):
        from unittest.mock import patch

        from ..management.commands.flush_outbox import flush_pending

        with patch("httpx.Client.post", side_effect=_fake_yourang(sent, **kwargs)):
            return flush_pending()

    def test_a_retried_confirmation_is_not_overtaken_by_the_cancellation(self):
        created = emit_event(self.salon, "appointment.created", {}, coalesce_key="appointment:7")
        sent = []
        self.assertEqual(self._flush(sent, failing=("appointment.created",)), (0, 1))
        created.refresh_from_db()
        self.assertEqual((created.status, created.attempts), (OutboxEvent.Status.PENDING, 1))

        cancelled = emit_event(self.salon, "appointment.cancelled", {}, coalesce_key="appointment:7")
        otp = emit_event(self.salon, "client.otp", {"code": "1"})
        other = emit_event(self.salon, "appointment.moved", {}, coalesce_key="appointment:8")
        self._flush(sent)
        # la conferma aspetta il suo ritentativo: l'annullamento non la scavalca,
        # mentre gli eventi di altri oggetti (o senza oggetto) partono
        self.assertEqual(sent, [("client.otp", otp.id), ("appointment.moved", other.id)])

        OutboxEvent.objects.filter(pk=created.pk).update(next_attempt_at=timezone.now())
        self._flush(sent)
        self._flush(sent)
        self.assertEqual(
            [event_id for _, event_id in sent[2:]], [created.id, cancelled.id]
        )

    def test_what_is_no_longer_coming_does_not_block(self):
        for status in (
            OutboxEvent.Status.FAILED,
            OutboxEvent.Status.SUPERSEDED,
            OutboxEvent.Status.EXPIRED,
        ):
            old = emit_event(self.salon, "appointment.created", {}, coalesce_key=f"appointment:{status}")
            OutboxEvent.objects.filter(pk=old.pk).update(status=status)
            emit_event(self.salon, "appointment.moved", {}, coalesce_key=f"appointment:{status}")
        sent = []
        self._flush(sent)
        self.assertEqual([kind for kind, _ in sent], ["appointment.moved"] * 3)


@override_settings(YOURANG_API_URL="https://yourang.example/events")
class ClaimRereadsTheEventTests(TestCase):
    """03-08 / 11-15 / 18-09: il worker non consegna la copia letta prima della fusione."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_a_hold_extended_after_the_listing_is_respected(self):
        from ..management.commands.flush_outbox import _claim

        event = emit_event(self.salon, "appointment.created", {"start": "x"}, delay_seconds=30)
        OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
        stale = OutboxEvent.objects.get(pk=event.pk)  # il worker legge la coda...
        # ...e una correzione dell'agenda fonde l'evento e allunga la trattenuta
        OutboxEvent.objects.filter(pk=event.pk).update(
            payload={"start": "16:00"}, next_attempt_at=timezone.now() + dt.timedelta(seconds=30)
        )
        self.assertFalse(_claim(stale))
        self.assertEqual(OutboxEvent.objects.get(pk=event.pk).status, OutboxEvent.Status.PENDING)

    def test_what_leaves_is_what_is_in_the_database(self):
        from unittest.mock import MagicMock

        from ..management.commands.flush_outbox import _claim, deliver_event

        event = emit_event(self.salon, "appointment.created", {"start": "10:00"})
        stale = OutboxEvent.objects.select_related("salon").get(pk=event.pk)
        OutboxEvent.objects.filter(pk=event.pk).update(
            event_type="appointment.moved", payload={"start": "16:00"}
        )
        posted = []
        client = MagicMock()
        client.post.side_effect = lambda url, json=None, headers=None: (
            posted.append(json) or MagicMock(status_code=200, text="")
        )
        self.assertTrue(_claim(stale))
        self.assertTrue(deliver_event(stale, client=client))
        self.assertEqual(posted[0]["event_type"], "appointment.moved")
        self.assertEqual(posted[0]["payload"], {"start": "16:00"})
        # e a database resta il contenuto fuso, non la copia vecchia
        self.assertEqual(OutboxEvent.objects.get(pk=event.pk).payload, {"start": "16:00"})


@override_settings(YOURANG_API_URL="https://yourang.example/events")
class StaleMessagesExpireTests(TestCase):
    """11-09: l'arretrato che non ha più senso non parte."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _age(self, event, **delta):
        moment = timezone.now() - dt.timedelta(**delta)
        OutboxEvent.objects.filter(pk=event.pk).update(created_at=moment, due_at=moment)

    def _flush(self):
        from unittest.mock import patch

        from ..management.commands.flush_outbox import flush_pending

        sent = []
        with patch("httpx.Client.post", side_effect=_fake_yourang(sent)):
            flush_pending()
        return {event_id for _, event_id in sent}

    def test_each_kind_of_message_lives_as_long_as_it_makes_sense(self):
        future = (timezone.now() + dt.timedelta(days=2)).isoformat()
        past = (timezone.now() - dt.timedelta(hours=1)).isoformat()
        old_otp = emit_event(self.salon, "client.otp", {"code": "1"})
        self._age(old_otp, minutes=11)
        fresh_otp = emit_event(self.salon, "client.otp", {"code": "2"})
        past_visit = emit_event(self.salon, "appointment.created", {"start": past})
        next_visit = emit_event(self.salon, "appointment.moved", {"start": future})
        self._age(next_visit, days=40)  # vecchio, ma la visita deve ancora venire
        old_campaign = emit_event(self.salon, "communication.send", {"title": "Saldi di agosto"})
        self._age(old_campaign, days=45)
        contact = emit_event(self.salon, "client.created", {"client_id": 1})
        self._age(contact, days=60)  # anagrafica: a Yourang serve comunque

        delivered = self._flush()

        self.assertEqual(delivered, {fresh_otp.id, next_visit.id, contact.id})
        for event in (old_otp, past_visit, old_campaign):
            event.refresh_from_db()
            self.assertEqual(event.status, OutboxEvent.Status.EXPIRED, event.event_type)
            self.assertIn("Scaduto", event.last_error)

    def test_a_scheduled_campaign_that_hits_a_hiccup_is_not_thrown_away(self):
        """Programmata giorni fa per un'ora fa, primo invio fallito: è ancora in tempo."""
        campaign = emit_event(self.salon, "communication.send", {"title": "Autunno"}, delay_seconds=60)
        moment = timezone.now() - dt.timedelta(hours=1)
        OutboxEvent.objects.filter(pk=campaign.pk).update(
            created_at=timezone.now() - dt.timedelta(days=3),
            due_at=moment,
            attempts=1,
            next_attempt_at=timezone.now(),
        )
        self.assertEqual(self._flush(), {campaign.id})

    def test_expired_messages_are_purged_like_the_superseded_ones(self):
        from ..management.commands.flush_outbox import PURGE_AFTER_DAYS, purge_delivered

        event = emit_event(self.salon, "client.otp", {"code": "1"})
        OutboxEvent.objects.filter(pk=event.pk).update(
            status=OutboxEvent.Status.EXPIRED,
            created_at=timezone.now() - dt.timedelta(days=PURGE_AFTER_DAYS + 1),
        )
        self.assertEqual(purge_delivered(), 1)


class HousekeepingWithoutDeliveryUrlTests(TestCase):
    """11-09: senza YOURANG_API_URL la coda non si consegna, ma si pulisce."""

    @override_settings(YOURANG_API_URL="")
    def test_the_command_still_cleans_up(self):
        from io import StringIO

        from apps.accounts.models import User
        from apps.agenda.models import UndoEntry
        from common import ratelimit

        from ..management.commands.flush_outbox import Command
        from ..models import RateLimitCounter

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        old = emit_event(salon, "appointment.created", {"phone": "+393331234567"})
        OutboxEvent.objects.filter(pk=old.pk).update(
            status=OutboxEvent.Status.SUPERSEDED, created_at=timezone.now() - dt.timedelta(days=90)
        )
        otp = emit_event(salon, "client.otp", {"code": "123456"})
        OutboxEvent.objects.filter(pk=otp.pk).update(due_at=timezone.now() - dt.timedelta(hours=1))
        ratelimit.hit("probe:1", 5, 60)
        RateLimitCounter.objects.update(expires_at=timezone.now() - dt.timedelta(seconds=1))
        user = User.objects.create_user(email="banco@theparlour.it", password="x" * 10)
        entry = UndoEntry.objects.create(salon=salon, actor=user, kind="move", label="x")
        UndoEntry.objects.filter(pk=entry.pk).update(created_at=timezone.now() - dt.timedelta(hours=1))

        command = Command()
        command.stdout = StringIO()
        command.handle(limit=200, loop=False, interval=1, purge_days=30)

        self.assertIn("non configurato", command.stdout.getvalue())
        self.assertFalse(OutboxEvent.objects.filter(pk=old.pk).exists())
        otp.refresh_from_db()
        self.assertEqual(otp.status, OutboxEvent.Status.EXPIRED)
        self.assertFalse(RateLimitCounter.objects.exists())
        self.assertFalse(UndoEntry.objects.exists())


class LastDeliveredMessageSurvivesThePurgeTests(TestCase):
    """L'ultimo messaggio consegnato su un appuntamento ancora da venire resta:
    è ciò che la cliente sa, e l'agenda lo confronta prima di rettificare."""

    def test_only_the_last_message_about_an_upcoming_visit_is_kept(self):
        from ..management.commands.flush_outbox import PURGE_AFTER_DAYS, purge_delivered

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        future = (timezone.now() + dt.timedelta(days=20)).isoformat()
        past = (timezone.now() - dt.timedelta(days=1)).isoformat()
        first = emit_event(salon, "appointment.moved", {"start": future}, coalesce_key="appointment:1")
        last = emit_event(salon, "appointment.moved", {"start": future}, coalesce_key="appointment:1")
        receipt = emit_event(salon, "deposit.paid", {"start": future}, coalesce_key="appointment:1")
        visit_over = emit_event(salon, "appointment.created", {"start": past}, coalesce_key="appointment:2")
        otp = emit_event(salon, "client.otp", {"code": "1"})
        OutboxEvent.objects.update(
            status=OutboxEvent.Status.SENT,
            sent_at=timezone.now() - dt.timedelta(days=PURGE_AFTER_DAYS + 10),
        )
        self.assertEqual(purge_delivered(), 3)
        # l'ultimo spostamento resta anche se dopo è arrivata la ricevuta della caparra
        self.assertEqual(
            sorted(OutboxEvent.objects.values_list("id", flat=True)), [last.id, receipt.id]
        )
        self.assertFalse(OutboxEvent.objects.filter(id__in=[first.id, visit_over.id, otp.id]).exists())


@override_settings(YOURANG_API_URL="https://yourang.example/events")
class HeldEventsDoNotBlockTests(TestCase):
    """Revisione finale: il link della caparra non aspetta una conferma solo trattenuta."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _flush(self, sent, **kwargs):
        from unittest.mock import patch

        from ..management.commands.flush_outbox import flush_pending

        with patch("httpx.Client.post", side_effect=_fake_yourang(sent, **kwargs)):
            return flush_pending()

    def test_a_deposit_link_does_not_wait_for_a_held_confirmation(self):
        held = emit_event(self.salon, "appointment.created", {}, delay_seconds=600, coalesce_key="appointment:7")
        link = emit_event(self.salon, "deposit.payment_link", {}, coalesce_key="appointment:7")
        sent = []
        self._flush(sent)
        # il termine per pagare corre: il link parte subito, la conferma alla sua ora
        self.assertEqual(sent, [("deposit.payment_link", link.id)])
        held.refresh_from_db()
        self.assertEqual(held.status, OutboxEvent.Status.PENDING)

    def test_but_it_still_waits_for_a_message_being_retried(self):
        retrying = emit_event(self.salon, "appointment.created", {}, coalesce_key="appointment:8")
        sent = []
        self._flush(sent, failing=("appointment.created",))
        retrying.refresh_from_db()
        self.assertEqual(retrying.attempts, 1)
        link = emit_event(self.salon, "deposit.payment_link", {}, coalesce_key="appointment:8")
        self._flush(sent)
        self.assertNotIn(("deposit.payment_link", link.id), sent)
