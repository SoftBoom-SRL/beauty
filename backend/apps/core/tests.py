import json

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

    @override_settings(CLIENT_MOVE_CANCEL_MIN_HOURS=48)
    def test_salon_exposes_cancel_min_hours(self):
        resp = self.client.get("/api/core/salon", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["settings"]["cancel_min_hours"], 48)
