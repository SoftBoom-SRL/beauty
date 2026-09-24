"""Il modulo pubblico di raccolta contatti: POST /api/clients/public/hook."""

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone

from apps.core.models import ActivityLog, Salon, SalonSettings

from ..models import Client


class PublicHookTests(TestCase):
    """POST /api/clients/public/hook: il form pubblico di raccolta contatti.

    Testato via HTTP e non chiamando la view: è l'unico endpoint del router
    senza auth, e metà del suo comportamento (403, 404, sempre 200) sta nei
    codici di stato.
    """

    URL = "/api/clients/public/hook"

    def setUp(self):
        # Il rate limit vive su core.RateLimitCounter (common.ratelimit), quindi
        # lo azzera il rollback di TestCase. cache.clear() resta per tutto il
        # resto che passa dalla cache.
        cache.clear()
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _with_privacy_policy(self):
        SalonSettings.objects.create(
            salon=self.salon, privacy_policy_url="https://theparlour.it/privacy"
        )

    def _post(self, **overrides):
        body = {
            "salon_slug": "the-parlour",
            "first_name": "Sofia",
            "last_name": "Ricci",
            "phone": "3331234567",
            "email": "sofia@esempio.it",
            "marketing": True,
            "privacy": True,
        }
        body.update(overrides)
        return self.client.post(self.URL, body, content_type="application/json")

    def test_lead_lands_in_the_address_book(self):
        self._with_privacy_policy()
        self.assertEqual(self._post().status_code, 200)
        # il numero viene salvato in E.164: «3331234567» e «+39 333 1234567» sono lo stesso cliente
        client = Client.objects.get(salon=self.salon, phone="+393331234567")
        self.assertEqual(client.origin, "hook")
        self.assertTrue(client.consents["privacy"])
        self.assertTrue(client.consents["privacy_at"])  # senza data non è dimostrabile
        self.assertTrue(client.categories.filter(name="Da form").exists())

    def test_collects_even_without_privacy_policy(self):
        """Decisione presa, non svista: senza informativa il modulo raccoglie
        lo stesso. Chiuderlo spegnerebbe la raccolta contatti alla maggior parte
        dei saloni attivi. Restano il WARNING nei log e l'avviso in dashboard."""
        self.assertEqual(self._post().status_code, 200)
        self.assertTrue(Client.objects.filter(salon=self.salon).exists())

    def test_unknown_salon_404(self):
        resp = self._post(salon_slug="non-esiste")
        self.assertEqual(resp.status_code, 404)

    def test_existing_client_keeps_their_data(self):
        """Chi è già in rubrica: si aggiornano i consensi, non si riscrive la scheda."""
        existing = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci",
            phone="3331234567", email="vera@esempio.it",
        )
        self.assertEqual(self._post(first_name="Impostora", email="falsa@esempio.it").status_code, 200)
        existing.refresh_from_db()
        self.assertEqual(existing.first_name, "Sofia")
        self.assertEqual(existing.email, "vera@esempio.it")
        self.assertTrue(existing.consents["marketing"])
        self.assertFalse(existing.categories.filter(name="Da form").exists())

    def test_honeypot_is_dropped_silently(self):
        self.assertEqual(self._post(trap=True).status_code, 200)  # 200 per non istruire i bot
        self.assertFalse(Client.objects.filter(salon=self.salon).exists())

    def test_privacy_consent_required(self):
        self.assertEqual(self._post(privacy=False).status_code, 400)
        self.assertFalse(Client.objects.filter(salon=self.salon).exists())

    def test_rate_limit_stops_the_flood(self):
        for i in range(20):
            self.assertEqual(self._post(phone=f"33300000{i:02d}").status_code, 200)
        self.assertEqual(self._post(phone="3339999999").status_code, 200)  # scartata, non 429
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 20)

    def test_the_counter_does_not_live_in_the_cache(self):
        """Il contatore è su core.RateLimitCounter, non sulla cache.

        Sulla cache era un leggi-poi-scrivi: duecento richieste in parallelo
        leggevano quasi tutte lo stesso valore, il contatore avanzava di poche
        unità e il tetto non fermava il flood. Qui lo verifichiamo per via
        indiretta: svuotare la cache non regala quota nuova.
        """
        for i in range(20):
            self.assertEqual(self._post(phone=f"33300000{i:02d}").status_code, 200)
        cache.clear()
        self.assertEqual(self._post(phone="3339999999").status_code, 200)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 20)

    def test_a_double_submit_answers_200_and_creates_one_card(self):
        """Doppio tocco su «Invia»: prima la seconda richiesta violava il
        vincolo di unicità e usciva come 500 su un endpoint che per progetto
        risponde sempre 200 (altrimenti dice a uno sconosciuto chi è cliente)."""
        from unittest.mock import patch

        self.assertEqual(self._post().status_code, 200)
        # find_client_by_phone cieco = le due richieste che partono insieme e
        # non vedono ancora la scheda dell'altra.
        with patch("apps.clients.hook.find_client_by_phone", side_effect=[None, Client.objects.get()]) as finder:
            self.assertEqual(self._post().status_code, 200)
        self.assertEqual(finder.call_count, 2)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)

    def test_a_disabled_card_is_signalled_not_revived(self):
        """Una cliente archiviata che ricompila il modulo: il contatto non deve
        restare invisibile, ma nemmeno tornare attivo da solo con un consenso
        marketing dato da chiunque conosca nome e numero (10-15). La scheda
        resta com'è e il salone riceve la segnalazione con la scheda da aprire."""
        disabled = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567", is_active=False
        )
        self.assertEqual(self._post().status_code, 200)
        disabled.refresh_from_db()
        self.assertFalse(disabled.is_active)
        self.assertFalse(disabled.consents.get("marketing"))
        self.assertFalse(disabled.categories.filter(name="Da form").exists())
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)
        notice = ActivityLog.objects.get(type="client.reactivation_requested")
        self.assertEqual(notice.payload["client_id"], disabled.id)

    def test_a_lead_from_the_form_is_a_client_from_today(self):
        self.assertEqual(self._post().status_code, 200)
        client = Client.objects.get(salon=self.salon)
        self.assertEqual(client.since, timezone.localdate())

    def test_forged_forwarded_for_does_not_reset_the_counter(self):
        """La catena X-Forwarded-For è scrivibile dal client, ma il nostro proxy
        accoda in fondo il peer che ha davvero aperto la connessione: cambiare i
        primi elementi non regala quota nuova.

        Qui il proxy lo simuliamo noi — `peer` è quello che Traefik accoderebbe.
        """
        peer = "203.0.113.7"

        def post(prefix, phone):
            return self.client.post(
                self.URL,
                {"salon_slug": "the-parlour", "first_name": "Sofia", "phone": phone, "privacy": True},
                content_type="application/json",
                HTTP_X_FORWARDED_FOR=f"{prefix}, {peer}",
            )

        for i in range(20):
            self.assertEqual(post(f"10.0.0.{i}", f"33300000{i:02d}").status_code, 200)
        # 21ª richiesta, prefisso mai visto ma stesso peer in fondo → scartata.
        self.assertEqual(post("9.9.9.9", "3339999999").status_code, 200)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 20)


# ---------------------------------------------------------------------------
# Caccia 22/09 — il modulo pubblico di raccolta contatti (/<slug>/hook).
#
# 10-15: una scheda archiviata dallo staff non si riattiva da un endpoint
# pubblico. 06-10: l'aggiornamento dei consensi arriva alla scheda aperta in
# dashboard (`client.updated` con il suo id). 06-20 (C13): il contatto nuovo
# nasce nella lingua dell'app.
# ---------------------------------------------------------------------------


class _HookBase(TestCase):
    URL = "/api/clients/public/hook"

    def setUp(self):
        cache.clear()
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def post(self, **overrides):
        body = {
            "salon_slug": "the-parlour",
            "first_name": "Sofia",
            "last_name": "Ricci",
            "phone": "3331234567",
            "email": "sofia@esempio.it",
            "marketing": True,
            "privacy": True,
        }
        body.update(overrides)
        res = self.client.post(self.URL, body, content_type="application/json")
        self.assertEqual(res.status_code, 200, res.content)
        return res


class LeadLanguageTests(_HookBase):
    def test_a_new_contact_speaks_the_language_of_the_app(self):
        self.post(lang="en")
        self.assertEqual(Client.objects.get(salon=self.salon).lang, "en")

    def test_without_or_with_an_unknown_language_it_is_italian(self):
        self.post(phone="3331234567")
        self.post(phone="3331234568", lang="fr")
        self.assertEqual(set(Client.objects.values_list("lang", flat=True)), {"it"})

    def test_an_existing_card_keeps_its_language(self):
        Client.objects.create(salon=self.salon, first_name="Sofia", phone="+393331234567", lang="it")
        self.post(lang="en")
        self.assertEqual(Client.objects.get(salon=self.salon).lang, "it")


class ExistingCardTests(_HookBase):
    def test_the_open_card_is_told_to_reload(self):
        card = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+393331234567")
        self.post()
        log = ActivityLog.objects.get(type="client.updated")
        self.assertEqual(log.payload["client_id"], card.id)
        self.assertIn("consents", log.payload["fields"])

    def test_consent_given_again_after_a_revocation(self):
        card = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567",
            consents={"privacy": True, "marketing": False, "marketing_at": "",
                      "marketing_revoked_at": "2026-09-01T10:00:00"},
        )
        with patch("apps.marketing.services.marketing_consent_changed", create=True) as changed:
            self.post(marketing=True)
        card.refresh_from_db()
        self.assertTrue(card.consents["marketing"])
        self.assertTrue(card.consents["marketing_at"])
        self.assertNotIn("marketing_revoked_at", card.consents)
        self.assertEqual(changed.call_args.kwargs, {"accepted": True})

    def test_the_form_never_revokes_marketing(self):
        card = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567",
            consents={"privacy": True, "marketing": True, "marketing_at": "2026-01-01T10:00:00"},
        )
        with patch("apps.marketing.services.marketing_consent_changed", create=True) as changed:
            self.post(marketing=False)
        card.refresh_from_db()
        self.assertTrue(card.consents["marketing"])
        self.assertEqual(card.consents["marketing_at"], "2026-01-01T10:00:00")
        changed.assert_not_called()


class ArchivedCardTests(_HookBase):
    def test_an_archived_card_is_not_revived_by_the_public_form(self):
        archived = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567", is_active=False,
            consents={"privacy": True, "marketing": False, "marketing_revoked_at": "2026-05-01T10:00:00"},
        )
        self.post(email="altra@esempio.it")
        archived.refresh_from_db()
        self.assertFalse(archived.is_active)
        self.assertFalse(archived.consents["marketing"])
        self.assertEqual(archived.email, "")
        self.assertEqual(archived.categories.count(), 0)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)
        self.assertFalse(ActivityLog.objects.filter(type__in=["client.created", "client.updated"]).exists())

    def test_the_salon_hears_about_it_once_a_day(self):
        archived = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567", is_active=False
        )
        self.post()
        self.post()
        notices = ActivityLog.objects.filter(type="client.reactivation_requested")
        self.assertEqual(notices.count(), 1)
        self.assertEqual(notices[0].payload, {"client_id": archived.id, "source": "hook"})
