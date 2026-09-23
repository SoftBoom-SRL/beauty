"""Caccia del 22/09 — 18-07: attiva/disattiva e modifica non lavorano su copie vecchie."""

import json
from unittest.mock import patch

from django.test import TestCase

from apps.core.models import OutboxEvent, Salon
from common.auth import create_staff_tokens

from .models import Automation


class StaleCopyTests(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.automation = Automation.objects.create(
            salon=self.salon, name="Auguri", event="birthday", active=True
        )
        # Copia letta a inizio richiesta, prima che un'altra postazione cambiasse la riga.
        self.stale = Automation.objects.get(pk=self.automation.pk)

    def _stale_salon_get(self):
        from apps.automations import api as automations_api

        stale = self.stale

        def fake(model, ctx, pk, **extra):
            return stale if model is Automation else model.objects.get(pk=pk)

        return patch.object(automations_api, "salon_get", fake)

    def test_the_toggle_flips_the_current_state_not_the_stale_one(self):
        # Un'altra postazione l'ha appena spenta; questo clic la riaccende.
        Automation.objects.filter(pk=self.automation.pk).update(active=False)
        with self._stale_salon_get():
            res = self.client.post(f"/api/automations/{self.automation.pk}/toggle", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.automation.refresh_from_db()
        self.assertTrue(self.automation.active)
        self.assertTrue(res.json()["active"])
        # e a Yourang arriva lo stato vero
        event = OutboxEvent.objects.filter(salon=self.salon, event_type="automation.updated").last()
        self.assertTrue(event.payload["active"])

    def test_an_edit_does_not_overwrite_the_preview_synced_meanwhile(self):
        Automation.objects.filter(pk=self.automation.pk).update(
            message_preview="Tanti auguri da The Parlour!")
        with self._stale_salon_get():
            res = self.client.put(
                f"/api/automations/{self.automation.pk}",
                data=json.dumps({"name": "Auguri di compleanno", "event": "birthday"}),
                content_type="application/json", **self.auth,
            )
        self.assertEqual(res.status_code, 200, res.content)
        self.automation.refresh_from_db()
        self.assertEqual(self.automation.name, "Auguri di compleanno")
        self.assertEqual(self.automation.message_preview, "Tanti auguri da The Parlour!")
