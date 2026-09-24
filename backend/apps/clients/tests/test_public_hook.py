"""Caccia 22/09 — il modulo pubblico di raccolta contatti (/<slug>/hook).

10-15: una scheda archiviata dallo staff non si riattiva da un endpoint
pubblico. 06-10: l'aggiornamento dei consensi arriva alla scheda aperta in
dashboard (`client.updated` con il suo id). 06-20 (C13): il contatto nuovo
nasce nella lingua dell'app.
"""

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase

from apps.core.models import ActivityLog, Salon

from ..models import Client


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
