"""Caccia ai bug del 22/09 — outbox verso Yourang: colonne, scadenze, consegna.

Ogni test descrive il comportamento giusto: prima delle correzioni fallivano.
"""

import datetime as dt

from django.db import connection
from django.test import TestCase
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
