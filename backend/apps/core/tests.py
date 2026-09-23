import json
import os
import shutil
import tempfile
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone

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
        self.assertEqual(s.agenda_fill, "max_revenue")  # disponibilità ottimizzata: il default
        self.assertEqual(s.slot_interval_min, 15)

    def test_log_and_emit(self):
        log = log_activity(self.salon, "test.event", "Prova")
        self.assertEqual(log.type, "test.event")
        ev = emit_event(self.salon, "test.event", {"a": 1})
        self.assertEqual(ev.status, "pending")

    def test_a_very_long_name_or_summary_does_not_break_the_action(self):
        # log_activity gira DENTRO la transazione dell'operazione: un nome di
        # 130 caratteri faceva fallire ogni azione registrata da quella persona.
        from apps.accounts.models import User

        user = User.objects.create_user(
            email="lunga@theparlour.it", password="x" * 10,
            first_name="A" * 90, last_name="B" * 90,
        )
        log = log_activity(self.salon, "client.updated", "S" * 400, actor=user)
        log.refresh_from_db()
        self.assertEqual(len(log.actor_name), 120)
        self.assertEqual(len(log.summary), 255)

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
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}

    def _post(self, body):
        return self.client.post(
            "/api/core/locations", data=json.dumps(body), content_type="application/json", **self.auth
        )

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
        resp = self.client.put(
            f"/api/core/locations/{second['id']}",
            data=json.dumps({"name": "Nuova sede", "is_default": True}),
            content_type="application/json",
            **self.auth,
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertFalse(Location.objects.get(pk=first["id"]).is_default)
        self.assertTrue(Location.objects.get(pk=second["id"]).is_default)


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
        # secondo giro: niente di nuovo. Può tornare un evento appena scritto con
        # id sotto il cursore (finestra di sicurezza, contratto C20): mai uno
        # non ancora visto, e la dashboard scarta i doppioni per id.
        again = self._feed(after=data["cursor"])
        self.assertTrue(
            {e["id"] for e in again["events"]} <= {e["id"] for e in data["events"]}
        )
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

    def test_feed_and_stream_deliver_the_same_events(self):
        # Il polling di riserva deve vedere gli stessi eventi dello stream SSE:
        # confrontare i due elenchi di prefissi non provava nulla (è lo stesso
        # oggetto importato), quindi si confrontano le CONSEGNE alla stessa
        # persona.
        from apps.core.views import event_generator

        log_activity(self.salon, "appointment.created", "Punto di partenza")
        start = self._feed()["cursor"]
        log_activity(self.salon, "appointment.created", "Appuntamento")
        log_activity(self.salon, "client_category.created", "Etichetta")  # senza scope clients
        log_activity(self.salon, "pause.updated", "Pausa")
        from_polling = [e["type"] for e in self._feed(after=start)["events"]]
        frames = list(
            event_generator(self.salon.id, start, scopes={"agenda"}, max_seconds=0.05, poll=0)
        )
        body = json.loads(
            [f for f in frames if "event: events" in f][0].split("data: ", 1)[1]
        )
        self.assertEqual(from_polling, [e["type"] for e in body["events"]])
        self.assertEqual(from_polling, ["appointment.created", "pause.updated"])

    def test_deposit_events_reach_the_dashboard(self):
        # La cliente paga la caparra: senza il prefisso `deposit.` l'agenda
        # restava col pallino «caparra richiesta» fino a un ricaricamento.
        start = self._feed()["cursor"]
        log_activity(self.salon, "deposit.paid", "Caparra pagata")
        log_activity(self.salon, "deposit.refunded", "Caparra rimborsata")
        data = self._feed(after=start)
        self.assertEqual(
            [e["type"] for e in data["events"]], ["deposit.paid", "deposit.refunded"]
        )

    def test_areas_without_permission_are_not_delivered(self):
        # L'operatrice ha solo l'agenda: incassi, magazzino e gift card sono
        # esattamente ciò che il permesso d'area le nega, e il feed live non
        # deve essere la scorciatoia per leggerli comunque.
        start = self._feed()["cursor"]
        log_activity(self.salon, "appointment.created", "Suo")
        log_activity(self.salon, "sale.created", "Incasso")
        log_activity(self.salon, "stock.loaded", "Carico")
        log_activity(self.salon, "giftcard.created", "Gift card")
        last = log_activity(self.salon, "pause.updated", "Pausa")
        data = self._feed(after=start)
        self.assertEqual(
            [e["type"] for e in data["events"]], ["appointment.created", "pause.updated"]
        )
        # il cursore avanza comunque: gli eventi negati non si richiedono in eterno
        self.assertEqual(data["cursor"], last.id)

    def test_salon_settings_reach_every_member(self):
        """Le impostazioni del salone fanno eccezione, ed è voluto.

        Prima erano riservate al titolare insieme a incassi e magazzino, ma
        orari, intervallo delle fasce e regole del salone li legge già chiunque
        da /api/core/salon, e la dashboard ricarica proprio su questi eventi:
        riservarli significava che un cambio di orari fatto dal titolare non
        raggiungeva più le altre postazioni fino al ricaricamento della pagina.
        Il sommario non contiene dati di cassa.
        """
        start = self._feed()["cursor"]
        log_activity(self.salon, "settings.updated", "Impostazioni aggiornate")
        data = self._feed(after=start)
        self.assertEqual([e["type"] for e in data["events"]], ["settings.updated"])

    def test_the_owner_receives_every_area(self):
        from apps.accounts.models import Membership, User

        owner = User.objects.create_user(email="titolare@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}
        start = self.client.get("/api/core/activity/feed", **auth).json()["cursor"]
        log_activity(self.salon, "sale.created", "Incasso")
        log_activity(self.salon, "settings.updated", "Impostazioni")
        data = self.client.get(f"/api/core/activity/feed?after={start}", **auth).json()
        self.assertEqual([e["type"] for e in data["events"]], ["sale.created", "settings.updated"])


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
        self.assertTrue(res.json()["ticket"])
        self.assertEqual(self.client.get("/api/core/activity/stream?ticket=nope").status_code, 403)
        # generatore limitato nel tempo: primo frame `ready` con il cursore corrente
        from apps.core.views import event_generator

        log_activity(self.salon, "appointment.created", "A")
        frames = list(event_generator(self.salon.id, 0, scopes={"agenda"}, max_seconds=0, poll=0))
        self.assertTrue(frames[0].startswith("id: "))
        self.assertIn("event: ready", frames[0])
        self.assertIn("event: bye", frames[-1])

    def test_generator_pushes_new_events_after_cursor(self):
        from apps.core.views import event_generator

        first = log_activity(self.salon, "appointment.created", "Prima")
        log_activity(self.salon, "team.role_created", "Amministrativo")  # filtrato
        new = log_activity(self.salon, "pause.updated", "Pausa", actor=self.user)
        frames = list(
            event_generator(self.salon.id, first.id, scopes={"agenda"}, max_seconds=0.05, poll=0)
        )
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

    def test_the_ticket_carries_the_permissions_and_the_stream_filters(self):
        # Il ticket è l'unica cosa che lo stream conosce di chi ascolta
        # (EventSource non manda header): senza i permessi dentro, consegnava
        # incassi e impostazioni a qualunque membro autenticato.
        from django.core.cache import cache

        res = self.client.post("/api/core/activity/stream-ticket", **self.auth)
        ticket = res.json()["ticket"]
        info = cache.get(f"stream-ticket:{ticket}")
        self.assertEqual(info["scopes"], ["agenda"])
        self.assertFalse(info["is_owner"])

        before = log_activity(self.salon, "appointment.created", "Punto di partenza")
        log_activity(self.salon, "sale.created", "Incasso")
        log_activity(self.salon, "appointment.moved", "Appuntamento spostato")
        from unittest import mock

        with mock.patch("apps.core.views.STREAM_MAX_SECONDS", 0.05):
            stream = self.client.get(
                f"/api/core/activity/stream?ticket={ticket}&after={before.id}"
            )
            body = b"".join(stream.streaming_content).decode()
        self.assertIn("appointment.moved", body)
        self.assertNotIn("sale.created", body)


class SettingsAuditExtrasTests(TestCase):
    """Caparra con scadenza, motivazioni personalizzate e stato Stripe nelle impostazioni."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="owner@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}

    def _put(self, body):
        return self.client.put("/api/core/settings", data=json.dumps(body), content_type="application/json", **self.auth)

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


class FlushOutboxTests(TestCase):
    """La outbox viene consegnata davvero quando YOURANG_API_URL è configurato."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    @override_settings(YOURANG_API_URL="https://yourang.example/events", YOURANG_API_KEY="k")
    def test_delivery_marks_sent_and_failures_are_retried(self):
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import MAX_ATTEMPTS, flush_pending

        from .models import OutboxEvent

        ok = emit_event(self.salon, "client.otp", {"code": "123456"})
        bad = emit_event(self.salon, "appointment.created", {"appointment_id": 1})

        def fake_post(url, json, headers):
            response = MagicMock()
            response.status_code = 200 if json["event_type"] == "client.otp" else 500
            response.text = "" if response.status_code == 200 else "boom"
            self.assertEqual(headers["Authorization"], "Bearer k")
            self.assertEqual(headers["Idempotency-Key"], f"outbox-{json['id']}")
            return response

        with patch("httpx.Client.post", side_effect=fake_post):
            sent, failed = flush_pending()
        self.assertEqual((sent, failed), (1, 1))
        ok.refresh_from_db()
        bad.refresh_from_db()
        self.assertEqual(ok.status, OutboxEvent.Status.SENT)
        self.assertIsNotNone(ok.sent_at)
        self.assertEqual(bad.status, OutboxEvent.Status.PENDING)
        self.assertEqual(bad.attempts, 1)
        self.assertIn("HTTP 500", bad.last_error)
        # Il ritentativo è rimandato: un secondo giro immediato non lo tocca.
        self.assertIsNotNone(bad.next_attempt_at)
        with patch("httpx.Client.post", side_effect=fake_post):
            self.assertEqual(flush_pending(), (0, 0))

        bad.attempts = MAX_ATTEMPTS - 1
        bad.next_attempt_at = None
        bad.save(update_fields=["attempts", "next_attempt_at"])
        with patch("httpx.Client.post", side_effect=fake_post):
            flush_pending()
        bad.refresh_from_db()
        self.assertEqual(bad.status, OutboxEvent.Status.FAILED)
        self.assertIsNone(bad.next_attempt_at)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_the_wait_before_a_retry_doubles(self):
        from apps.core.management.commands.flush_outbox import _backoff_seconds

        waits = [_backoff_seconds(n) for n in range(1, 9)]
        self.assertEqual(waits[:4], [30, 60, 120, 240])
        self.assertTrue(all(b >= a for a, b in zip(waits, waits[1:])))
        # otto tentativi non si consumano più in quaranta secondi di disservizio
        self.assertGreater(sum(waits), 3600)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_an_event_already_taken_by_another_worker_is_not_sent_twice(self):
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import flush_pending

        from .models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "123456"})
        calls = []

        def fake_post(url, json, headers):
            calls.append(json["id"])
            response = MagicMock()
            response.status_code = 200
            response.text = ""
            return response

        # un altro worker l'ha già preso in carico un istante fa
        OutboxEvent.objects.filter(pk=event.pk).update(
            status=OutboxEvent.Status.SENDING, claimed_at=timezone.now()
        )
        with patch("httpx.Client.post", side_effect=fake_post):
            self.assertEqual(flush_pending(), (0, 0))
        self.assertEqual(calls, [])

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_the_claim_is_stamped_when_it_really_happens(self):
        """L'ultimo evento di un giro lungo non deve risultare preso in carico
        all'inizio del giro: il worker successivo lo considerava abbandonato
        mentre era ancora in volo e la cliente riceveva due volte lo stesso OTP.
        """
        from datetime import timedelta
        from itertools import count
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import (
            STALE_CLAIM_SECONDS,
            flush_pending,
            release_stale_claims,
        )

        from .models import OutboxEvent

        first = emit_event(self.salon, "client.otp", {"code": "1"})
        last = emit_event(self.salon, "client.otp", {"code": "2"})
        claims = {}

        def slow_post(url, json, headers):
            claims[json["id"]] = OutboxEvent.objects.get(pk=json["id"]).claimed_at
            return MagicMock(status_code=200, text="")

        # Orologio che avanza di dieci minuti a ogni lettura: è il caso reale di
        # Yourang lento con la coda piena, dove fra il primo e l'ultimo evento
        # del giro passa più della finestra di recupero.
        base = timezone.now()
        ticks = count()
        with patch(
            "django.utils.timezone.now", side_effect=lambda: base + timedelta(minutes=10 * next(ticks))
        ):
            with patch("httpx.Client.post", side_effect=slow_post):
                flush_pending()

        gap = (claims[last.id] - claims[first.id]).total_seconds()
        self.assertGreaterEqual(gap, STALE_CLAIM_SECONDS)  # con l'ora di inizio giro era 0
        # L'ultimo evento, appena preso in carico, non risulta abbandonato.
        OutboxEvent.objects.filter(pk=last.pk).update(
            status=OutboxEvent.Status.SENDING, claimed_at=claims[last.id]
        )
        self.assertEqual(release_stale_claims(now=claims[last.id] + timedelta(seconds=60)), 0)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_an_event_stuck_in_sending_goes_back_in_the_queue(self):
        from datetime import timedelta

        from apps.core.management.commands.flush_outbox import (
            STALE_CLAIM_SECONDS,
            release_stale_claims,
        )

        from .models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "123456"})
        OutboxEvent.objects.filter(pk=event.pk).update(
            status=OutboxEvent.Status.SENDING,
            claimed_at=timezone.now() - timedelta(seconds=STALE_CLAIM_SECONDS + 60),
        )
        self.assertEqual(release_stale_claims(), 1)
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.Status.PENDING)

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_the_access_code_is_wiped_once_the_message_is_delivered(self):
        from unittest.mock import MagicMock, patch

        from apps.core.management.commands.flush_outbox import flush_pending

        event = emit_event(
            self.salon, "client.otp", {"code": "123456", "phone": "+393331112222"}
        )
        response = MagicMock(status_code=200, text="")
        with patch("httpx.Client.post", return_value=response):
            flush_pending()
        event.refresh_from_db()
        self.assertEqual(event.payload["code"], "***")
        self.assertEqual(event.payload["phone"], "+393331112222")

    def test_delivered_events_are_purged_after_the_retention_window(self):
        from datetime import timedelta

        from apps.core.management.commands.flush_outbox import (
            PURGE_AFTER_DAYS,
            purge_delivered,
        )

        from .models import OutboxEvent

        old = emit_event(self.salon, "client.otp", {})
        recent = emit_event(self.salon, "client.otp", {})
        failed = emit_event(self.salon, "client.otp", {})
        now = timezone.now()
        OutboxEvent.objects.filter(pk=old.pk).update(
            status=OutboxEvent.Status.SENT, sent_at=now - timedelta(days=PURGE_AFTER_DAYS + 1)
        )
        OutboxEvent.objects.filter(pk=recent.pk).update(
            status=OutboxEvent.Status.SENT, sent_at=now
        )
        OutboxEvent.objects.filter(pk=failed.pk).update(status=OutboxEvent.Status.FAILED)

        self.assertEqual(purge_delivered(), 1)
        self.assertFalse(OutboxEvent.objects.filter(pk=old.pk).exists())
        # quelli recenti e quelli falliti restano: i falliti servono a capire cosa non va
        self.assertTrue(OutboxEvent.objects.filter(pk=recent.pk).exists())
        self.assertTrue(OutboxEvent.objects.filter(pk=failed.pk).exists())

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_an_unexpected_network_error_does_not_escape(self):
        from unittest.mock import patch

        from apps.core.management.commands.flush_outbox import flush_pending

        from .models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "123456"})
        with patch("httpx.Client.post", side_effect=OSError("rete sparita")):
            self.assertEqual(flush_pending(), (0, 1))
        event.refresh_from_db()
        self.assertEqual(event.status, OutboxEvent.Status.PENDING)
        self.assertIn("rete sparita", event.last_error)

    def test_without_url_nothing_is_sent(self):
        from apps.core.management.commands.flush_outbox import Command

        emit_event(self.salon, "client.otp", {"code": "123456"})
        out = Command()
        from io import StringIO

        out.stdout = StringIO()
        with override_settings(YOURANG_API_URL=""):
            out.handle(limit=200, loop=False, interval=1)
        self.assertIn("non configurato", out.stdout.getvalue())


class OutboxStatusApiTests(TestCase):
    """La diagnostica dice al titolare perché un OTP «non arriva»."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        owner = User.objects.create_user(email="owner2@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}
        staff = User.objects.create_user(email="front2@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Front", scopes=["agenda"])
        Membership.objects.create(user=staff, salon=self.salon, role=role)
        self.staff_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(staff, self.salon)['access']}"}

    @override_settings(YOURANG_API_URL="")
    def test_without_delivery_url_the_queue_is_reported(self):
        emit_event(self.salon, "client.otp", {"code": "123456"})
        emit_event(self.salon, "appointment.created", {"appointment_id": 1})
        res = self.client.get("/api/core/outbox/status", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        self.assertFalse(data["configured"])
        self.assertEqual(data["pending"], 2)
        self.assertEqual(data["sent_24h"], 0)
        self.assertIn("client.otp", data["pending_types"])
        self.assertIsNotNone(data["oldest_pending_at"])

    @override_settings(YOURANG_API_URL="https://yourang.example/events")
    def test_configured_reports_delivered_messages(self):
        from django.utils import timezone

        from .models import OutboxEvent

        event = emit_event(self.salon, "client.otp", {"code": "1"})
        OutboxEvent.objects.filter(pk=event.pk).update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
        data = self.client.get("/api/core/outbox/status", **self.auth).json()
        self.assertTrue(data["configured"])
        self.assertEqual((data["pending"], data["sent_24h"]), (0, 1))
        self.assertIsNotNone(data["last_sent_at"])

    def test_only_the_owner_sees_it(self):
        self.assertEqual(self.client.get("/api/core/outbox/status", **self.staff_auth).status_code, 403)


class StreamConnectionCapTests(TestCase):
    """Ogni stream live occupa un thread di gunicorn: oltre il tetto si risponde
    503 e la dashboard passa al polling, invece di esaurire il pool."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Owner", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}

    def _ticket(self):
        res = self.client.post("/api/core/activity/stream-ticket", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["ticket"]

    @override_settings(SSE_MAX_CONNECTIONS=2)
    def test_beyond_the_cap_the_stream_is_refused_and_the_slot_comes_back(self):
        from apps.core import views

        with patch.object(views, "STREAM_MAX_CONCURRENT", 2):
            open_responses = []
            for _ in range(2):
                res = self.client.get(f"/api/core/activity/stream?ticket={self._ticket()}")
                self.assertEqual(res.status_code, 200)
                open_responses.append(res)
            refused = self.client.get(f"/api/core/activity/stream?ticket={self._ticket()}")
            self.assertEqual(refused.status_code, 503)
            self.assertEqual(refused["Retry-After"], "30")

            for res in open_responses:
                res.close()
            self.assertEqual(views.open_stream_count(), 0)
            again = self.client.get(f"/api/core/activity/stream?ticket={self._ticket()}")
            self.assertEqual(again.status_code, 200)
            again.close()

    def test_a_zeroed_setting_falls_back_to_the_default_in_force(self):
        """Il ripiego era rimasto a 40, il vecchio tetto che con 24 thread non
        scattava mai: un'impostazione azzerata riportava quel comportamento."""
        import importlib

        from django.conf import settings as django_settings

        from apps.core import views

        with override_settings(SSE_MAX_CONNECTIONS=0):
            importlib.reload(views)
            self.assertEqual(views.STREAM_MAX_CONCURRENT, 12)
        importlib.reload(views)
        self.assertEqual(views.STREAM_MAX_CONCURRENT, django_settings.SSE_MAX_CONNECTIONS)


class RateLimitCounterTests(TestCase):
    """Il contatore dei limiti deve contare davvero, e per il tempo richiesto.

    Prima si appoggiava alla cache su database: `incr()` lì è una lettura
    seguita da una scrittura (due richieste parallele contavano per una) e la
    scrittura riportava la scadenza al valore predefinito, 300 secondi, qualsiasi
    finestra fosse stata chiesta.
    """

    def setUp(self):
        from common import ratelimit

        self.ratelimit = ratelimit

    def test_the_window_lasts_exactly_what_was_asked(self):
        from .models import RateLimitCounter

        before = timezone.now()
        self.ratelimit.hit("finestra", 5, 3600)
        row = RateLimitCounter.objects.get(key="finestra")
        self.assertGreater((row.expires_at - before).total_seconds(), 3590)

    def test_the_limit_stops_at_the_declared_number(self):
        results = [self.ratelimit.hit("tetto", 3, 3600) for _ in range(5)]
        self.assertEqual(results, [True, True, True, False, False])
        self.assertEqual(self.ratelimit.peek("tetto"), 5)

    def test_two_overlapping_requests_count_twice(self):
        # Si riproduce l'intreccio fra due processi: la seconda richiesta entra
        # mentre la prima sta ancora decidendo. L'incremento è una sola UPDATE
        # del database, quindi nessuno dei due conteggi va perso.
        from .models import RateLimitCounter

        self.ratelimit.hit("gara", 1, 3600)
        original = RateLimitCounter.objects.filter

        nested = []

        def interleaved(*args, **kwargs):
            qs = original(*args, **kwargs)
            if not nested:
                nested.append(None)
                self.ratelimit.hit("gara", 1, 3600)
            return qs

        with patch.object(RateLimitCounter.objects, "filter", side_effect=interleaved):
            self.ratelimit.hit("gara", 1, 3600)
        self.assertEqual(self.ratelimit.peek("gara"), 3)

    def test_an_expired_window_starts_over(self):
        from datetime import timedelta

        from .models import RateLimitCounter

        self.assertFalse(self.ratelimit.hit("scaduta", 0, 3600))
        RateLimitCounter.objects.filter(key="scaduta").update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.assertTrue(self.ratelimit.hit("scaduta", 1, 3600))
        self.assertEqual(self.ratelimit.peek("scaduta"), 1)

    def test_purge_removes_only_the_expired_windows(self):
        from datetime import timedelta

        from .models import RateLimitCounter

        self.ratelimit.hit("viva", 5, 3600)
        self.ratelimit.hit("morta", 5, 3600)
        RateLimitCounter.objects.filter(key="morta").update(
            expires_at=timezone.now() - timedelta(seconds=1)
        )
        self.ratelimit.purge_expired()
        self.assertEqual(
            list(RateLimitCounter.objects.values_list("key", flat=True)), ["viva"]
        )
