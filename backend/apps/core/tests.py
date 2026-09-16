import json
import os
import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from common.auth import create_staff_tokens
from common.conditions import evaluate

from .models import Location, Salon, SalonSettings
from .services import emit_event, log_activity


class CoreTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_settings_defaults(self):
        s = SalonSettings.objects.create(salon=self.salon)
        self.assertEqual(s.brand_color, "#6366F1")
        self.assertEqual(s.agenda_fill, "free")
        self.assertEqual(s.slot_interval_min, 15)

    def test_log_and_emit(self):
        log = log_activity(self.salon, "test.event", "Prova")
        self.assertEqual(log.type, "test.event")
        ev = emit_event(self.salon, "test.event", {"a": 1})
        self.assertEqual(ev.status, "pending")

    def test_conditions_evaluator(self):
        facts = {"reliability": 55, "categories": ["VIP"], "total_spent": 210}
        cond = {
            "op": "and",
            "rules": [
                {"field": "reliability", "cmp": "lt", "value": 60},
                {"field": "categories", "cmp": "contains", "value": "vip"},
            ],
        }
        self.assertTrue(evaluate(cond, facts))
        cond["op"] = "or"
        cond["rules"][0]["value"] = 10
        self.assertTrue(evaluate(cond, facts))
        self.assertTrue(evaluate(None, facts))
        self.assertFalse(
            evaluate({"rules": [{"field": "missing", "cmp": "eq", "value": 1}]}, facts)
        )


class SettingsApiTests(TestCase):
    """PUT /api/core/settings: solo owner, con validazione dell'intervallo fasce."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(
            email="sole@theparlour.it", password="theparlour"
        )
        role = Role.objects.create(salon=self.salon, name="Owner", scopes=["settings"])
        Membership.objects.create(
            user=self.user, salon=self.salon, role=role, is_owner=True
        )
        tokens = create_staff_tokens(self.user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def _put(self, payload):
        return self.client.put(
            "/api/core/settings",
            data=json.dumps(payload),
            content_type="application/json",
            **self.auth,
        )

    def test_opening_hours_week_is_normalized_and_summarised(self):
        week = {"0": [["9:00", "13:00"], ["14:00", "19:00"]], "1": [["09:00", "13:00"], ["14:00", "19:00"]],
                "2": [["09:00", "13:00"], ["14:00", "19:00"]], "3": [["09:00", "13:00"], ["14:00", "19:00"]],
                "4": [["09:00", "13:00"], ["14:00", "19:00"]], "5": [["09:00", "13:00"]], "6": []}
        resp = self._put({"opening_hours_week": week})
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(body["opening_hours_week"]["0"][0], ["09:00", "13:00"])
        self.assertEqual(body["opening_hours"], "Lun–Ven 9:00–13:00, 14:00–19:00 · Sab 9:00–13:00 · Dom chiuso")
        public = self.client.get("/api/core/public/branding?salon=the-parlour").json()
        self.assertEqual(public["opening_hours_week"]["5"], [["09:00", "13:00"]])

    def test_opening_hours_week_rejects_overlaps_and_bad_times(self):
        self.assertEqual(self._put({"opening_hours_week": {"0": [["09:00", "13:00"], ["12:00", "19:00"]]}}).status_code, 400)
        self.assertEqual(self._put({"opening_hours_week": {"0": [["19:00", "09:00"]]}}).status_code, 400)
        self.assertEqual(self._put({"opening_hours_week": {"0": [["9", "13:00"]]}}).status_code, 400)

    def test_valid_slot_interval_persists(self):
        resp = self._put({"slot_interval_min": 30})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["slot_interval_min"], 30)
        self.assertEqual(
            SalonSettings.objects.get(salon=self.salon).slot_interval_min, 30
        )

    def test_invalid_slot_interval_rejected(self):
        resp = self._put({"slot_interval_min": 25})
        self.assertEqual(resp.status_code, 400, resp.content)
        # nulla salvato: resta il default 15
        self.assertEqual(
            SalonSettings.objects.get(salon=self.salon).slot_interval_min, 15
        )

    @override_settings(CLIENT_MOVE_CANCEL_MIN_HOURS=48)
    def test_salon_exposes_cancel_min_hours(self):
        resp = self.client.get("/api/core/salon", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["settings"]["cancel_min_hours"], 48)

    def test_default_lang_persists(self):
        self.assertEqual(self.salon.default_lang, "it")
        resp = self._put({"default_lang": "en"})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.salon.refresh_from_db()
        self.assertEqual(self.salon.default_lang, "en")

    def test_invalid_default_lang_rejected(self):
        resp = self._put({"default_lang": "fr"})
        self.assertEqual(resp.status_code, 400, resp.content)
        self.salon.refresh_from_db()
        self.assertEqual(self.salon.default_lang, "it")

    def test_opening_hours_persists(self):
        resp = self._put({"opening_hours": "Lun-Ven 9-19\nSab 9-13"})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["opening_hours"], "Lun-Ven 9-19\nSab 9-13")
        self.assertEqual(
            SalonSettings.objects.get(salon=self.salon).opening_hours,
            "Lun-Ven 9-19\nSab 9-13",
        )


class PublicBrandingApiTests(TestCase):
    """GET /api/core/public/branding: address/phone dalla location default + opening_hours."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_exposes_address_phone_from_default_location(self):
        Location.objects.create(
            salon=self.salon, name="Sede secondaria", address="Via Roma 1", phone="011111111"
        )
        Location.objects.create(
            salon=self.salon,
            name="Sede principale",
            address="Via Milano 2",
            phone="022222222",
            is_default=True,
        )
        s = SalonSettings.objects.create(salon=self.salon, opening_hours="Lun-Ven 9-19")

        resp = self.client.get("/api/core/public/branding", {"salon": "the-parlour"})
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["address"], "Via Milano 2")
        self.assertEqual(data["phone"], "022222222")
        self.assertEqual(data["opening_hours"], "Lun-Ven 9-19")
        self.assertEqual(s.opening_hours, "Lun-Ven 9-19")

    def test_falls_back_to_first_location_when_no_default(self):
        Location.objects.create(
            salon=self.salon, name="Unica sede", address="Via Torino 3", phone="033333333"
        )

        resp = self.client.get("/api/core/public/branding", {"salon": "the-parlour"})
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["address"], "Via Torino 3")
        self.assertEqual(data["phone"], "033333333")

    def test_empty_strings_when_no_location(self):
        resp = self.client.get("/api/core/public/branding", {"salon": "the-parlour"})
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["address"], "")
        self.assertEqual(data["phone"], "")
        self.assertEqual(data["opening_hours"], "")


class LogoApiTests(TestCase):
    """POST/DELETE /api/core/settings/logo: solo owner."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(
            email="sole@theparlour.it", password="theparlour"
        )
        role = Role.objects.create(salon=self.salon, name="Owner", scopes=["settings"])
        Membership.objects.create(
            user=self.user, salon=self.salon, role=role, is_owner=True
        )
        tokens = create_staff_tokens(self.user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

        self._media_root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self._media_root, ignore_errors=True)
        self._override = override_settings(MEDIA_ROOT=self._media_root)
        self._override.enable()
        self.addCleanup(self._override.disable)

    def test_delete_logo_clears_file(self):
        upload = SimpleUploadedFile(
            "logo.png", b"fake-image-bytes", content_type="image/png"
        )
        resp = self.client.post(
            "/api/core/settings/logo", {"logo": upload}, **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsNotNone(resp.json()["logo_url"])
        settings_obj = SalonSettings.objects.get(salon=self.salon)
        self.assertTrue(settings_obj.logo)
        logo_path = settings_obj.logo.path

        resp = self.client.delete("/api/core/settings/logo", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertIsNone(resp.json()["logo_url"])

        settings_obj.refresh_from_db()
        self.assertFalse(settings_obj.logo)
        self.assertFalse(os.path.exists(logo_path))


class ActivityFeedApiTests(TestCase):
    """GET /api/core/activity/feed — polling live della dashboard."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="mara@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role, is_owner=False)
        tokens = create_staff_tokens(self.user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def _feed(self, after=None):
        url = "/api/core/activity/feed" + (f"?after={after}" if after is not None else "")
        res = self.client.get(url, **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_bootstrap_returns_only_cursor(self):
        log_activity(self.salon, "appointment.created", "A")
        last = log_activity(self.salon, "appointment.moved", "B")
        data = self._feed()
        self.assertEqual(data["cursor"], last.id)
        self.assertEqual(data["events"], [])

    def test_after_returns_new_events_in_order_and_filters_admin_types(self):
        start = self._feed()["cursor"]
        e1 = log_activity(self.salon, "appointment.created", "Nuovo", actor=self.user)
        log_activity(self.salon, "team.role_created", "Ruolo")  # amministrativo: escluso
        e3 = log_activity(self.salon, "pause.updated", "Pausa")
        data = self._feed(after=start)
        self.assertEqual([e["type"] for e in data["events"]], ["appointment.created", "pause.updated"])
        self.assertEqual(data["events"][0]["id"], e1.id)
        self.assertEqual(data["events"][0]["actor_id"], self.user.id)
        self.assertIsNone(data["events"][1]["actor_id"])
        # il cursore avanza oltre l'evento filtrato, così non viene richiesto in eterno
        self.assertEqual(data["cursor"], e3.id)
        # secondo giro: niente di nuovo
        again = self._feed(after=data["cursor"])
        self.assertEqual(again["events"], [])
        self.assertEqual(again["cursor"], e3.id)

    def test_feed_is_scoped_to_the_salon(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        start = self._feed()["cursor"]
        log_activity(other, "appointment.created", "Altrove")
        mine = log_activity(self.salon, "appointment.created", "Qui")
        data = self._feed(after=start)
        self.assertEqual([e["summary"] for e in data["events"]], ["Qui"])
        self.assertEqual(data["cursor"], mine.id)

    def test_feed_requires_staff_auth(self):
        res = self.client.get("/api/core/activity/feed")
        self.assertEqual(res.status_code, 401)


class ActivityStreamTests(TestCase):
    """SSE: ticket effimero + generatore di frame."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="mara2@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        Membership.objects.create(user=self.user, salon=self.salon, role=role, is_owner=False)
        tokens = create_staff_tokens(self.user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def test_ticket_requires_auth_and_opens_stream(self):
        self.assertEqual(self.client.post("/api/core/activity/stream-ticket").status_code, 401)
        res = self.client.post("/api/core/activity/stream-ticket", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        ticket = res.json()["ticket"]
        self.assertEqual(self.client.get("/api/core/activity/stream?ticket=nope").status_code, 403)
        # generatore limitato nel tempo: primo frame `ready` con il cursore corrente
        from apps.core.views import event_generator

        log_activity(self.salon, "appointment.created", "A")
        frames = list(event_generator(self.salon.id, 0, max_seconds=0, poll=0))
        self.assertTrue(frames[0].startswith("id: "))
        self.assertIn("event: ready", frames[0])
        self.assertIn("event: bye", frames[-1])

    def test_generator_pushes_new_events_after_cursor(self):
        from apps.core.views import event_generator

        first = log_activity(self.salon, "appointment.created", "Prima")
        log_activity(self.salon, "team.role_created", "Amministrativo")  # filtrato
        new = log_activity(self.salon, "pause.updated", "Pausa", actor=self.user)
        frames = list(event_generator(self.salon.id, first.id, max_seconds=0.05, poll=0))
        data_frames = [f for f in frames if "event: events" in f]
        self.assertEqual(len(data_frames), 1)
        body = json.loads(data_frames[0].split("data: ", 1)[1])
        self.assertEqual(body["cursor"], new.id)
        self.assertEqual([e["type"] for e in body["events"]], ["pause.updated"])
        self.assertEqual(body["events"][0]["actor_id"], self.user.id)

    def test_stream_view_streams_first_frame(self):
        res = self.client.post("/api/core/activity/stream-ticket", **self.auth)
        ticket = res.json()["ticket"]
        from unittest import mock

        with mock.patch("apps.core.views.STREAM_MAX_SECONDS", 0):
            stream = self.client.get(f"/api/core/activity/stream?ticket={ticket}")
            self.assertEqual(stream.status_code, 200)
            self.assertEqual(stream["Content-Type"], "text/event-stream")
            body = b"".join(stream.streaming_content).decode()
        self.assertIn("event: ready", body)
