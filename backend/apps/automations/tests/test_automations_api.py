"""Automazioni dall'API: CRUD e attiva/disattiva con l'evento in outbox, il
webhook pubblico col suo token, l'elenco leggibile da tutto lo staff ma col
token solo a chi ha «marketing».

Caccia del 22/09:
- 18-07: attiva/disattiva e modifica non lavorano su copie vecchie.
"""

import json
import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.accounts.models import Membership, Role, User
from apps.core.models import OutboxEvent, Salon
from common.auth import create_staff_tokens

from ..models import Automation


class AutomationsApiTests(TestCase):
    """CRUD + toggle su outbox; webhook con token valido/invalido."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="owner@the-parlour.test", password="pw12345!")
        self.role = Role.objects.create(salon=self.salon, name="Manager", scopes=["marketing"])
        Membership.objects.create(
            user=self.user, salon=self.salon, role=self.role, is_owner=True
        )
        tokens = create_staff_tokens(self.user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def _post(self, path, payload=None):
        return self.client.post(
            path,
            data=json.dumps(payload or {}),
            content_type="application/json",
            **self.auth,
        )

    def _put(self, path, payload):
        return self.client.put(
            path, data=json.dumps(payload), content_type="application/json", **self.auth
        )

    def test_crud_and_toggle_emit_outbox_events(self):
        create_payload = {
            "name": "Promemoria appuntamento",
            "event": "appointment_upcoming",
            "offset_direction": "before",
            "offset_value": 2,
            "offset_unit": "hours",
        }
        resp = self._post("/api/automations/", create_payload)
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        automation_id = body["id"]
        self.assertTrue(body["active"])
        self.assertEqual(body["message_preview"], "")
        self.assertIn(str(Automation.objects.get(id=automation_id).webhook_token), body["webhook_url"])
        self.assertEqual(
            OutboxEvent.objects.filter(salon=self.salon, event_type="automation.updated").count(), 1
        )

        # update (PUT è sostituzione integrale)
        update_payload = dict(create_payload, name="Promemoria appuntamento (modificato)")
        resp = self._put(f"/api/automations/{automation_id}", update_payload)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["name"], update_payload["name"])
        self.assertEqual(
            OutboxEvent.objects.filter(salon=self.salon, event_type="automation.updated").count(), 2
        )

        # toggle
        resp = self.client.post(f"/api/automations/{automation_id}/toggle", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertFalse(resp.json()["active"])
        self.assertEqual(
            OutboxEvent.objects.filter(salon=self.salon, event_type="automation.updated").count(), 3
        )

        # list
        resp = self.client.get("/api/automations/", **self.auth)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()), 1)

        # delete
        resp = self.client.delete(f"/api/automations/{automation_id}", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertFalse(Automation.objects.filter(id=automation_id).exists())
        self.assertEqual(
            OutboxEvent.objects.filter(salon=self.salon, event_type="automation.updated").count(), 4
        )
        # 18-05: stessa chiave per tutte le versioni, così partono in ordine
        self.assertEqual(
            set(
                OutboxEvent.objects.filter(salon=self.salon, event_type="automation.updated")
                .values_list("coalesce_key", flat=True)
            ),
            {f"automation:{automation_id}"},
        )

    def test_write_requires_marketing_scope(self):
        other_role = Role.objects.create(salon=self.salon, name="Front desk", scopes=["agenda"])
        other_user = User.objects.create_user(email="frontdesk@the-parlour.test", password="pw12345!")
        Membership.objects.create(
            user=other_user, salon=self.salon, role=other_role, is_owner=False
        )
        tokens = create_staff_tokens(other_user, self.salon)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}
        resp = self.client.post(
            "/api/automations/",
            data=json.dumps({"name": "X", "event": "birthday"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(resp.status_code, 403)

    def test_events_catalog(self):
        resp = self.client.get("/api/automations/events-catalog", **self.auth)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        # Il catalogo proposto dal costruttore è quello del modello: due elenchi
        # separati lasciavano l'interfaccia a proporre valori che l'API rifiuta.
        self.assertEqual(
            [e["value"] for e in data["events"]], list(Automation.Event.values)
        )
        self.assertTrue(all(e["label_en"] for e in data["events"]))
        self.assertTrue(any(o["value"] == "contains" for o in data["operators"]))
        self.assertTrue(any(f["value"] == "reliability" for f in data["fields"]))

    def test_unknown_enums_and_out_of_scale_offsets_are_refused(self):
        # event="birtday" veniva salvato e spedito a Yourang: in dashboard la
        # regola risultava attiva e non partiva mai un messaggio.
        base = {"name": "Promemoria", "event": "appointment_upcoming"}
        for payload in (
            dict(base, event="birtday"),
            dict(base, offset_direction="prima"),
            dict(base, offset_unit="settimane"),
            dict(base, trigger_origin="chissa"),
            dict(base, offset_value=-2),
            dict(base, offset_value=10**9),
            dict(base, name="   "),
        ):
            with self.subTest(payload=payload):
                self.assertEqual(self._post("/api/automations/", payload).status_code, 400, payload)
        self.assertFalse(Automation.objects.exists())

    def test_the_same_validation_applies_on_update(self):
        created = self._post("/api/automations/", {"name": "Ok", "event": "birthday"}).json()
        resp = self._put(f"/api/automations/{created['id']}", {"name": "Ok", "event": "birtday"})
        self.assertEqual(resp.status_code, 400, resp.content)
        self.assertEqual(Automation.objects.get(pk=created["id"]).event, "birthday")

    def test_the_list_is_readable_by_staff_but_the_token_is_not(self):
        """Prima questo test pretendeva un 403 sull'intera lettura.

        Era sbagliato: negare l'elenco spegneva la sezione Automazioni per Front
        desk e Operatrice, i due ruoli predefiniti senza «marketing», che fino a
        quel momento la consultavano. Il segreto da proteggere e il token del
        webhook pubblico, non la pagina.
        """
        user = User.objects.create_user(email="ops@the-parlour.test", password="pw12345!")
        role = Role.objects.create(salon=self.salon, name="Solo agenda", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=False)
        tokens = create_staff_tokens(user, self.salon)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

        Automation.objects.create(
            salon=self.salon, name="Promemoria", event="appointment_upcoming"
        )
        resp = self.client.get("/api/automations/", **auth)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()[0]["webhook_token"], "")
        # Scrivere resta vietato senza «marketing»: la POST qui sotto usa il
        # token dell'utente con la sola agenda, non quello del titolare.
        scrittura = self.client.post(
            "/api/automations/",
            data=json.dumps({"name": "X", "event": "appointment_upcoming"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(scrittura.status_code, 403)

    def test_a_disabled_automation_does_not_start_from_the_webhook(self):
        # Spegnerla dalla dashboard deve spegnerla davvero, anche per chi ha il token.
        automation = Automation.objects.create(
            salon=self.salon, name="Spenta", event="no_show", active=False,
            trigger_origin=Automation.TriggerOrigin.WEBHOOK,
        )
        resp = self.client.post(f"/api/automations/hook/{automation.webhook_token}")
        self.assertEqual(resp.status_code, 409, resp.content)
        self.assertFalse(
            OutboxEvent.objects.filter(salon=self.salon, event_type="automation.triggered").exists()
        )

    def test_webhook_valid_token_emits_and_logs(self):
        automation = Automation.objects.create(
            salon=self.salon,
            name="Automazione via webhook",
            event="no_show",
            trigger_origin=Automation.TriggerOrigin.WEBHOOK,
        )
        resp = self.client.post(
            f"/api/automations/hook/{automation.webhook_token}",
            data=json.dumps({"client_id": 42}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["automation_id"], automation.id)
        self.assertEqual(
            OutboxEvent.objects.filter(
                salon=self.salon, event_type="automation.triggered"
            ).count(),
            1,
        )
        event = OutboxEvent.objects.get(salon=self.salon, event_type="automation.triggered")
        self.assertEqual(event.payload["automation_id"], automation.id)
        self.assertEqual(event.payload["payload"], {"client_id": 42})

    def test_webhook_unknown_token_returns_404(self):
        resp = self.client.post(f"/api/automations/hook/{uuid.uuid4()}")
        self.assertEqual(resp.status_code, 404)

    def test_webhook_malformed_token_returns_404(self):
        resp = self.client.post("/api/automations/hook/not-a-valid-uuid")
        self.assertEqual(resp.status_code, 404)


class AutomationsReadableWithoutMarketingTests(TestCase):
    """L'elenco resta leggibile a tutto lo staff, il token no.

    Chiudere la lettura dietro il permesso «marketing» spegneva la sezione
    Automazioni per due dei tre ruoli predefiniti (Front desk e Operatrice non
    ce l'hanno) che fino a ieri la consultavano. Il dato da proteggere è il
    webhook_token: con quello si fa partire la sequenza di messaggi verso le
    clienti senza autenticarsi, e non si rigenera mai.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.automation = Automation.objects.create(
            salon=self.salon, name="Promemoria", event="appointment_upcoming"
        )

    def _auth_for(self, scopes, *, is_owner=False, email="x@the-parlour.test"):
        user = User.objects.create_user(email=email, password="pw12345!")
        role = Role.objects.create(salon=self.salon, name=f"Ruolo {email}", scopes=scopes)
        Membership.objects.create(
            user=user, salon=self.salon, role=role, is_owner=is_owner
        )
        tokens = create_staff_tokens(user, self.salon)
        return {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def test_front_desk_still_reads_the_list(self):
        auth = self._auth_for(["agenda", "clients", "sales"], email="fd@the-parlour.test")
        resp = self.client.get("/api/automations/", **auth)
        self.assertEqual(resp.status_code, 200)
        rows = resp.json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["name"], "Promemoria")

    def test_the_token_is_hidden_without_marketing(self):
        auth = self._auth_for(["agenda", "clients"], email="op@the-parlour.test")
        rows = self.client.get("/api/automations/", **auth).json()
        self.assertEqual(rows[0]["webhook_token"], "")
        # L'indirizzo contiene il token: nasconderne uno solo non servirebbe.
        self.assertEqual(rows[0]["webhook_url"], "")

    def test_marketing_and_owner_still_see_the_token(self):
        auth = self._auth_for(["marketing"], email="mk@the-parlour.test")
        rows = self.client.get("/api/automations/", **auth).json()
        self.assertEqual(rows[0]["webhook_token"], str(self.automation.webhook_token))
        self.assertIn(str(self.automation.webhook_token), rows[0]["webhook_url"])

        owner = self._auth_for([], is_owner=True, email="ow@the-parlour.test")
        rows = self.client.get("/api/automations/", **owner).json()
        self.assertEqual(rows[0]["webhook_token"], str(self.automation.webhook_token))


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
