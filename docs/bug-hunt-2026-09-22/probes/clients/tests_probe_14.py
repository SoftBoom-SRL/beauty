"""Probe temporaneo del revisore 14 (da cancellare)."""

import json

from django.test import TestCase

from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Client


class StaleConsentsProbe(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="owner@theparlour.it", password="x")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.cl = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            consents={"privacy": True, "marketing": True, "card_charge": False,
                      "marketing_at": "2026-05-01T10:00:00+00:00"},
        )

    def test_profile_put_after_app_revocation_restores_marketing(self):
        # la scheda aperta in dashboard (GET) = stato «c» del componente
        stale = self.client.get(f"/api/clients/{self.cl.id}", **self.auth).json()
        # intanto la cliente revoca il consenso dall'app (stessa scrittura di
        # marketing.api.client_set_marketing_consent)
        c = Client.objects.get(pk=self.cl.pk)
        c.consents = {**c.consents, "marketing": False, "marketing_at": "",
                      "marketing_revoked_at": "2026-09-22T09:00:00+00:00"}
        c.save(update_fields=["consents"])
        # l'operatrice cambia la lingua: ClientProfile.updateClient → toClientIn(c, {lang:'en'})
        body = {
            "first_name": stale["first_name"], "last_name": stale["last_name"], "phone": stale["phone"],
            "email": stale["email"], "wa": stale["wa"], "lang": "en",
            "category_ids": [x["id"] for x in stale["categories"]], "reliability": stale["reliability"],
            "origin": stale["origin"], "gender": stale["gender"], "birthday": stale["birthday"],
            "since": stale["since"], "consents": dict(stale["consents"]),
            "whatsapp_reminders": stale["whatsapp_reminders"], "deposit_always": stale["deposit_always"],
            "is_active": stale["is_active"],
        }
        res = self.client.put(f"/api/clients/{self.cl.id}", json.dumps(body),
                              content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        c.refresh_from_db()
        print("\nPROBE consensi dopo la PUT della scheda:", c.consents)
        self.assertFalse(c.consents.get("marketing"))
