"""Caccia del 22/09 — prenotazioni Yourang in agenda.

11-03 stato remoto su una visita già in mano al salone · 11-04/01-09 segnaposto
idoneo per ogni operatrice · 11-05/18-13 annullamento remoto dal dominio ·
11-06 registro attività (feed live) · 11-07 ri-consegne che annullavano ciò che
il salone aveva deciso · 11-16 consegne concorrenti · 11-17 prenotazioni senza
telefono · 08-05 (lato sync) rubrica senza «since» di oggi.

    python manage.py test apps.integrations.tests_caccia22_eventi
"""

import datetime as dt
import importlib
from unittest import mock

from django.apps import apps as django_apps
from django.test import TestCase
from django.utils import timezone

from apps.accounts.models import User
from apps.agenda import services
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, OutboxEvent, Salon
from apps.integrations import sync
from apps.integrations.models import YourangConnection, YourangEventSync
from apps.staff.models import Operator
from common.phone import phone_key


class _EventCase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.op = Operator.objects.create(salon=self.salon, first_name="Anna")
        self.conn = YourangConnection.objects.create(salon=self.salon, yourang_org_id="org1")
        self.user = User.objects.create_user(email="rec@p.it", password="x-Segretissima-1")
        day = timezone.localdate() + dt.timedelta(days=3)
        self.start = timezone.make_aware(dt.datetime.combine(day, dt.time(10, 0)))
        self.event = {
            "client_full_name": "Mario Rossi",
            "client_phone_number": "3331234567",
            "starting_date": self.start.isoformat(),
            "ending_date": (self.start + dt.timedelta(hours=1)).isoformat(),
            "status": "confirmed",
        }

    def _import(self, event_id, **changes):
        data = {**self.event, **changes}
        with mock.patch("apps.integrations.sync.YourangClient.get_event", return_value=data):
            return sync.import_event(self.conn, event_id)

    def _set_status(self, appt, status):
        Appointment.objects.filter(pk=appt.pk).update(status=status)
        appt.refresh_from_db()

    def _logs(self, prefix="appointment."):
        return list(
            ActivityLog.objects.filter(salon=self.salon, type__startswith=prefix)
            .order_by("id")
            .values_list("type", flat=True)
        )


class RemoteStatusTests(_EventCase):
    """11-03: su una visita già in mano al salone lo stato remoto non si applica."""

    def test_terminal_remote_states_leave_a_visit_in_the_salon_hands_alone(self):
        cases = [
            (Appointment.Status.IN_PROGRESS, "no_show"),
            (Appointment.Status.IN_PROGRESS, "cancelled"),
            (Appointment.Status.CHECKED_IN, "completed"),
            (Appointment.Status.CHECKED_IN, "no_show"),
            (Appointment.Status.CLOSED, "cancelled"),
            (Appointment.Status.NO_SHOW, "cancelled"),
        ]
        for i, (local, remote) in enumerate(cases):
            with self.subTest(local=local, remote=remote):
                appt = self._import(f"evt-{i}")
                self._set_status(appt, local)
                self._import(f"evt-{i}", status=remote)
                appt.refresh_from_db()
                self.assertEqual(appt.status, local)

    def test_remote_completed_or_no_show_do_not_close_a_confirmed_visit(self):
        """Chiudere il conto (o segnare il no-show) lo decide il salone: un
        «completed» di Yourang lasciava la visita chiusa senza vendita."""
        for i, remote in enumerate(("completed", "closed", "no_show")):
            with self.subTest(remote=remote):
                appt = self._import(f"evt-c{i}")
                self._import(f"evt-c{i}", status=remote)
                appt.refresh_from_db()
                self.assertEqual(appt.status, Appointment.Status.CONFIRMED)

    def test_remote_cancellation_of_a_confirmed_visit_still_applies(self):
        appt = self._import("evt-x")
        self._import("evt-x", status="rejected")
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CANCELLED)


class PlaceholderEligibilityTests(_EventCase):
    """11-04/01-09: una prenotazione Yourang si sposta e si allunga, anche su
    operatrici create o modificate dopo il collegamento."""

    def setUp(self):
        super().setUp()
        self.marta = Operator.objects.create(salon=self.salon, first_name="Marta")

    def test_the_booking_moves_to_another_operator_and_grows(self):
        appt = self._import("evt-move")
        self.assertEqual(appt.operator_id, self.op.id)
        services.move_appointment(appt, appt.start, operator=self.marta, actor=self.user,
                                  force=True, client_overlap_ok=True)
        appt.refresh_from_db()
        self.assertEqual(appt.operator_id, self.marta.id)
        item = appt.items.get()
        services.edit_appointment(
            appt,
            items=[{"id": item.id, "service_id": item.service_id,
                    "operator_id": self.marta.id, "duration_min": 90}],
            force=True, actor=self.user,
        )
        appt.refresh_from_db()
        self.assertEqual(appt.total_duration_min, 90)

    def test_operators_created_or_edited_later_stay_eligible(self):
        """La scheda «nuova operatrice» manda solo i servizi del listino, e ogni
        salvataggio riscrive l'intera relazione (services.set)."""
        placeholder = sync._yourang_service(self.salon)
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        piega = Service.objects.create(salon=self.salon, category=cat, name_it="Piega",
                                       duration_min=30, price=20)
        # come _apply_operator_payload del modulo staff: save() e poi set()
        nuova = Operator(salon=self.salon, first_name="Nuova")
        nuova.save()
        nuova.services.set(Service.objects.filter(id__in=[piega.id]))
        self.assertEqual(set(nuova.services.values_list("id", flat=True)), {piega.id, placeholder.id})
        self.marta.services.set([piega])
        self.assertIn(placeholder.id, self.marta.services.values_list("id", flat=True))
        self.marta.services.clear()
        self.assertIn(placeholder.id, self.marta.services.values_list("id", flat=True))
        placeholder.operators.remove(self.op)
        self.assertIn(self.op.id, placeholder.operators.values_list("id", flat=True))
        # e la prenotazione ci arriva
        appt = self._import("evt-nuova")
        services.move_appointment(appt, appt.start, operator=nuova, actor=self.user,
                                  force=True, client_overlap_ok=True)
        appt.refresh_from_db()
        self.assertEqual(appt.operator_id, nuova.id)

    def test_other_services_are_left_alone(self):
        sync._yourang_service(self.salon)
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        piega = Service.objects.create(salon=self.salon, category=cat, name_it="Piega",
                                       duration_min=30, price=20)
        self.marta.services.add(piega)
        self.marta.services.remove(piega)
        self.assertNotIn(piega.id, self.marta.services.values_list("id", flat=True))

    def test_data_migration_enables_existing_placeholders(self):
        # Operatrici nate prima del segnaposto: il ricevitore post_save non le
        # ha viste, come quelle dei saloni già in produzione.
        inactive = Operator.objects.create(salon=self.salon, first_name="Ex", active=False)
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        stranger = Operator.objects.create(salon=other_salon, first_name="Altra")
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Yourang")
        placeholder = Service.objects.create(
            salon=self.salon, category=cat, name_it="Prenotazione Yourang",
            duration_min=60, price=0, active=False,
        )
        self.assertFalse(placeholder.operators.exists())
        migration = importlib.import_module(
            "apps.integrations.migrations.0006_caccia22_integrazioni_segnaposto_idoneo"
        )
        migration._placeholder_for_every_operator(django_apps, None)
        migration._placeholder_for_every_operator(django_apps, None)  # idempotente
        self.assertEqual(
            set(placeholder.operators.values_list("id", flat=True)),
            {self.op.id, self.marta.id, inactive.id},
        )
        self.assertFalse(stranger.services.exists())


class RemoteCancelTests(_EventCase):
    """11-05/18-13: cancel_event passa dal dominio."""

    def test_a_closed_or_started_visit_is_left_alone(self):
        for i, local in enumerate((Appointment.Status.CLOSED, Appointment.Status.IN_PROGRESS,
                                   Appointment.Status.CHECKED_IN, Appointment.Status.NO_SHOW)):
            with self.subTest(local=local):
                appt = self._import(f"evt-k{i}")
                self._set_status(appt, local)
                before = self._logs("appointment.cancelled")
                sync.cancel_event(self.conn, f"evt-k{i}")
                appt.refresh_from_db()
                self.assertEqual(appt.status, local)
                self.assertEqual(self._logs("appointment.cancelled"), before)

    def test_a_future_booking_is_cancelled_logged_and_its_slot_announced(self):
        appt = self._import("evt-cancel")
        stamp = appt.updated_at
        sync.cancel_event(self.conn, "evt-cancel")
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CANCELLED)
        self.assertGreater(appt.updated_at, stamp)
        self.assertEqual(self._logs(), ["appointment.created", "appointment.cancelled"])
        self.assertTrue(OutboxEvent.objects.filter(salon=self.salon, event_type="slot.freed").exists())
        # nessuna eco verso Yourang: la disdetta arriva proprio da lì
        self.assertFalse(
            OutboxEvent.objects.filter(salon=self.salon, event_type="appointment.cancelled").exists()
        )

    def test_a_message_still_held_for_the_client_is_dropped(self):
        appt = self._import("evt-held")
        services.move_appointment(appt, self.start + dt.timedelta(hours=2), actor=self.user,
                                  force=True, client_overlap_ok=True)
        held = OutboxEvent.objects.get(salon=self.salon, event_type="appointment.moved")
        self.assertEqual(held.status, OutboxEvent.Status.PENDING)
        sync.cancel_event(self.conn, "evt-held")
        held.refresh_from_db()
        self.assertEqual(held.status, OutboxEvent.Status.SUPERSEDED)

    def test_a_past_booking_is_cancelled_without_waking_the_waitlist(self):
        past = self.start - dt.timedelta(days=10)
        appt = self._import("evt-past", starting_date=past.isoformat(),
                            ending_date=(past + dt.timedelta(hours=1)).isoformat())
        sync.cancel_event(self.conn, "evt-past")
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CANCELLED)
        self.assertFalse(OutboxEvent.objects.filter(salon=self.salon, event_type="slot.freed").exists())

    def test_a_paid_deposit_becomes_refundable(self):
        appt = self._import("evt-dep")
        Appointment.objects.filter(pk=appt.pk).update(
            deposit_status=Appointment.DepositStatus.PAID, deposit_amount=20
        )
        with mock.patch("apps.integrations.sync.settle_deposit_refund") as settle:
            sync.cancel_event(self.conn, "evt-dep")
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_status, Appointment.DepositStatus.REFUND_DUE)
        self.assertFalse(appt.cancelled_late)
        settle.assert_called_once()

    def test_remote_status_cancelled_goes_through_the_same_path(self):
        appt = self._import("evt-st")
        self._import("evt-st", status="cancelled")
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CANCELLED)
        self.assertEqual(self._logs(), ["appointment.created", "appointment.cancelled"])
        self.assertTrue(OutboxEvent.objects.filter(salon=self.salon, event_type="slot.freed").exists())


class LiveFeedTests(_EventCase):
    """11-06: ciò che arriva da Yourang scrive nel registro (SSE e polling)."""

    def test_import_move_and_cancel_are_logged(self):
        self._import("evt-live")
        self._import("evt-live")  # ri-consegna identica: niente da dire
        later = self.start + dt.timedelta(hours=3)
        self._import("evt-live", starting_date=later.isoformat(),
                     ending_date=(later + dt.timedelta(hours=1)).isoformat())
        sync.cancel_event(self.conn, "evt-live")
        self.assertEqual(
            self._logs(), ["appointment.created", "appointment.moved", "appointment.cancelled"]
        )
        log = ActivityLog.objects.get(salon=self.salon, type="appointment.created")
        self.assertEqual(log.payload["source"], "yourang")
        self.assertEqual(log.payload["yourang_event_id"], "evt-live")


class RedeliveryTests(_EventCase):
    """11-07: una ri-consegna applica solo ciò che su Yourang è cambiato."""

    def test_an_approval_does_not_move_back_what_the_salon_moved(self):
        appt = self._import("evt-move", status="pending")
        noon = self.start + dt.timedelta(hours=2)
        services.move_appointment(appt, noon, force=True, actor=self.user, client_overlap_ok=True)
        self._import("evt-move", status="approved")
        appt.refresh_from_db()
        self.assertEqual(appt.start, noon)

    def test_a_client_corrected_by_hand_stays(self):
        appt = self._import("evt-cli")
        giusta = Client.objects.create(salon=self.salon, first_name="Maria", phone="+393479998887")
        Appointment.objects.filter(pk=appt.pk).update(client=giusta)
        self._import("evt-cli", status="approved")
        appt.refresh_from_db()
        self.assertEqual(appt.client_id, giusta.id)

    def test_what_really_changed_on_yourang_still_follows(self):
        appt = self._import("evt-real")
        later = self.start + dt.timedelta(hours=4)
        self._import("evt-real", starting_date=later.isoformat(),
                     ending_date=(later + dt.timedelta(minutes=90)).isoformat(),
                     client_full_name="Lucia Bianchi", client_phone_number="3470001112")
        appt.refresh_from_db()
        self.assertEqual(appt.start, later)
        self.assertEqual(appt.client.phone, "+393470001112")
        self.assertEqual(appt.total_duration_min, 90)

    def test_a_length_changed_in_the_salon_stays(self):
        appt = self._import("evt-len")
        item = appt.items.get()
        services.edit_appointment(
            appt, items=[{"id": item.id, "service_id": item.service_id,
                          "operator_id": self.op.id, "duration_min": 90}],
            force=True, actor=self.user,
        )
        self._import("evt-len", status="approved")
        appt.refresh_from_db()
        self.assertEqual(appt.total_duration_min, 90)

    def test_a_booking_restored_after_a_remote_cancel_is_not_cancelled_again(self):
        appt = self._import("evt-back")
        self._import("evt-back", status="cancelled")
        self._set_status(appt, Appointment.Status.CONFIRMED)  # la cliente ha richiamato
        self._import("evt-back", status="cancelled")  # ri-consegna della stessa disdetta
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CONFIRMED)

    def test_remote_changes_do_not_rewrite_a_visit_already_started(self):
        appt = self._import("evt-started")
        self._set_status(appt, Appointment.Status.IN_PROGRESS)
        later = self.start + dt.timedelta(hours=5)
        self._import("evt-started", starting_date=later.isoformat())
        appt.refresh_from_db()
        self.assertEqual(appt.start, self.start)

    def test_events_imported_before_the_trace_follow_yourang_once(self):
        appt = self._import("evt-old")
        YourangEventSync.objects.filter(appointment=appt).delete()  # import di prima
        later = self.start + dt.timedelta(hours=1)
        self._import("evt-old", starting_date=later.isoformat(),
                     ending_date=(later + dt.timedelta(hours=1)).isoformat())
        appt.refresh_from_db()
        self.assertEqual(appt.start, later)
        self.assertTrue(YourangEventSync.objects.filter(appointment=appt).exists())


class ConcurrentDeliveryTests(_EventCase):
    """11-16: due consegne dello stesso evento non creano due righe segnaposto."""

    def test_a_delivery_committed_while_waiting_for_the_lock_is_seen(self):
        real_lock = sync.lock_salon
        state = {"nested": False}

        def lock_after_the_other_one(salon):
            if not state["nested"]:
                state["nested"] = True
                # l'altra consegna prende il lock per prima e committa
                self._import("evt-dup")
            return real_lock(salon)

        with mock.patch("apps.integrations.sync.lock_salon", side_effect=lock_after_the_other_one):
            appt = self._import("evt-dup")
        self.assertEqual(appt.items.count(), 1)
        self.assertEqual(appt.total_duration_min, 60)
        self.assertEqual(Appointment.objects.filter(yourang_event_id="evt-dup").count(), 1)

    def test_the_interleaving_found_by_the_review_no_longer_duplicates(self):
        real = sync._yourang_service
        state = {"nested": False}

        def interleaved(salon):
            svc = real(salon)
            if not state["nested"]:
                state["nested"] = True
                self._import("evt-dup2")
            return svc

        with mock.patch("apps.integrations.sync._yourang_service", side_effect=interleaved):
            appt = self._import("evt-dup2")
        appt.refresh_from_db()
        self.assertEqual(appt.items.count(), 1)
        shorter = self.start + dt.timedelta(minutes=30)
        self._import("evt-dup2", ending_date=shorter.isoformat())
        self.assertEqual(appt.total_duration_min, 30)  # la durata segue ancora Yourang


class PhonelessTests(_EventCase):
    """11-17: le prenotazioni senza telefono non finiscono tutte su una scheda."""

    def test_each_person_gets_her_own_card(self):
        a = self._import("evt-a", client_phone_number="", client_full_name="Anna Neri")
        b = self._import("evt-b", client_phone_number="", client_full_name="Bea Gialli")
        a2 = self._import("evt-a2", client_phone_number="", client_full_name="anna  NERI")
        self.assertNotEqual(a.client_id, b.client_id)
        self.assertEqual(a.client_id, a2.client_id)
        self.assertEqual((b.client.first_name, b.client.last_name), ("Bea", "Gialli"))
        for card in (a.client, b.client):
            self.assertEqual(phone_key(card.phone), "")  # nessun numero vero
            self.assertEqual(card.phone_key, "")
        self.assertFalse(Client.objects.filter(salon=self.salon, phone="").exists())


class SyncedContactSinceTests(_EventCase):
    """08-05, lato sync: la rubrica Yourang non diventa «nuovi clienti» di oggi."""

    def test_contacts_pulled_from_yourang_have_no_since(self):
        contacts = [{"id": "c-1", "first_name": "Rita", "last_name": "Blu",
                     "phone_number": "+393331110000", "email": ""}]
        with mock.patch("apps.integrations.client.YourangClient.list_contacts",
                        side_effect=[contacts]), \
                mock.patch("apps.integrations.client.YourangClient.create_or_get_contact",
                           return_value={}):
            report = sync.sync_clients(self.conn)
        self.assertEqual(report.created, 1)
        self.assertIsNone(Client.objects.get(yourang_contact_id="c-1").since)

    def test_a_client_born_from_a_booking_keeps_since(self):
        appt = self._import("evt-new")
        self.assertEqual(appt.client.since, timezone.localdate())


class ItemRowRepairTests(_EventCase):
    def test_an_appointment_left_without_rows_gets_its_placeholder_back(self):
        appt = self._import("evt-rows")
        AppointmentService.objects.filter(appointment=appt).delete()
        self._import("evt-rows")
        self.assertEqual(appt.items.count(), 1)
