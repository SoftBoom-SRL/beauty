"""Caccia ai bug del 22/09 — outbox verso Yourang: colonne, scadenze, consegna.

Ogni test descrive il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt

from django.db import connection
from django.test import TestCase, override_settings
from django.utils import timezone

from .models import OutboxEvent, Salon, SalonSettings
from .services import emit_event


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

        from .management.commands.flush_outbox import flush_pending

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
        from .management.commands.flush_outbox import _claim

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

        from .management.commands.flush_outbox import _claim, deliver_event

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

        from .management.commands.flush_outbox import flush_pending

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
        from .management.commands.flush_outbox import PURGE_AFTER_DAYS, purge_delivered

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

        from .management.commands.flush_outbox import Command
        from .models import RateLimitCounter

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
