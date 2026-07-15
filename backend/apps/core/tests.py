import json
import os
import shutil
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from common.auth import create_staff_tokens
from common.conditions import evaluate

from .models import Salon, SalonSettings
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
