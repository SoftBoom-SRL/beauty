"""Probe temporanei del revisore 11 (integrazione Yourang). DA CANCELLARE a fine revisione."""

import datetime as dt
import hashlib
import hmac
import json
import time
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone

from apps.accounts.models import Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import ActivityLog, Salon
from apps.integrations import sync
from apps.integrations.models import YourangConnection
from apps.staff.models import Operator
from common.auth import create_staff_tokens

SECRET = "probe-secret"


def _member(salon, email, scopes, *, owner=False):
    user = User.objects.create_user(email=email, password="Segretissima-2026")
    role = Role.objects.create(salon=salon, name=f"R-{email}", scopes=scopes) if scopes is not None else None
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=owner)
    tokens = create_staff_tokens(user, salon)
    return user, {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}


class FakeProxy:
    """httpx.request finto: registra (metodo, path, org, json) e risponde come il proxy."""

    def __init__(self):
        self.calls = []

    def __call__(self, method, url, headers=None, timeout=None, **kwargs):
        path = url.split("/api", 1)[1] if "/api" in url else url
        self.calls.append((method, path, (headers or {}).get("X-Yourang-Org"), kwargs.get("json")))
        resp = mock.Mock()
        resp.raise_for_status = mock.Mock()
        if method == "GET" and path.startswith("/contacts"):
            data = []
        elif method == "POST" and path == "/contacts":
            data = {"id": f"c-{len(self.calls)}"}
        else:
            data = {"id": f"x-{len(self.calls)}"}
        resp.json.return_value = {"ok": True, "data": data}
        return resp


@override_settings(
    YOURANG_PROXY_URL="https://proxy.invalid", YOURANG_PROXY_API_KEY="k",
    YOURANG_PROXY_WEBHOOK_SECRET=SECRET, FRONTEND_ORIGIN="https://beauty.example",
)
class ConnectRepointProbe(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.owner, self.owner_auth = _member(self.salon, "owner@p.it", None, owner=True)
        self.conn = YourangConnection.objects.create(
            salon=self.salon, yourang_org_id="org-legit", catalogue_id="cat-legit"
        )
        self.linked = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567", yourang_contact_id="c-legit"
        )
        self.unlinked = Client.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Verdi", phone="+393339876543",
            email="giulia@example.it",
        )
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Capelli")
        self.svc = Service.objects.create(
            salon=self.salon, category=cat, name_it="Piega", duration_min=30, price=20,
            yourang_item_id="i-legit",
        )

    def test_link_code_of_another_org_repoints_an_already_connected_salon(self):
        """Il codice arriva dall'URL /oauth-popup/done?mode=connect&yr_link=…: nessun
        legame con chi ha avviato il flusso. Il backend lo accetta e ricollega."""
        proxy = FakeProxy()
        with mock.patch("apps.integrations.client.redeem_link_code",
                        return_value={"org_id": "org-attacker", "email": "a@evil.it"}), \
                mock.patch("apps.integrations.client.httpx.request", side_effect=proxy):
            r = self.client.post(
                "/api/integrations/yourang/oauth/exchange",
                data=json.dumps({"code": "codice-dell-attaccante", "mode": "connect"}),
                content_type="application/json", **self.owner_auth,
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.yourang_org_id, "org-attacker")
        pushed = [c for c in proxy.calls if c[0] == "POST" and c[1] == "/contacts"]
        self.assertEqual(len(pushed), 1)
        self.assertEqual(pushed[0][2], "org-attacker")
        self.assertEqual(pushed[0][3]["phone_number"], "+393339876543")
        self.assertEqual(pushed[0][3]["email"], "giulia@example.it")
        # riferimenti dell'org precedente rimasti appiccicati (H6 corretto solo sul disconnect)
        self.linked.refresh_from_db()
        self.assertEqual(self.linked.yourang_contact_id, "c-legit")
        self.assertEqual(self.conn.catalogue_id, "cat-legit")
        put = [c for c in proxy.calls if c[0] == "PUT"]
        self.assertEqual(put[0][1], "/catalogues/items/i-legit")
        self.assertEqual(put[0][2], "org-attacker")
        self.assertEqual(put[0][3]["catalogue_id"], "cat-legit")

        # e i webhook dell'org legittima da ora finiscono nel nulla (200 «ok»)
        body = json.dumps({"type": "event.created", "organization_id": "org-legit",
                           "resource_id": "evt-1"}).encode()
        ts = str(int(time.time()))
        sig = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
        with mock.patch("apps.integrations.sync.import_event") as imported:
            r = self.client.post("/api/integrations/yourang/webhook", data=body,
                                 content_type="application/json",
                                 headers={"x-yourang-signature": sig, "x-yourang-timestamp": ts})
        self.assertEqual(r.status_code, 200)
        imported.assert_not_called()


@override_settings(YOURANG_PROXY_URL="https://proxy.invalid", YOURANG_PROXY_API_KEY="k")
class LoginAdoptsSalonProbe(TestCase):
    def test_staff_member_login_pushes_the_whole_client_base_to_her_org(self):
        from apps.integrations.login import login_with_link_code

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        _member(salon, "owner@p.it", None, owner=True)
        op, _ = _member(salon, "op@p.it", ["agenda"])
        for i in range(3):
            Client.objects.create(salon=salon, first_name=f"C{i}", phone=f"+39333000000{i}")
        proxy = FakeProxy()
        identity = {"org_id": "org-op", "email": "op@p.it", "email_verified": True, "name": "Op"}
        with mock.patch("apps.integrations.client.redeem_link_code", return_value=identity), \
                mock.patch("apps.integrations.client.httpx.request", side_effect=proxy):
            session = login_with_link_code("code")
        self.assertFalse(session["is_owner"])
        conn = YourangConnection.objects.get(salon=salon)
        self.assertEqual((conn.yourang_org_id, conn.connected_by_id), ("org-op", op.id))
        pushed = [c for c in proxy.calls if c[0] == "POST" and c[1] == "/contacts"]
        self.assertEqual(len(pushed), 3)
        self.assertTrue(all(c[2] == "org-op" for c in pushed))

    def test_owner_of_two_salons_gets_the_wrong_one_connected(self):
        from apps.integrations.login import login_with_link_code

        s1 = Salon.objects.create(name="Salone Centro", slug="centro")
        s2 = Salon.objects.create(name="Salone Mare", slug="mare")
        user = User.objects.create_user(email="tit@p.it", password="x-Segretissima-1")
        Membership.objects.create(user=user, salon=s1, is_owner=True)
        Membership.objects.create(user=user, salon=s2, is_owner=True)
        identity = {"org_id": "org-mare", "email": "tit@p.it", "email_verified": True, "name": "T"}
        with mock.patch("apps.integrations.client.redeem_link_code", return_value=identity), \
                mock.patch("apps.integrations.client.httpx.request", side_effect=FakeProxy()):
            session = login_with_link_code("code")
        # l'org del salone «Mare» finisce collegata al «Centro»
        self.assertEqual(YourangConnection.objects.get(yourang_org_id="org-mare").salon_id, s1.id)
        self.assertEqual(session["salon"]["id"], s1.id)


class ImportEventProbe(TestCase):
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

    def _import(self, event_id, data=None):
        with mock.patch("apps.integrations.sync.YourangClient.get_event",
                        return_value=data or self.event):
            return sync.import_event(self.conn, event_id)

    def test_import_and_cancel_write_nothing_the_live_feed_can_see(self):
        appt = self._import("evt-live")
        self.assertIsNotNone(appt)
        sync.cancel_event(self.conn, "evt-live")
        self.assertEqual(ActivityLog.objects.filter(salon=self.salon).count(), 0)

    def test_cancel_event_turns_a_closed_visit_into_a_cancelled_one(self):
        appt = self._import("evt-closed")
        Appointment.objects.filter(pk=appt.pk).update(status=Appointment.Status.CLOSED)
        sync.cancel_event(self.conn, "evt-closed")
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CANCELLED)

    def test_redelivery_moves_back_what_the_salon_moved_and_overlaps(self):
        from apps.agenda import services

        appt = self._import("evt-move")
        # la reception sposta la prenotazione Yourang alle 12
        services.move_appointment(appt, self.start + dt.timedelta(hours=2), force=True,
                                  actor=self.user, client_overlap_ok=True)
        appt.refresh_from_db()
        self.assertEqual(appt.start, self.start + dt.timedelta(hours=2))
        # e alle 10, ormai libere, mette un'altra cliente sulla stessa operatrice
        other = Client.objects.create(salon=self.salon, first_name="Luisa", phone="+393471112223")
        native = Appointment.objects.create(salon=self.salon, client=other, operator=self.op,
                                            start=self.start)
        svc = Service.objects.filter(salon=self.salon).first()
        AppointmentService.objects.create(appointment=native, service=svc, operator=self.op,
                                          duration_min=60, price=0)
        # Yourang riconsegna l'evento (stato «approved», orario suo di sempre)
        self._import("evt-move", {**self.event, "status": "approved"})
        appt.refresh_from_db()
        self.assertEqual(appt.start, self.start)  # tornata alle 10, sopra Luisa
        self.assertEqual(ActivityLog.objects.filter(salon=self.salon,
                                                    type__startswith="appointment.").count(), 1)

    def test_two_deliveries_interleaved_create_two_placeholder_rows(self):
        real = sync._yourang_service
        state = {"nested": False}

        def interleaved(salon):
            svc = real(salon)
            if not state["nested"]:
                state["nested"] = True
                # la seconda consegna (event.updated) arriva ora: vede
                # l'appuntamento appena committato e nessuna riga
                with mock.patch("apps.integrations.sync.YourangClient.get_event",
                                return_value=self.event):
                    sync.import_event(self.conn, "evt-dup")
            return svc

        with mock.patch("apps.integrations.sync._yourang_service", side_effect=interleaved):
            appt = self._import("evt-dup")
        appt.refresh_from_db()
        self.assertEqual(appt.items.count(), 2)
        self.assertEqual(appt.total_duration_min, 120)
        # e da qui in poi la durata non segue più Yourang (len(items) != 1)
        self._import("evt-dup", {**self.event,
                                 "ending_date": (self.start + dt.timedelta(minutes=30)).isoformat()})
        self.assertEqual(appt.total_duration_min, 120)


class RemoteStatusProbe(ImportEventProbe):
    def test_remote_terminal_status_overrides_a_visit_in_progress(self):
        import json as _json

        appt = self._import("evt-live-visit")
        Appointment.objects.filter(pk=appt.pk).update(status=Appointment.Status.IN_PROGRESS)
        self._import("evt-live-visit", {**self.event, "status": "no_show"})
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.NO_SHOW)
        # alla fine del trattamento la cassa non può più incassare la visita
        owner, auth = _member(self.salon, "cassa@p.it", None, owner=True)
        r = self.client.post(f"/api/sales/checkout/{appt.id}", data=_json.dumps({
            "blocks": [], "payments": [], "coupon_code": ""}), content_type="application/json", **auth)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("no-show", r.json()["detail"])

    def test_remote_completed_closes_without_any_sale(self):
        from apps.sales.models import Sale

        appt = self._import("evt-done")
        Appointment.objects.filter(pk=appt.pk).update(status=Appointment.Status.CHECKED_IN)
        self._import("evt-done", {**self.event, "status": "completed"})
        appt.refresh_from_db()
        self.assertEqual(appt.status, Appointment.Status.CLOSED)
        self.assertFalse(Sale.objects.filter(appointment=appt).exists())


@override_settings(YOURANG_PROXY_URL="https://proxy.invalid", YOURANG_PROXY_API_KEY="k",
                   YOURANG_PROXY_WEBHOOK_SECRET=SECRET)
class ContactWebhookCostProbe(TestCase):
    def test_every_contact_webhook_retries_every_unlinked_client(self):
        import httpx

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        YourangConnection.objects.create(salon=salon, yourang_org_id="org-c")
        for i in range(120):
            Client.objects.create(salon=salon, first_name=f"C{i}", phone=f"+3933310{i:05d}")
        calls = []

        def proxy(method, url, headers=None, timeout=None, **kwargs):
            calls.append((method, url))
            resp = mock.Mock()
            if method == "POST":
                resp.raise_for_status.side_effect = httpx.HTTPStatusError(
                    "403", request=mock.Mock(), response=mock.Mock(status_code=403))
            else:
                resp.raise_for_status = mock.Mock()
                resp.json.return_value = {"data": []}
            return resp

        body = json.dumps({"type": "contact.updated", "organization_id": "org-c",
                           "resource_id": "c-1"}).encode()
        for _ in range(3):
            ts = str(int(time.time()))
            sig = "sha256=" + hmac.new(SECRET.encode(), f"{ts}.".encode() + body,
                                       hashlib.sha256).hexdigest()
            with mock.patch("apps.integrations.client.httpx.request", side_effect=proxy):
                r = self.client.post("/api/integrations/yourang/webhook", data=body,
                                     content_type="application/json",
                                     headers={"x-yourang-signature": sig, "x-yourang-timestamp": ts})
            self.assertEqual(r.status_code, 200)
        posts = [c for c in calls if c[0] == "POST"]
        self.assertEqual(len(posts), 3 * 120)  # ogni webhook ritenta TUTTE le schede


class PlaceholderEligibilityProbe(ImportEventProbe):
    def test_a_yourang_booking_cannot_change_operator_nor_length(self):
        from ninja.errors import HttpError

        from apps.agenda import services

        other = Operator.objects.create(salon=self.salon, first_name="Marta")
        appt = self._import("evt-stuck")
        self.assertEqual(appt.operator_id, self.op.id)  # sempre la prima operatrice attiva
        # trascinata sulla colonna di Marta
        with self.assertRaises(HttpError) as err:
            services.move_appointment(appt, appt.start, operator=other, actor=self.user,
                                      force=True, client_overlap_ok=True)
        self.assertEqual(err.exception.status_code, 400)
        # allungata da 60 a 90 minuti, con e senza operatrice indicata, anche forzando
        item = appt.items.get()
        with self.assertRaises(HttpError) as err:
            services.edit_appointment(appt, items=[{"id": item.id, "service_id": item.service_id,
                                                    "operator_id": self.op.id, "duration_min": 90}],
                                      force=True, actor=self.user)
        self.assertEqual(err.exception.status_code, 400)
        with self.assertRaises(HttpError) as err:
            services.edit_appointment(appt, items=[{"id": item.id, "service_id": item.service_id,
                                                    "duration_min": 90}],
                                      force=True, actor=self.user)
        self.assertEqual(err.exception.status_code, 409)
