"""Collegamento Stripe con Account Links: il portale crea l'account, il titolare lo completa su Stripe.

Stripe non dà più l'OAuth ai nuovi account di piattaforma (o solo dopo una
revisione): la strada principale è creare l'account del salone e mandare il
titolare sull'onboarding ospitato da Stripe. I soldi restano solo suoi, e
finché Stripe non attiva l'account nessun pagamento parte. Libreria stripe
vera, finto solo l'HTTP (`FakeStripeHTTP` in base.py).
"""

import json

from django.test import override_settings

from apps.core.models import ActivityLog, SalonSettings
from common.auth import create_staff_tokens

from .base import StripeTestBase, event_payload

LINK_URL = "https://connect.stripe.com/setup/s/acct_new/abc"


def _account(**state):
    return {"id": "acct_new", "object": "account", "details_submitted": False, "charges_enabled": False, **state}


@override_settings(
    STRIPE_SECRET_KEY="sk_test_x", STRIPE_CONNECT_CLIENT_ID="", STRIPE_WEBHOOK_SECRET="whsec_platform",
    FRONTEND_ORIGIN="https://beauty.example.com", CLIENT_APP_ORIGIN="https://app.example.com",
)
class AccountLinksTests(StripeTestBase):
    def setUp(self):
        super().setUp()
        from apps.accounts.models import Membership, User

        owner = User.objects.create_user(email="titolare@theparlour.it", password="x" * 10)
        Membership.objects.create(user=owner, salon=self.salon, is_owner=True)
        self.owner_auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(owner, self.salon)['access']}"}

    def _routes(self, *, account=None):
        return [
            ("POST", "/v1/accounts", _account()),
            ("POST", "/v1/account_links", {"object": "account_link", "url": LINK_URL, "expires_at": 1}),
            ("GET", "/v1/accounts/acct_new", account or _account()),
        ]

    def _start(self, auth=None, body="{}"):
        return self.client.post(
            "/api/sales/stripe/connect/start", data=body, content_type="application/json",
            **(auth or self.owner_auth),
        )

    def _status(self):
        return self.client.get("/api/sales/stripe/connect/status", **self.owner_auth).json()

    def _settings(self):
        return SalonSettings.objects.get(salon=self.salon)

    def test_connect_creates_the_salon_account_and_sends_the_owner_to_stripe(self):
        http = self.fake(self._routes())
        status = self._status()
        # Basta la chiave: il client id serve solo per collegare un account esistente.
        self.assertTrue(status["available"])
        self.assertFalse(status["oauth_available"])

        res = self._start()
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["url"], LINK_URL)

        created = http.calls_to("/v1/accounts")[0]
        self.assertNotIn("Stripe-Account", created["headers"])
        data = created["data"]
        # Come un account Standard: dashboard completa, commissioni al salone,
        # perdite a Stripe. La piattaforma non tocca i soldi.
        self.assertEqual(data["controller[stripe_dashboard][type]"], "full")
        self.assertEqual(data["controller[fees][payer]"], "account")
        self.assertEqual(data["controller[losses][payments]"], "stripe")
        self.assertEqual(data["controller[requirement_collection]"], "stripe")
        self.assertEqual(data["business_profile[name]"], "The Parlour")
        self.assertEqual(data["business_profile[mcc]"], "7230")
        self.assertEqual(data["business_profile[url]"], "https://app.example.com/the-parlour")
        self.assertEqual(data["metadata[salon_id]"], str(self.salon.id))
        self.assertEqual(data["email"], "titolare@theparlour.it")

        link = http.calls_to("/v1/account_links")[0]["data"]
        self.assertEqual(link["account"], "acct_new")
        self.assertEqual(link["type"], "account_onboarding")
        self.assertEqual(link["refresh_url"], "https://beauty.example.com/stripe-connect/start")
        self.assertEqual(link["return_url"], "https://beauty.example.com/stripe-connect/done")

        self.assertEqual(self._settings().stripe_account_id, "acct_new")
        status = self._status()
        self.assertEqual(status["state"], "incomplete")
        self.assertFalse(status["connected"])
        self.assertFalse(status["payments_enabled"])

    def test_a_second_start_reuses_the_account(self):
        http = self.fake(self._routes())
        self.assertEqual(self._start().status_code, 200)
        self.assertEqual(self._start().status_code, 200)
        self.assertEqual(len(http.calls_to("/v1/accounts")), 1)
        self.assertEqual(len(http.calls_to("/v1/account_links")), 2)

    def test_only_the_owner_connects_stripe(self):
        http = self.fake(self._routes())
        self.assertEqual(self._start(auth=self.auth).status_code, 403)
        self.assertEqual(http.calls, [])

    @override_settings(STRIPE_SECRET_KEY="")
    def test_without_the_platform_key_nothing_starts(self):
        self.assertEqual(self._start().status_code, 503)
        self.assertFalse(self._status()["available"])

    def test_an_account_not_yet_active_takes_no_payment(self):
        """Creato ma non attivato da Stripe: nessun link alla cliente, nessuna chiamata."""
        http = self.fake(self._routes())
        self._start()
        res = self.client.post(
            f"/api/sales/appointments/{self.appointment.id}/deposit-link", data="{}",
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 503)
        self.assertIn("non ancora attivi", res.json()["detail"])
        self.assertEqual(http.calls_to("/v1/checkout/sessions"), [])

    def test_the_return_from_stripe_reads_the_account(self):
        self.fake(self._routes(account=_account(details_submitted=True)))
        self._start()
        res = self.client.post(
            "/api/sales/stripe/connect/callback", data="{}", content_type="application/json", **self.owner_auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["state"], "pending")
        self.assertTrue(ActivityLog.objects.filter(salon=self.salon, summary__contains="in verifica").exists())

        # Stripe ha finito: il pannello lo vede anche senza webhook.
        self.fake(self._routes(account=_account(details_submitted=True, charges_enabled=True)))
        status = self._status()
        self.assertEqual(status["state"], "active")
        self.assertTrue(status["connected"])
        self.assertTrue(status["payments_enabled"])
        self.assertTrue(ActivityLog.objects.filter(salon=self.salon, summary__contains="attivo").exists())

    def test_account_updated_turns_payments_on_and_off(self):
        self.fake(self._routes())
        self._start()

        def updated(**state):
            return self.post_event(event_payload(
                "account.updated", _account(**state), account="acct_new", event_id=f"evt_{len(state)}",
            ))

        self.assertEqual(updated(details_submitted=True, charges_enabled=True).status_code, 200)
        self.assertTrue(self._settings().stripe_charges_enabled)
        log = ActivityLog.objects.get(salon=self.salon, type="settings.stripe_account_updated")
        self.assertEqual(log.payload["state"], "active")

        # Stripe sospende i pagamenti (documento scaduto, verifica): il portale
        # smette di mandare link che la cliente non potrebbe pagare.
        self.assertEqual(updated(details_submitted=True).status_code, 200)
        self.salon.refresh_from_db()
        from .. import stripe_service

        self.assertFalse(stripe_service.payments_enabled(self.salon))

    def test_an_account_event_about_another_account_changes_nothing(self):
        self.fake(self._routes())
        self._start()
        payload = event_payload(
            "account.updated", {**_account(charges_enabled=True), "id": "acct_altro"}, account="acct_new",
        )
        self.assertEqual(self.post_event(payload).status_code, 200)
        self.assertFalse(self._settings().stripe_charges_enabled)

    @override_settings(STRIPE_CONNECT_CLIENT_ID="ca_test")
    def test_an_existing_account_still_goes_through_oauth(self):
        res = self._start(body=json.dumps({"mode": "existing"}))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.json()["url"].startswith("https://connect.stripe.com/oauth/authorize?"))

    def test_without_the_client_id_an_existing_account_cannot_be_linked(self):
        res = self._start(body=json.dumps({"mode": "existing"}))
        self.assertEqual(res.status_code, 503)
