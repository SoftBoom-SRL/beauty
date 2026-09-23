"""Impostazioni, logo, regole caparra, registro attività, orari da /admin/.

Caccia ai bug del 22/09: 08-18 + 18-07, 15-16 (lato server), 08-16, 08-15.
"""

import json
import shutil
import tempfile
from decimal import Decimal
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from common.auth import create_staff_tokens

from .admin import SalonSettingsAdminForm
from .models import DepositRule, Salon, SalonSettings
from .services import log_activity

# PNG 1x1 valido
PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f"
    b"\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x35\x81\x84\x00"
    b"\x00\x00\x00IEND\xaeB`\x82"
)


def _owner(salon, email="own@x.it"):
    from apps.accounts.models import Membership, User

    user = User.objects.create_user(email=email, password="pw-lunga-123")
    Membership.objects.create(user=user, salon=salon, is_owner=True)
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


class _StaleSettings:
    """Simula la corsa: le impostazioni vengono lette a inizio richiesta e, prima
    del salvataggio, il callback di Stripe Connect scrive l'account collegato."""

    def __init__(self):
        from . import api as core_api

        self.core_api = core_api
        self.real = core_api._settings

    def __enter__(self):
        def stale_then_stripe(salon):
            obj = self.real(salon)
            SalonSettings.objects.filter(salon=salon).update(stripe_account_id="acct_123")
            return obj

        self.patcher = patch.object(self.core_api, "_settings", stale_then_stripe)
        self.patcher.start()

    def __exit__(self, *exc):
        self.patcher.stop()


class SettingsSavedByFieldTests(TestCase):
    """08-18 + 18-07: un PUT o un logo concorrenti al collegamento Stripe lo annullavano."""

    def setUp(self):
        self.media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.media, ignore_errors=True)
        self.salon = Salon.objects.create(name="S", slug="s")
        SalonSettings.objects.create(salon=self.salon)
        self.auth = _owner(self.salon)

    def _stripe_account(self):
        return SalonSettings.objects.get(salon=self.salon).stripe_account_id

    def test_put_settings_keeps_the_stripe_account_written_meanwhile(self):
        with _StaleSettings():
            resp = self.client.put(
                "/api/core/settings", data=json.dumps({"brand_color": "#112233"}),
                content_type="application/json", **self.auth,
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        settings = SalonSettings.objects.get(salon=self.salon)
        self.assertEqual(settings.brand_color, "#112233")
        self.assertEqual(settings.stripe_account_id, "acct_123")

    def test_logo_upload_and_removal_keep_the_stripe_account(self):
        with override_settings(MEDIA_ROOT=self.media):
            with _StaleSettings():
                upload = SimpleUploadedFile("logo.png", PNG, content_type="image/png")
                resp = self.client.post("/api/core/settings/logo", {"logo": upload}, **self.auth)
            self.assertEqual(resp.status_code, 200, resp.content)
            self.assertTrue(resp.json()["logo_url"])
            self.assertEqual(self._stripe_account(), "acct_123")

            SalonSettings.objects.filter(salon=self.salon).update(stripe_account_id="")
            with _StaleSettings():
                resp = self.client.delete("/api/core/settings/logo", **self.auth)
            self.assertEqual(resp.status_code, 200, resp.content)
            self.assertIsNone(resp.json()["logo_url"])
            settings = SalonSettings.objects.get(salon=self.salon)
            self.assertFalse(settings.logo)
            self.assertEqual(settings.stripe_account_id, "acct_123")


class DepositRuleAmountTests(TestCase):
    """15-16: un acconto in percentuale oltre il 100 % si salvava."""

    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.auth = _owner(self.salon)

    def _post(self, **body):
        payload = {"name": "Regola", "amount_type": "pct", "amount": "30", **body}
        return self.client.post(
            "/api/core/deposit-rules", data=json.dumps(payload), content_type="application/json", **self.auth
        )

    def test_percentages_stay_between_0_and_100(self):
        self.assertEqual(self._post(amount="150").status_code, 400)
        self.assertEqual(self._post(amount="-5").status_code, 400)
        self.assertEqual(self._post(amount="100").status_code, 200)
        self.assertEqual(self._post(amount="0").status_code, 200)
        self.assertEqual(self._post(amount_type="fixed", amount="150").status_code, 200)

    def test_unknown_types_and_huge_amounts_are_refused(self):
        self.assertEqual(self._post(amount_type="euro").status_code, 400)
        self.assertEqual(self._post(amount_type="fixed", amount="100000000").status_code, 400)
        self.assertEqual(DepositRule.objects.count(), 0)

    def test_converting_a_fixed_rule_to_percent_needs_a_valid_value(self):
        rule_id = self._post(amount_type="fixed", amount="150").json()["id"]
        resp = self.client.put(
            f"/api/core/deposit-rules/{rule_id}",
            data=json.dumps({"name": "Regola", "amount_type": "pct", "amount": "150"}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(resp.status_code, 400)
        rule = DepositRule.objects.get(pk=rule_id)
        self.assertEqual((rule.amount_type, rule.amount), ("fixed", Decimal("150.00")))

    def test_editing_and_deleting_a_rule_reach_the_other_workstations(self):
        """Modifica ed eliminazione finiscono nel registro, e quindi nel feed live."""
        from apps.core.models import ActivityLog

        rule_id = self._post(amount_type="fixed", amount="20").json()["id"]
        resp = self.client.put(
            f"/api/core/deposit-rules/{rule_id}",
            data=json.dumps({"name": "Colore", "amount_type": "fixed", "amount": "25"}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(self.client.delete(f"/api/core/deposit-rules/{rule_id}", **self.auth).status_code, 200)
        logs = ActivityLog.objects.filter(salon=self.salon, type__startswith="deposit_rule.").order_by("id")
        self.assertEqual(
            [log.type for log in logs], ["deposit_rule.created", "deposit_rule.updated", "deposit_rule.deleted"]
        )
        self.assertEqual(logs[2].payload["rule_id"], rule_id)
        feed = self.client.get("/api/core/activity/feed", {"after": logs[0].id - 1}, **self.auth).json()
        self.assertEqual([e["type"] for e in feed["events"]][-2:], ["deposit_rule.updated", "deposit_rule.deleted"])


class ActivityLogDatesTests(TestCase):
    """08-16: una data ben scritta ma inesistente era un 500."""

    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.auth = _owner(self.salon)
        self.client.raise_request_exception = False
        log_activity(self.salon, "appointment.created", "Oggi")

    def test_impossible_or_malformed_dates_are_a_400(self):
        for query in (
            "date_from=2026-02-30", "date_to=2026-13-01", "date_from=ieri", "date_to=0000-01-01",
        ):
            with self.subTest(query=query):
                resp = self.client.get(f"/api/core/activity?{query}", **self.auth)
                self.assertEqual(resp.status_code, 400)

    def test_valid_dates_still_filter(self):
        resp = self.client.get("/api/core/activity?date_from=2000-01-01&date_to=2999-12-31", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual([row["summary"] for row in resp.json()["items"]], ["Oggi"])
        resp = self.client.get("/api/core/activity?date_to=2000-01-01", **self.auth)
        self.assertEqual(resp.json()["items"], [])


class AdminOpeningHoursTests(TestCase):
    """08-15: orari scritti da /admin/ in un formato diverso bloccavano l'agenda."""

    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.settings = SalonSettings.objects.create(salon=self.salon)

    def _data(self, week, **extra):
        s = self.settings
        data = {
            "salon": s.salon_id,
            "brand_color": s.brand_color,
            "opening_hours": s.opening_hours,
            "opening_hours_week": json.dumps(week),
            "agenda_fill": s.agenda_fill,
            "slot_recovery": s.slot_recovery,
            "slot_interval_min": s.slot_interval_min,
            "privacy_policy_url": "",
            "lastminute_discount_cap": s.lastminute_discount_cap,
            "lastminute_monthly_budget": "0",
            "flexible_enabled": "on",
            "flexible_window_min": s.flexible_window_min,
            "flexible_reward_pct": s.flexible_reward_pct,
            "deposit_hold_minutes": 0,
            "deposit_reminder_minutes": 0,
            "automation_delay_seconds": 30,
            "cancel_reasons": "[]",
            "no_show_reasons": "[]",
            "stripe_account_id": "",
        }
        data.update(extra)
        return data

    def _form(self, week, **extra):
        return SalonSettingsAdminForm(data=self._data(week, **extra), instance=self.settings)

    def test_the_formats_that_broke_the_agenda_are_refused(self):
        for week in (
            {"0": ["09:00-19:00"]},
            {"0": [["19:00", "09:00"]]},
            {"0": [["09:00", "25:00"]]},
            {"lun": [["09:00", "19:00"]]},
            ["09:00", "19:00"],
        ):
            with self.subTest(week=week):
                form = self._form(week)
                self.assertFalse(form.is_valid())
                self.assertIn("opening_hours_week", form.errors)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.opening_hours_week, {})

    def test_valid_hours_are_normalised_and_summarised(self):
        form = self._form({"0": [["9:00", "13:00"], ["14:00", "19:00"]], "6": []})
        self.assertTrue(form.is_valid(), form.errors)
        saved = form.save()
        self.assertEqual(saved.opening_hours_week["0"], [["09:00", "13:00"], ["14:00", "19:00"]])
        self.assertEqual(saved.opening_hours_week["3"], [])
        self.assertIn("9:00–13:00", saved.opening_hours)

    def test_empty_hours_stay_not_configured(self):
        form = self._form({})
        self.assertTrue(form.is_valid(), form.errors)
        self.assertEqual(form.save().opening_hours_week, {})

    def test_the_admin_uses_the_validating_form(self):
        from apps.accounts.models import User

        admin_user = User.objects.create_superuser(email="root@x.it", password="pw-lunga-123")
        self.client.force_login(admin_user)
        url = f"/admin/core/salonsettings/{self.settings.pk}/change/"
        resp = self.client.post(url, self._data({"0": ["09:00-19:00"]}))
        self.assertEqual(resp.status_code, 200)  # il form torna con l'errore
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.opening_hours_week, {})
        resp = self.client.post(url, self._data({"0": [["09:00", "19:00"]]}))
        self.assertEqual(resp.status_code, 302)
        self.settings.refresh_from_db()
        self.assertEqual(self.settings.opening_hours_week["0"], [["09:00", "19:00"]])
