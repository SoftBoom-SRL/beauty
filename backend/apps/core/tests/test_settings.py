"""Impostazioni del salone: API, branding pubblico, logo, sedi, regole caparra, orari.

Gli orari si possono scrivere anche da /admin/, con lo stesso controllo del
formato dell'API.
"""

import json
import os
import shutil
import tempfile
from decimal import Decimal
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from common.testing import bearer, post_json, put_json

from ..admin import SalonSettingsAdminForm
from ..models import DepositRule, Location, Salon, SalonSettings
from .base import _owner


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
        self.auth = bearer(self.user, self.salon)

    def _put(self, payload):
        return put_json(self.client, "/api/core/settings", payload, **self.auth)

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

    def test_explicit_nulls_do_not_reach_the_columns(self):
        # I campi sono Optional: un null mandato apposta arrivava a `int()` (500)
        # o finiva su colonne NOT NULL. Significa «non tocco», non «azzera».
        resp = self._put({
            "slot_interval_min": None,
            "deposit_hold_minutes": None,
            "brand_color": None,
            "lastminute_monthly_budget": None,
        })
        self.assertEqual(resp.status_code, 200, resp.content)
        saved = SalonSettings.objects.get(salon=self.salon)
        self.assertEqual(saved.slot_interval_min, 15)
        self.assertEqual(saved.brand_color, "#6366F1")

    def test_values_out_of_range_and_unknown_enums_are_refused(self):
        for payload in (
            {"lastminute_discount_cap": 500},
            {"flexible_reward_pct": 1000},
            {"flexible_window_min": 99999},
            {"deposit_hold_minutes": -1},
            {"agenda_fill": "massimo"},
            {"slot_recovery": "forse"},
            {"brand_color": "rosso"},
            {"lastminute_monthly_budget": -5},
        ):
            with self.subTest(payload=payload):
                self.assertEqual(self._put(payload).status_code, 400, payload)
        saved = SalonSettings.objects.get(salon=self.salon)
        self.assertEqual(saved.agenda_fill, "max_revenue")
        self.assertEqual(saved.flexible_reward_pct, 10)

    def test_a_brand_colour_with_a_trailing_newline_is_refused(self):
        """Bug sospetti del 24/09, voce 13: il colore si controllava con `$`.

        Con `re.match`, `$` accetta anche un a capo finale: «#AABBCC\\n»
        passava e arrivava a una colonna di sette caratteri, che PostgreSQL
        rifiuta (500); su SQLite il colore con l'a capo restava salvato.
        """
        resp = self._put({"brand_color": "#AABBCC\n"})
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(SalonSettings.objects.get(salon=self.salon).brand_color, "#6366F1")
        self.assertEqual(self._put({"brand_color": "#AABBCC"}).status_code, 200)

    def test_privacy_policy_url_must_be_a_real_address(self):
        # Il valore è reso come href nell'app pubblica delle clienti.
        self.assertEqual(self._put({"privacy_policy_url": "javascript:alert(1)"}).status_code, 400)
        self.assertEqual(self._put({"privacy_policy_url": "www.theparlour.it"}).status_code, 400)
        ok = self._put({"privacy_policy_url": "https://theparlour.it/privacy"})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["privacy_policy_url"], "https://theparlour.it/privacy")
        # la stringa vuota resta il modo per toglierlo
        self.assertEqual(self._put({"privacy_policy_url": ""}).json()["privacy_policy_url"], "")

    def test_lowering_the_hold_alone_cannot_orphan_the_reminder(self):
        # hold 120 / sollecito 60: portando hold a 30 il sollecito non sarebbe
        # più partito, e in Impostazioni avrebbe continuato a mostrare 60.
        self.assertEqual(
            self._put({"deposit_hold_minutes": 120, "deposit_reminder_minutes": 60}).status_code, 200
        )
        refused = self._put({"deposit_hold_minutes": 30})
        self.assertEqual(refused.status_code, 400, refused.content)
        saved = SalonSettings.objects.get(salon=self.salon)
        self.assertEqual((saved.deposit_hold_minutes, saved.deposit_reminder_minutes), (120, 60))
        ok = self._put({"deposit_hold_minutes": 30, "deposit_reminder_minutes": 15})
        self.assertEqual(ok.status_code, 200, ok.content)

    def test_opening_hours_cannot_run_past_midnight(self):
        self.assertEqual(self._put({"opening_hours_week": {"0": [["24:00", "24:30"]]}}).status_code, 400)
        self.assertEqual(self._put({"opening_hours_week": {"0": [["20:00", "25:00"]]}}).status_code, 400)
        # fino a mezzanotte esatta è legittimo
        ok = self._put({"opening_hours_week": {"0": [["20:00", "24:00"]]}})
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()["opening_hours_week"]["0"], [["20:00", "24:00"]])

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
        SalonSettings.objects.create(salon=self.salon, opening_hours="Lun-Ven 9-19")

        resp = self.client.get("/api/core/public/branding", {"salon": "the-parlour"})
        self.assertEqual(resp.status_code, 200, resp.content)
        data = resp.json()
        self.assertEqual(data["address"], "Via Milano 2")
        self.assertEqual(data["phone"], "022222222")
        self.assertEqual(data["opening_hours"], "Lun-Ven 9-19")

    def test_a_public_visit_does_not_create_rows(self):
        # L'endpoint è aperto e senza autenticazione: bastava chiamarlo per far
        # nascere una riga di impostazioni a ogni salone sconosciuto.
        self.assertEqual(SalonSettings.objects.count(), 0)
        resp = self.client.get("/api/core/public/branding", {"salon": "the-parlour"})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["brand_color"], "#6366F1")  # valori predefiniti
        self.assertEqual(SalonSettings.objects.count(), 0)

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

    @override_settings(CLIENT_MOVE_CANCEL_MIN_HOURS=48)
    def test_the_cancellation_policy_is_knowable_by_the_client_app(self):
        """L'app cliente scriveva «24h» a codice fisso: un salone con una soglia
        diversa prometteva una regola che il server non applicava."""
        resp = self.client.get("/api/core/public/branding", {"salon": "the-parlour"})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["cancel_min_hours"], 48)


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
        self.auth = bearer(self.user, self.salon)

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

    def test_only_real_images_are_accepted(self):
        # branding/ non è fra i percorsi riservati: il file è scaricabile da
        # chiunque sull'origin dell'API, dove vive anche /admin/. Un .html
        # dichiarato "image/png" eseguirebbe JavaScript in quell'origin.
        evil = SimpleUploadedFile(
            "evil.html", b"<script>alert(1)</script>", content_type="image/png"
        )
        resp = self.client.post("/api/core/settings/logo", {"logo": evil}, **self.auth)
        self.assertEqual(resp.status_code, 400, resp.content)
        # tipo dichiarato non ammesso, anche con estensione buona
        resp = self.client.post(
            "/api/core/settings/logo",
            {"logo": SimpleUploadedFile("logo.png", b"x", content_type="text/html")},
            **self.auth,
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertFalse(SalonSettings.objects.filter(salon=self.salon, logo__gt="").exists())

    def test_an_oversized_logo_is_refused(self):
        from apps.core.api import LOGO_MAX_BYTES

        big = SimpleUploadedFile(
            "logo.png", b"0" * (LOGO_MAX_BYTES + 1), content_type="image/png"
        )
        resp = self.client.post("/api/core/settings/logo", {"logo": big}, **self.auth)
        self.assertEqual(resp.status_code, 400, resp.content)

    def test_the_stored_name_is_decided_by_the_server(self):
        upload = SimpleUploadedFile(
            "../../../etc/passwd.png", b"fake-image-bytes", content_type="image/png"
        )
        resp = self.client.post("/api/core/settings/logo", {"logo": upload}, **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        name = SalonSettings.objects.get(salon=self.salon).logo.name
        self.assertTrue(name.startswith("branding/"), name)
        self.assertTrue(name.endswith(".png"), name)
        self.assertNotIn("passwd", name)


class LocationDefaultTests(TestCase):
    """La sede predefinita è UNA: chi legge fa filter(is_default=True).first()."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="titolare2@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = bearer(owner, self.salon)

    def _post(self, body):
        return post_json(self.client, "/api/core/locations", body, **self.auth)

    def test_marking_a_new_default_clears_the_previous_one(self):
        first = self._post({"name": "Centro", "address": "Via Roma 1", "is_default": True}).json()
        second = self._post({"name": "Nuova sede", "address": "Via Milano 2", "is_default": True}).json()
        defaults = list(
            Location.objects.filter(salon=self.salon, is_default=True).values_list("id", flat=True)
        )
        self.assertEqual(defaults, [second["id"]])
        self.assertFalse(Location.objects.get(pk=first["id"]).is_default)
        # ed è quella che l'app cliente mostra
        public = self.client.get("/api/core/public/branding?salon=the-parlour").json()
        self.assertEqual(public["address"], "Via Milano 2")

    def test_promoting_an_existing_location_demotes_the_others(self):
        first = self._post({"name": "Centro", "is_default": True}).json()
        second = self._post({"name": "Nuova sede", "is_default": False}).json()
        resp = put_json(
            self.client,
            f"/api/core/locations/{second['id']}",
            {"name": "Nuova sede", "is_default": True},
            **self.auth,
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertFalse(Location.objects.get(pk=first["id"]).is_default)
        self.assertTrue(Location.objects.get(pk=second["id"]).is_default)

    def test_the_admin_keeps_a_single_default_too(self):
        """Bug sospetti del 24/09, voce 29: anche da /admin/ la sede predefinita resta una.

        L'API toglie il segno alle altre sedi, il salvataggio dell'admin no:
        segnando «predefinita» una seconda sede ne restavano due, e l'app
        clienti continuava a lavorare sulla più vecchia.
        """
        from apps.accounts.models import User

        from ..services import default_location

        Location.objects.create(salon=self.salon, name="Centro", address="Via Roma 1", is_default=True)
        second = Location.objects.create(salon=self.salon, name="Nuova sede", address="Via Milano 2")
        self.client.force_login(User.objects.create_superuser(email="root@x.it", password="pw-lunga-123"))

        def defaults():
            return list(Location.objects.filter(salon=self.salon, is_default=True).values_list("name", flat=True))

        form = {"salon": self.salon.pk, "address": "", "phone": "", "is_default": "on"}
        resp = self.client.post(
            f"/admin/core/location/{second.pk}/change/",
            {**form, "name": "Nuova sede", "address": "Via Milano 2"},
        )
        self.assertEqual(resp.status_code, 302, resp.content)
        self.assertEqual(defaults(), ["Nuova sede"])
        self.assertEqual(default_location(self.salon), second)
        # Lo stesso per una sede nuova.
        resp = self.client.post("/admin/core/location/add/", {**form, "name": "Terza sede"})
        self.assertEqual(resp.status_code, 302, resp.content)
        self.assertEqual(defaults(), ["Terza sede"])


class SettingsAuditExtrasTests(TestCase):
    """Caparra con scadenza, motivazioni personalizzate e stato Stripe nelle impostazioni."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="owner@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = bearer(owner, self.salon)

    def _put(self, body):
        return put_json(self.client, "/api/core/settings", body, **self.auth)

    def test_hold_reminder_and_reasons_round_trip(self):
        res = self._put({"deposit_hold_minutes": 20, "deposit_reminder_minutes": 10, "cancel_reasons": [" Richiesta cliente ", "Malattia", ""], "no_show_reasons": ["Non presentata"]})
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        self.assertEqual(data["deposit_hold_minutes"], 20)
        self.assertEqual(data["deposit_reminder_minutes"], 10)
        self.assertEqual(data["cancel_reasons"], ["Richiesta cliente", "Malattia"])
        self.assertEqual(data["no_show_reasons"], ["Non presentata"])
        self.assertFalse(data["stripe_connected"])
        # il sollecito deve precedere la scadenza
        self.assertEqual(self._put({"deposit_hold_minutes": 20, "deposit_reminder_minutes": 25}).status_code, 400)
        # la modalità di riempimento predefinita è quella ottimizzata
        self.assertEqual(data["agenda_fill"], "max_revenue")


# ---------------------------------------------------------------------------
# Impostazioni, logo, regole caparra, orari da /admin/.
#
# Caccia ai bug del 22/09: 08-18 + 18-07, 15-16 (lato server), 08-15. Il 08-16
# (date del registro attività) è in test_activity.py.
# ---------------------------------------------------------------------------


# PNG 1x1 valido
PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f"
    b"\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe\xa7\x35\x81\x84\x00"
    b"\x00\x00\x00IEND\xaeB`\x82"
)


class _StaleSettings:
    """Simula la corsa: le impostazioni vengono lette a inizio richiesta e, prima
    del salvataggio, il callback di Stripe Connect scrive l'account collegato."""

    def __init__(self):
        from .. import api as core_api

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
            resp = put_json(self.client, "/api/core/settings", {"brand_color": "#112233"}, **self.auth)
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
        return post_json(self.client, "/api/core/deposit-rules", payload, **self.auth)

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
        resp = put_json(
            self.client,
            f"/api/core/deposit-rules/{rule_id}",
            {"name": "Regola", "amount_type": "pct", "amount": "150"},
            **self.auth,
        )
        self.assertEqual(resp.status_code, 400)
        rule = DepositRule.objects.get(pk=rule_id)
        self.assertEqual((rule.amount_type, rule.amount), ("fixed", Decimal("150.00")))

    def test_editing_and_deleting_a_rule_reach_the_other_workstations(self):
        """Modifica ed eliminazione finiscono nel registro, e quindi nel feed live."""
        from apps.core.models import ActivityLog

        rule_id = self._post(amount_type="fixed", amount="20").json()["id"]
        resp = put_json(
            self.client,
            f"/api/core/deposit-rules/{rule_id}",
            {"name": "Colore", "amount_type": "fixed", "amount": "25"},
            **self.auth,
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


class OpeningHoursNotSetTests(TestCase):
    """Segnalato da CORE-INSIGHTS: `{}` è «non impostati», non «chiuso tutti i giorni»."""

    def test_an_empty_week_stays_not_set(self):
        from ..services import normalize_opening_hours_week

        self.assertEqual(normalize_opening_hours_week({}), {})
        # sette giorni vuoti scritti per esteso restano invece «chiuso»
        closed = normalize_opening_hours_week({str(day): [] for day in range(7)})
        self.assertEqual(closed, {str(day): [] for day in range(7)})
