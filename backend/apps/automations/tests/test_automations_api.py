"""Automazioni dall'API: CRUD e attiva/disattiva con l'evento in outbox, il
webhook pubblico col suo token, l'elenco leggibile da tutto lo staff ma col
token solo a chi ha «marketing».

Caccia del 22/09:
- 18-07: attiva/disattiva e modifica non lavorano su copie vecchie.
Bug sospetti del 24/09:
- voce 26: creazione e modifica sotto il lock del salone, come l'eliminazione
  di un'etichetta citata nelle condizioni.
"""

import json
import uuid
from unittest.mock import patch

from django.db import transaction
from django.test import TestCase, TransactionTestCase

from apps.accounts.models import Membership, Role, User
from apps.core.models import OutboxEvent, Salon
from common.testing import bearer

from ..models import Automation


class AutomationsApiTests(TestCase):
    """CRUD + toggle su outbox; webhook con token valido/invalido."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user = User.objects.create_user(email="owner@the-parlour.test", password="pw12345!")
        self.role = Role.objects.create(salon=self.salon, name="Manager di prova", scopes=["marketing"])
        Membership.objects.create(
            user=self.user, salon=self.salon, role=self.role, is_owner=True
        )
        self.auth = bearer(self.user, self.salon)

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
        other_role = Role.objects.create(salon=self.salon, name="Front desk di prova", scopes=["agenda"])
        other_user = User.objects.create_user(email="frontdesk@the-parlour.test", password="pw12345!")
        Membership.objects.create(
            user=other_user, salon=self.salon, role=other_role, is_owner=False
        )
        auth = bearer(other_user, self.salon)
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
        auth = bearer(user, self.salon)

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
        return bearer(user, self.salon)

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
        self.auth = bearer(user, self.salon)
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


class AutomationLabelLockTests(TransactionTestCase):
    """Bug sospetti del 24/09, voce 26: l'automazione si salva sotto il lock del salone.

    L'eliminazione di un'etichetta controlla che nessuna automazione la citi e
    poi la cancella, sotto il lock del salone (`delete_label` in clients).
    Un'automazione che si salvava senza quel lock poteva essere a metà proprio
    allora: il controllo non la vedeva, e l'etichetta spariva lo stesso,
    lasciando una regola che a Yourang non scatta per nessuna. Su SQLite il
    lock non ferma nessuno: qui, se il salvataggio lo tiene, l'altra postazione
    aspetta la fine della sua transazione, come su PostgreSQL.
    `TransactionTestCase` perché la fine della transazione deve arrivare davvero.
    """

    def setUp(self):
        from apps.clients.models import ClientCategory

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = bearer(user, self.salon)
        self.label = ClientCategory.objects.create(salon=self.salon, name="A rischio")

    def _automation(self):
        return {
            "name": "Promemoria a rischio", "event": "appointment_upcoming",
            "conditions": {"op": "and", "rules": [{"field": "categories", "cmp": "contains", "value": "A rischio"}]},
        }

    def _send(self, method, path):
        return getattr(self.client, method)(
            path, data=json.dumps(self._automation()), content_type="application/json", **self.auth
        )

    def _while_the_label_is_deleted(self, save_the_automation):
        """Salva l'automazione mentre un'altra postazione elimina l'etichetta, nel momento della scrittura.

        Ritorna (risposta del salvataggio, risposta dell'eliminazione, il lock sostituito).
        """
        from apps.agenda.services import locking

        real_lock, real_save = locking.lock_salon, Automation.save
        state = {"held": False, "arrived": False}
        waiting, deleted = [], []

        def lock_salon(salon):
            state["held"] = True
            # Su PostgreSQL il lock resta fino alla fine della transazione.
            transaction.on_commit(lambda: state.update(held=False))
            return real_lock(salon)

        def delete_the_label():
            deleted.append(self.client.delete(f"/api/clients/categories/{self.label.id}", **self.auth))

        def save_while_the_label_is_deleted(automation, *args, **kwargs):
            if not state["arrived"]:
                state["arrived"] = True
                if state["held"]:
                    waiting.append(delete_the_label)  # aspetta il commit del salvataggio
                else:
                    delete_the_label()
            return real_save(automation, *args, **kwargs)

        with patch("apps.agenda.services.locking.lock_salon", side_effect=lock_salon) as lock, \
                patch.object(Automation, "save", autospec=True, side_effect=save_while_the_label_is_deleted):
            saved = save_the_automation()
            for station in waiting:
                station()
        self.assertTrue(state["arrived"])
        return saved, deleted[0], lock

    def assertLabelStays(self, saved, deleted, lock):
        from apps.clients.models import ClientCategory

        self.assertEqual(saved.status_code, 200, saved.content)
        self.assertEqual(deleted.status_code, 400, deleted.content)
        self.assertIn("Promemoria a rischio", deleted.json()["detail"])
        self.assertTrue(ClientCategory.objects.filter(pk=self.label.pk).exists())
        lock.assert_any_call(self.salon)

    def test_an_automation_being_created_is_seen_by_the_label_deletion(self):
        self.assertLabelStays(*self._while_the_label_is_deleted(lambda: self._send("post", "/api/automations/")))

    def test_an_automation_being_changed_to_cite_the_label_is_seen_too(self):
        automation = Automation.objects.create(salon=self.salon, name="Promemoria", event="appointment_upcoming")
        self.assertLabelStays(*self._while_the_label_is_deleted(
            lambda: self._send("put", f"/api/automations/{automation.pk}")
        ))

    def test_an_automation_deleted_meanwhile_is_a_404(self):
        # Salone, poi riga: l'automazione si rilegge dopo il lock. Salvata dalla
        # copia letta a inizio richiesta, quella eliminata nel frattempo da
        # un'altra postazione faceva 500 («did not affect any rows»).
        from apps.automations import api as automations_api

        automation = Automation.objects.create(salon=self.salon, name="Promemoria", event="appointment_upcoming")
        stale = Automation.objects.get(pk=automation.pk)  # letta a inizio richiesta
        automation.delete()  # poi un'altra postazione la elimina

        def stale_get(model, ctx, pk, **extra):
            return stale if model is Automation else model.objects.get(pk=pk)

        with patch.object(automations_api, "salon_get", side_effect=stale_get) as get:
            res = self._send("put", f"/api/automations/{stale.pk}")
        get.assert_called()
        self.assertEqual(res.status_code, 404, res.content)
        self.assertFalse(Automation.objects.filter(pk=stale.pk).exists())
