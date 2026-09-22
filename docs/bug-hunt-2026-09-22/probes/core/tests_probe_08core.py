"""Probe temporaneo del revisore 08 — DA CANCELLARE."""

import json
from io import StringIO
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase

from common.auth import create_staff_tokens

from .models import ActivityLog, Location, Salon, SalonSettings
from .services import log_activity, normalize_opening_hours_week


def _owner(salon, email="own@x.it"):
    from apps.accounts.models import Membership, User

    user = User.objects.create_user(email=email, password="pw-lunga-123")
    Membership.objects.create(user=user, salon=salon, is_owner=True)
    tokens = create_staff_tokens(user, salon)
    return user, {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}


class ProbeSeedDemoSuperuser(TestCase):
    def test_seed_demo_gives_admin_on_every_salon_with_public_password(self):
        from apps.clients.models import Client

        other = Salon.objects.create(name="Salone vero", slug="vero")
        Client.objects.create(salon=other, first_name="Segreta", last_name="Rossi", phone="+393339998877")
        call_command("seed_demo", stdout=StringIO())
        ok = self.client.login(email="sole@theparlour.it", password="theparlour")
        self.assertTrue(ok)
        resp = self.client.get("/admin/clients/client/?q=Segreta")
        print("\nadmin clienti di un altro salone:", resp.status_code, b"Segreta" in resp.content)
        self.assertNotEqual(resp.status_code, 200)


class ProbeCreateSalonExistingUser(TestCase):
    def test_second_salon_for_existing_user_is_unreachable(self):
        from apps.accounts.models import Membership, User

        first = Salon.objects.create(name="Primo", slug="primo")
        user = User.objects.create_user(email="anna@x.it", password="pw-lunga-123")
        Membership.objects.create(user=user, salon=first, is_owner=True)
        call_command(
            "create_salon", name="Secondo", slug="secondo", owner_email="anna@x.it",
            stdout=StringIO(),
        )
        resp = self.client.post(
            "/api/auth/staff/login",
            data=json.dumps({"email": "anna@x.it", "password": "pw-lunga-123"}),
            content_type="application/json",
        )
        print("\nlogin dopo create_salon per utente esistente ->", resp.status_code, resp.json().get("salon"))
        self.assertEqual(resp.json()["salon"]["slug"], "secondo")

    def test_email_case_creates_a_duplicate_user(self):
        from apps.accounts.models import User

        User.objects.create_user(email="Anna@x.it", password="pw-lunga-123")
        call_command(
            "create_salon", name="Secondo", slug="secondo", owner_email="anna@x.it",
            stdout=StringIO(),
        )
        n = User.objects.filter(email__iexact="anna@x.it").count()
        print("\nutenti con la stessa email a meno di maiuscole:", n)
        self.assertEqual(n, 1)


class ProbeOpeningHoursEmpty(TestCase):
    def test_empty_dict_becomes_closed_every_day(self):
        out = normalize_opening_hours_week({})
        print("\nnormalize({}) ->", out)
        self.assertEqual(out, {})


class ProbeStreamTicket(TestCase):
    def test_ticket_is_reusable_and_survives_membership_removal(self):
        from apps.accounts.models import Membership

        from .views import _release_stream_slot

        salon = Salon.objects.create(name="S", slug="s")
        user, auth = _owner(salon)
        ticket = self.client.post("/api/core/activity/stream-ticket", **auth).json()["ticket"]
        r1 = self.client.get(f"/api/core/activity/stream?ticket={ticket}")
        first1 = next(iter(r1.streaming_content))
        r1.close()
        Membership.objects.filter(user=user).delete()
        # il token Bearer non vale più...
        self.assertEqual(self.client.get("/api/core/salon", **auth).status_code, 401)
        # ...ma il biglietto sì, e più volte
        r2 = self.client.get(f"/api/core/activity/stream?ticket={ticket}")
        r3 = self.client.get(f"/api/core/activity/stream?ticket={ticket}")
        print("\nstesso biglietto, dopo la rimozione dal salone:", r2.status_code, r3.status_code)
        r2.close()
        r3.close()
        self.assertEqual(r2.status_code, 403)

    def test_invisible_events_suppress_the_keepalive(self):
        from . import views

        salon = Salon.objects.create(name="S", slug="s")
        log_activity(salon, "appointment.created", "base")
        real_sleep = views.time.sleep

        def busy_sleep(seconds):
            # ogni giro arriva un evento che un'operatrice «solo agenda» non vede
            log_activity(salon, "sale.created", "Vendita € 50")
            real_sleep(0.005)

        with patch.object(views, "STREAM_KEEPALIVE_SECONDS", 0.05), patch.object(views.time, "sleep", busy_sleep):
            frames = list(
                views.event_generator(salon.id, 0, is_owner=False, scopes=["agenda"], max_seconds=0.6, poll=0.01)
            )
        kinds = [f.split("\n")[0] if not f.startswith(":") else "ping" for f in frames]
        print("\nframe in 0,6 s con eventi invisibili continui (keepalive 0,05 s):", kinds)
        self.assertIn("ping", kinds)


class ProbeActivityBadDate(TestCase):
    def test_well_formed_but_impossible_date_is_a_500(self):
        salon = Salon.objects.create(name="S", slug="s")
        _, auth = _owner(salon)
        client = self.client
        client.raise_request_exception = False
        r = client.get("/api/core/activity?date_from=2026-02-30", **auth)
        r2 = client.get("/api/insights/kpis?date=2026-02-30", **auth)
        r3 = client.get("/api/insights/kpis?date_from=0001-01-01&date_to=0001-01-05", **auth)
        r4 = client.get("/api/insights/kpis?period=year&date=9999-06-01", **auth)
        print("\n2026-02-30 activity / kpis, anno 1, anno 9999:", r.status_code, r2.status_code, r3.status_code, r4.status_code)
        self.assertEqual(r.status_code, 400)


class ProbeSettingsFullSave(TestCase):
    def test_put_settings_overwrites_stripe_written_in_between(self):
        salon = Salon.objects.create(name="S", slug="s")
        _, auth = _owner(salon)
        SalonSettings.objects.create(salon=salon)
        from . import api as core_api

        real = core_api._settings

        def stale_then_stripe(s):
            obj = real(s)  # letto a inizio richiesta
            # nel frattempo il callback Stripe Connect salva l'account (update_fields)
            SalonSettings.objects.filter(salon=s).update(stripe_account_id="acct_123")
            return obj

        with patch.object(core_api, "_settings", stale_then_stripe):
            r = self.client.put("/api/core/settings", data=json.dumps({"brand_color": "#112233"}),
                                content_type="application/json", **auth)
        self.assertEqual(r.status_code, 200)
        acct = SalonSettings.objects.get(salon=salon).stripe_account_id
        print("\nstripe_account_id dopo PUT concorrente:", repr(acct))
        self.assertEqual(acct, "acct_123")


class ProbeAdminMalformedHours(TestCase):
    def test_hours_typed_in_admin_break_the_agenda(self):
        import datetime as dt

        from apps.staff.models import Operator, WeeklyShift

        salon = Salon.objects.create(name="S", slug="s")
        _, auth = _owner(salon)
        # come lo scriverebbe chi segue DEPLOY.md §7 creando le Impostazioni da /admin/
        SalonSettings.objects.create(salon=salon, opening_hours_week={"0": ["09:00-19:00"]})
        op = Operator.objects.create(salon=salon, first_name="Op", last_name="X")
        WeeklyShift.objects.create(operator=op, week_index=0, weekday=0, start_min=540, end_min=1140)
        monday = dt.date(2026, 9, 28)
        self.client.raise_request_exception = False
        r = self.client.get(f"/api/agenda/day?date={monday.isoformat()}", **auth)
        pub = self.client.get("/api/core/public/branding?salon=s")
        print("\nagenda del lunedì con orari malformati da admin:", r.status_code, "branding:", pub.status_code)
        self.assertEqual(r.status_code, 200)


class ProbeCheckoutLiveEvent(TestCase):
    def test_operatrice_agenda_gets_no_event_after_a_checkout(self):
        import datetime as dt

        from django.utils import timezone

        from apps.accounts.models import Membership, Role, User
        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator

        salon = Salon.objects.create(name="S", slug="s")
        _, owner_auth = _owner(salon)
        role = Role.objects.create(salon=salon, name="Operatrice", scopes=["agenda", "clients"])
        op_user = User.objects.create_user(email="op@x.it", password="pw-lunga-123")
        Membership.objects.create(user=op_user, salon=salon, role=role)
        op_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(op_user, salon)['access']}"}

        cat = ServiceCategory.objects.create(salon=salon, name_it="C")
        svc = Service.objects.create(salon=salon, category=cat, name_it="Piega", duration_min=30, price=25)
        op = Operator.objects.create(salon=salon, first_name="Op", last_name="X")
        cl = Client.objects.create(salon=salon, first_name="Anna", phone="+393331112233")
        appt = Appointment.objects.create(salon=salon, client=cl, operator=op,
                                          start=timezone.now() - dt.timedelta(minutes=40), status="in_progress")
        AppointmentService.objects.create(appointment=appt, service=svc, operator=op, duration_min=30, price=25)

        cursor = self.client.get("/api/core/activity/feed", **op_auth).json()["cursor"]
        r = self.client.post(
            f"/api/sales/checkout/{appt.id}",
            data=json.dumps({
                "blocks": [{"operator_id": op.id, "lines": [{"line_type": "service", "service_id": svc.id, "unit_price": "25.00"}]}],
                "payments": [{"method": "cash", "amount": "25.00"}],
            }),
            content_type="application/json", **owner_auth,
        )
        self.assertEqual(r.status_code, 200, r.content)
        appt.refresh_from_db()
        feed = self.client.get(f"/api/core/activity/feed?after={cursor}", **op_auth).json()
        types = [e["type"] for e in feed["events"]]
        written = list(ActivityLog.objects.filter(salon=salon, id__gt=cursor).values_list("type", flat=True))
        print("\nstato appuntamento:", appt.status, "| scritti:", written, "| consegnati all'operatrice:", types)
        self.assertTrue(types)


class ProbeSeedResetWipesRealSalon(TestCase):
    def test_reset_deletes_a_real_salon_called_the_parlour(self):
        from apps.accounts.models import User
        from apps.clients.models import Client
        from apps.integrations.login import _provision_salon

        owner = User.objects.create_user(email="vera@titolare.it", password="pw-lunga-123")
        real = _provision_salon(owner, "The Parlour")   # come «Accedi con Yourang»
        Client.objects.create(salon=real, first_name="Cliente", last_name="Vera", phone="+393331110000")
        print("\nslug del salone vero provisionato:", real.slug)
        call_command("seed_demo", "--reset", stdout=StringIO())
        still = Salon.objects.filter(pk=real.pk).exists()
        clients = Client.objects.filter(last_name="Vera").count()
        print("salone vero ancora presente:", still, "| clienti vere rimaste:", clients)
        self.assertTrue(still)
