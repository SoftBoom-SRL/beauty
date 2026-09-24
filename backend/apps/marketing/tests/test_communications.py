"""Comunicazioni: destinatari e consenso marketing, programmazione, invio e annullamento.

Caccia del 22/09 — comunicazioni programmate: 07-02 (modifica/eliminazione non
fermavano l'invio già consegnato; le scadute non diventavano «inviate»), 07-03
(revoca del consenso dopo la programmazione), 07-14 (programmazione nel
passato), 18-07 (save completo su copia vecchia).
"""

import json
from datetime import timedelta
from importlib import import_module
from unittest.mock import patch

from django.apps import apps as django_apps
from django.test import TestCase
from django.utils import timezone

from apps.core.outbox import _due
from apps.core.models import OutboxEvent, Salon
from common.auth import create_client_tokens, create_staff_tokens

from ..communications import send_communication
from ..models import Communication
from .base import _make_client

SEND = "communication.send"
CANCEL = "communication.cancel"


# Come `_client` di base.py, ma con la lingua della cliente: le comunicazioni
# la passano a Yourang (`langs` nell'invio, `lang` nel consenso).
def _client(salon, first_name="Sofia", phone="+393331112233", lang="it"):
    from apps.clients.models import Client

    return Client.objects.create(
        salon=salon, first_name=first_name, last_name="Ricci", phone=phone, lang=lang,
        consents={"privacy": True, "marketing": True, "card_charge": False},
    )


class CommunicationTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_send_resolves_labels_and_marketing_consent(self):
        from apps.clients.models import ClientCategory  # lazy: app di un altro agente

        category = ClientCategory.objects.create(
            salon=self.salon, name="VIP", color="#F59E0B", order=0
        )
        with_consent = _make_client(self.salon, first_name="Sofia", phone="+393331112233")
        without_consent = _make_client(
            self.salon, first_name="Marta", phone="+393334445566", marketing=False
        )
        with_consent.categories.add(category)
        without_consent.categories.add(category)

        comm = Communication.objects.create(
            salon=self.salon,
            title="Promo estate",
            body="Sconto 20% su tutti i trattamenti viso",
            audience_type=Communication.AudienceType.LABELS,
            audience=[category.id],
        )
        send_communication(comm)

        comm.refresh_from_db()
        self.assertEqual(comm.status, Communication.Status.SENT)
        self.assertIsNotNone(comm.sent_at)

        event = OutboxEvent.objects.get(salon=self.salon, event_type="communication.send")
        self.assertEqual(event.payload["client_ids"], [with_consent.id])
        self.assertEqual(event.payload["langs"], {str(with_consent.id): with_consent.lang})
        self.assertNotIn("scheduled_at", event.payload)

    def test_send_scheduled_emits_event_immediately(self):
        client = _make_client(self.salon)
        when = timezone.now() + timedelta(days=2)
        comm = Communication.objects.create(
            salon=self.salon,
            title="Auguri",
            body="Buone feste!",
            audience_type=Communication.AudienceType.CLIENTS,
            audience=[client.id],
        )
        send_communication(comm, scheduled_at=when)

        comm.refresh_from_db()
        self.assertEqual(comm.status, Communication.Status.SCHEDULED)
        self.assertIsNone(comm.sent_at)

        event = OutboxEvent.objects.get(salon=self.salon, event_type="communication.send")
        self.assertEqual(event.payload["scheduled_at"], when.isoformat())
        self.assertEqual(event.payload["client_ids"], [client.id])


class MarketingConsentTests(TestCase):
    """GDPR art. 7.3: il consenso dev'essere revocabile come è stato dato."""

    def setUp(self):
        from common.auth import create_client_tokens

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = _make_client(self.salon, marketing=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.client_obj)['access']}"
        }

    def _set(self, accepted):
        return self.client.post(
            "/api/marketing/client/marketing-consent",
            data=json.dumps({"accepted": accepted}),
            content_type="application/json",
            **self.auth,
        )

    def test_revoking_excludes_the_client_from_the_next_send(self):
        comm = Communication.objects.create(
            salon=self.salon, title="Promo", body="…",
            audience_type=Communication.AudienceType.CLIENTS,
            audience=[self.client_obj.id],
        )
        self.assertEqual(self._set(False).status_code, 200)
        self.client_obj.refresh_from_db()
        self.assertFalse(self.client_obj.consents["marketing"])
        self.assertTrue(self.client_obj.consents["marketing_revoked_at"])

        send_communication(comm)
        event = OutboxEvent.objects.get(salon=self.salon, event_type="communication.send")
        self.assertEqual(event.payload["client_ids"], [])

    def test_the_consent_can_be_given_back(self):
        self._set(False)
        self.assertEqual(self._set(True).status_code, 200)
        self.client_obj.refresh_from_db()
        self.assertTrue(self.client_obj.consents["marketing"])
        self.assertNotIn("marketing_revoked_at", self.client_obj.consents)


class CommunicationScheduleTests(TestCase):
    """Una comunicazione programmata non si rinvia all'infinito, e modificarla o
    eliminarla ferma l'invio in coda."""

    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"
        }
        self.target = _make_client(self.salon)
        self.comm = Communication.objects.create(
            salon=self.salon, title="Promo estate", body="Sconto 20%",
            audience_type=Communication.AudienceType.CLIENTS,
            audience=[self.target.id],
        )

    def _send(self, body):
        return self.client.post(
            f"/api/marketing/communications/{self.comm.id}/send",
            data=json.dumps(body), content_type="application/json", **self.auth,
        )

    def _pending(self):
        # Gli invii annullati restano a registro come «superseded» (caccia del
        # 22/09): qui contano solo quelli che possono ancora partire.
        return OutboxEvent.objects.filter(
            salon=self.salon, event_type="communication.send"
        ).exclude(status=OutboxEvent.Status.SUPERSEDED).count()

    def test_a_scheduled_communication_cannot_be_sent_again(self):
        when = (timezone.now() + timedelta(days=2)).isoformat()
        self.assertEqual(self._send({"scheduled_at": when}).status_code, 200)
        self.assertEqual(self._pending(), 1)
        # Ogni rinvio accodava un invio in più: la stessa promozione arrivava
        # due, tre, dieci volte alla stessa cliente.
        again = self._send({"scheduled_at": when})
        self.assertEqual(again.status_code, 422, again.content)
        self.assertEqual(self._pending(), 1)

    def test_editing_a_scheduled_communication_cancels_the_queued_send(self):
        when = (timezone.now() + timedelta(days=2)).isoformat()
        self._send({"scheduled_at": when})
        self.assertEqual(self._pending(), 1)

        res = self.client.put(
            f"/api/marketing/communications/{self.comm.id}",
            data=json.dumps({
                "title": "Promo autunno", "body": "Sconto 30%",
                "audience_type": "clients", "audience": [self.target.id],
            }),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._pending(), 0)  # il vecchio testo non parte più
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.status, Communication.Status.DRAFT)
        # e ora si può riprogrammare, una volta sola
        self.assertEqual(self._send({"scheduled_at": when}).status_code, 200)
        self.assertEqual(self._pending(), 1)

    def test_deleting_a_communication_cancels_the_queued_send(self):
        when = (timezone.now() + timedelta(days=2)).isoformat()
        self._send({"scheduled_at": when})
        res = self.client.delete(
            f"/api/marketing/communications/{self.comm.id}", **self.auth
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._pending(), 0)

    def test_send_now_wins_over_a_saved_schedule(self):
        """`scheduled_at: null` esplicito = invia adesso, anche se a database
        c'è una data: prima il None veniva rimpiazzato dalla data salvata e
        «Invia subito» era impossibile via API."""
        self.comm.scheduled_at = timezone.now() + timedelta(days=5)
        self.comm.save(update_fields=["scheduled_at"])

        res = self._send({"scheduled_at": None})
        self.assertEqual(res.status_code, 200, res.content)
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.status, Communication.Status.SENT)

    def test_an_invented_audience_type_is_refused(self):
        """Un refuso su «labels» faceva leggere gli id etichetta come id cliente:
        la promozione per le VIP partiva a due persone a caso."""
        res = self.client.post(
            "/api/marketing/communications",
            data=json.dumps({
                "title": "Promo", "body": "…",
                "audience_type": "label", "audience": [1],
            }),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 422, res.content)


class _Base(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="anna@parlour.it", password="segretissima")
        Membership.objects.create(user=user, salon=self.salon, is_owner=True)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.sofia = _client(self.salon)
        self.marta = _client(self.salon, first_name="Marta", phone="+393334445566", lang="en")
        self.comm = Communication.objects.create(
            salon=self.salon, title="Promo estate", body="Testo con refuso",
            audience_type="clients", audience=[self.sofia.id, self.marta.id],
        )

    def _url(self, suffix=""):
        return f"/api/marketing/communications/{self.comm.id}{suffix}"

    def _schedule(self, when=None):
        when = when or timezone.now() + timedelta(days=3)
        res = self.client.post(self._url("/send"), data=json.dumps({"scheduled_at": when.isoformat()}),
                               content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        return when

    def _edit(self, **changes):
        body = {"title": "Promo estate", "body": "Testo corretto", "audience_type": "clients",
                "audience": [self.sofia.id, self.marta.id]}
        body.update(changes)
        return self.client.put(self._url(), data=json.dumps(body, default=str),
                               content_type="application/json", **self.auth)

    def _sends(self, **filters):
        return OutboxEvent.objects.filter(salon=self.salon, event_type=SEND, **filters)

    def _live_sends(self):
        return self._sends().exclude(status=OutboxEvent.Status.SUPERSEDED)

    def _cancels(self):
        return list(OutboxEvent.objects.filter(salon=self.salon, event_type=CANCEL).order_by("id"))

    def _deliver(self, event):
        """Come se il worker l'avesse consegnato (o con il codice di prima)."""
        OutboxEvent.objects.filter(pk=event.pk).update(
            status=OutboxEvent.Status.SENT, attempts=1, sent_at=timezone.now())


class HeldUntilTheDateTests(_Base):
    """07-02: la programmata resta in coda fino alla data, e lì si può fermare."""

    def test_a_scheduled_send_is_held_until_its_date(self):
        when = self._schedule()
        event = self._sends().get()
        self.assertEqual(event.status, OutboxEvent.Status.PENDING)
        self.assertGreaterEqual(event.next_attempt_at, when)
        self.assertEqual(event.payload["scheduled_at"], when.isoformat())
        # Il worker non lo vede: prende solo gli eventi scaduti (core.outbox._due).
        due = OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).filter(_due(timezone.now()))
        self.assertNotIn(event, due)
        self.assertIn(event, OutboxEvent.objects.filter(_due(when + timedelta(seconds=2))))

    def test_rescheduling_before_the_date_leaves_one_live_send_and_no_cancel(self):
        self._schedule()
        first = self._sends().get()
        self.assertEqual(self._edit().status_code, 200)
        first.refresh_from_db()
        self.assertEqual(first.status, OutboxEvent.Status.SUPERSEDED)
        self._schedule(timezone.now() + timedelta(days=4))
        live = list(self._live_sends())
        self.assertEqual(len(live), 1)
        self.assertEqual(live[0].payload["body"], "Testo corretto")
        self.assertEqual(self._cancels(), [])  # Yourang non aveva ricevuto niente

    def test_deleting_before_the_date_stops_the_send(self):
        self._schedule()
        res = self.client.delete(self._url(), **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._live_sends().count(), 0)
        self.assertEqual(self._cancels(), [])


class AlreadyDeliveredTests(_Base):
    """07-02: quello che Yourang ha già ricevuto si annulla con communication.cancel."""

    def test_editing_after_delivery_cancels_it_at_yourang_once(self):
        self._schedule()
        delivered = self._sends().get()
        self._deliver(delivered)
        self.assertEqual(self._edit().status_code, 200)
        cancels = self._cancels()
        self.assertEqual(len(cancels), 1)
        self.assertEqual(cancels[0].payload, {
            "communication_id": self.comm.id, "outbox_event_ids": [delivered.id],
            "scheduled_at": delivered.payload["scheduled_at"],
        })
        # Riprogrammata e rimodificata: l'invio vecchio non si annulla due volte.
        self._schedule()
        self.assertEqual(self._edit(body="Terza versione").status_code, 200)
        self.assertEqual(len(self._cancels()), 1)
        self.assertEqual(self._live_sends().exclude(pk=delivered.pk).count(), 0)

    def test_the_cancel_lives_until_the_campaign_date(self):
        """Revisione finale: con dodici ore dalla nascita l'annullamento di una
        campagna fra cinque giorni scadeva se la consegna restava ferma, e alla
        data Yourang mandava la campagna eliminata."""
        from apps.core.outbox import expire_stale

        when = self._schedule(timezone.now() + timedelta(days=5))
        self._deliver(self._sends().get())
        self.assertEqual(self.client.delete(self._url(), **self.auth).status_code, 200)
        cancel = self._cancels()[0]
        expire_stale(timezone.now() + timedelta(hours=13))
        cancel.refresh_from_db()
        self.assertEqual(cancel.status, OutboxEvent.Status.PENDING)
        expire_stale(when + timedelta(hours=13))
        cancel.refresh_from_db()
        self.assertEqual(cancel.status, OutboxEvent.Status.EXPIRED)

    def test_deleting_after_delivery_tells_yourang(self):
        self._schedule()
        delivered = self._sends().get()
        self._deliver(delivered)
        self.assertEqual(self.client.delete(self._url(), **self.auth).status_code, 200)
        self.assertEqual([c.payload["outbox_event_ids"] for c in self._cancels()], [[delivered.id]])

    def test_a_send_being_retried_is_stopped_and_cancelled(self):
        """Tentato e fallito (forse arrivato con la risposta persa): non si
        ritenta più, e Yourang riceve comunque l'annullamento."""
        self._schedule()
        retrying = self._sends().get()
        OutboxEvent.objects.filter(pk=retrying.pk).update(attempts=1, last_error="timeout")
        self.assertEqual(self._edit().status_code, 200)
        retrying.refresh_from_db()
        self.assertEqual(retrying.status, OutboxEvent.Status.SUPERSEDED)
        self.assertEqual([c.payload["outbox_event_ids"] for c in self._cancels()], [[retrying.id]])

    def test_deleting_an_immediate_send_from_history_cancels_nothing(self):
        res = self.client.post(self._url("/send"), data=json.dumps({"scheduled_at": None}),
                               content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self._deliver(self._sends().get())
        self.assertEqual(self.client.delete(self._url(), **self.auth).status_code, 200)
        self.assertEqual(self._cancels(), [])


class PastScheduleBecomesSentTests(_Base):
    """07-02: una programmata arrivata alla data è inviata, non più modificabile."""

    def setUp(self):
        super().setUp()
        self._schedule(timezone.now() + timedelta(hours=1))
        # Passa l'ora: la data programmata è ormai alle spalle.
        self.when = timezone.now() - timedelta(minutes=5)
        Communication.objects.filter(pk=self.comm.pk).update(scheduled_at=self.when)
        self.listing = self.client.get("/api/marketing/communications", **self.auth).json()

    def test_the_list_shows_it_as_sent_at_its_date(self):
        row = self.listing["items"][0]
        self.assertEqual(row["status"], "sent")
        self.assertIsNone(row["scheduled_at"])
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.sent_at, self.when)

    def test_it_can_no_longer_be_edited_or_sent_again(self):
        self.assertEqual(self._edit().status_code, 422)
        res = self.client.post(self._url("/send"), data=json.dumps({"scheduled_at": None}),
                               content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 422)
        self.assertEqual(self._live_sends().count(), 1)

    def test_a_due_schedule_is_refused_even_before_the_list_settles_it(self):
        """Fra la data e il prossimo elenco la modifica non deve fermare un invio in volo."""
        other = Communication.objects.create(
            salon=self.salon, title="Altra", body="…", audience_type="clients",
            audience=[self.sofia.id], status="scheduled",
            scheduled_at=timezone.now() - timedelta(minutes=1),
        )
        res = self.client.put(
            f"/api/marketing/communications/{other.id}",
            data=json.dumps({"title": "Altra", "body": "…", "audience_type": "clients",
                             "audience": [self.sofia.id]}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 422, res.content)


class NoScheduleInThePastTests(_Base):
    """07-14: non si programma nel passato."""

    def test_an_explicit_past_date_is_refused(self):
        past = (timezone.now() - timedelta(days=1)).isoformat()
        res = self.client.post(self._url("/send"), data=json.dumps({"scheduled_at": past}),
                               content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 422, res.content)
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.status, "draft")
        self.assertFalse(self._sends().exists())

    def test_an_old_saved_date_is_refused_too(self):
        Communication.objects.filter(pk=self.comm.pk).update(
            scheduled_at=timezone.now() - timedelta(days=2))
        res = self.client.post(self._url("/send"), data=json.dumps({}),
                               content_type="application/json", **self.auth)
        self.assertEqual(res.status_code, 422, res.content)
        self.assertFalse(self._sends().exists())


class RevocationAfterSchedulingTests(_Base):
    """07-03: la revoca del consenso vale anche per le campagne già programmate."""

    def _consent(self, client, accepted):
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(client)['access']}"}
        res = self.client.post("/api/marketing/client/marketing-consent",
                               data=json.dumps({"accepted": accepted}),
                               content_type="application/json", **auth)
        self.assertEqual(res.status_code, 200, res.content)

    def _consent_events(self):
        return [e.payload for e in OutboxEvent.objects.filter(
            salon=self.salon, event_type="client.marketing_consent").order_by("id")]

    def test_the_revoking_client_leaves_the_queued_send(self):
        self._schedule()
        self._consent(self.marta, False)
        event = self._sends().get()
        self.assertEqual(event.payload["client_ids"], [self.sofia.id])
        self.assertEqual(event.payload["langs"], {str(self.sofia.id): "it"})
        # e Yourang lo sa, per quello che avesse già in mano
        self.assertEqual(self._consent_events(), [{
            "client_id": self.marta.id, "phone": self.marta.phone, "lang": "en",
            "marketing": False,
        }])

    def test_a_send_waiting_for_a_retry_goes_without_her_too(self):
        """Il ritentativo ha la stessa Idempotency-Key: se il primo tentativo
        era arrivato Yourang lo scarta, se no parte senza di lei. E ha una data
        di creazione più vecchia dell'evento di revoca: il worker lo
        consegnerebbe per primo."""
        self._schedule()
        event = self._sends().get()
        OutboxEvent.objects.filter(pk=event.pk).update(attempts=1, last_error="timeout")
        self._consent(self.marta, False)
        event.refresh_from_db()
        self.assertEqual(event.payload["client_ids"], [self.sofia.id])
        self.assertEqual([p["marketing"] for p in self._consent_events()], [False])

    def test_a_send_already_delivered_is_left_to_the_opt_out_event(self):
        self._schedule()
        event = self._sends().get()
        self._deliver(event)
        self._consent(self.marta, False)
        event.refresh_from_db()
        self.assertIn(self.marta.id, event.payload["client_ids"])
        self.assertEqual([p["marketing"] for p in self._consent_events()], [False])

    def test_giving_the_consent_back_is_notified(self):
        self._consent(self.marta, False)
        self._consent(self.marta, True)
        self.assertEqual([p["marketing"] for p in self._consent_events()], [False, True])
        # confermare un consenso già dato non manda niente
        self._consent(self.marta, True)
        self.assertEqual(len(self._consent_events()), 2)


class UpdateWritesOnlyItsFieldsTests(_Base):
    """18-07: la modifica non riscrive i campi che la maschera non manda."""

    def test_an_image_set_meanwhile_survives_the_edit(self):
        from apps.marketing import api as marketing_api

        stale = Communication.objects.get(pk=self.comm.pk)  # letto a inizio PUT
        Communication.objects.filter(pk=self.comm.pk).update(image="communications/estate.png")

        def stale_get(model, ctx, pk, **extra):
            return stale if model is Communication else model.objects.get(pk=pk)

        with patch.object(marketing_api, "salon_get", stale_get):
            self.assertEqual(self._edit().status_code, 200)
        self.comm.refresh_from_db()
        self.assertEqual(self.comm.image.name, "communications/estate.png")
        self.assertEqual(self.comm.body, "Testo corretto")


class LegacyDeliveriesMigrationTests(_Base):
    """La migrazione 0005 annulla presso Yourang gli invii consegnati col codice vecchio."""

    def _legacy(self, comm_id, when=None, status="sent", attempts=1):
        payload = {"communication_id": comm_id, "client_ids": [self.sofia.id]}
        if when is not None:
            payload["scheduled_at"] = when.isoformat()
        return OutboxEvent.objects.create(salon=self.salon, event_type=SEND, payload=payload,
                                          status=status, attempts=attempts)

    def test_stale_deliveries_are_cancelled_and_the_current_one_is_kept(self):
        soon, later = timezone.now() + timedelta(days=2), timezone.now() + timedelta(days=3)
        deleted = self._legacy(999_999, soon)                        # campagna eliminata
        draft = Communication.objects.create(salon=self.salon, title="Bozza", body="…")
        edited = self._legacy(draft.id, soon)                        # modificata dopo
        retrying = self._legacy(draft.id, later, status="pending")   # in ritentativo
        live = Communication.objects.create(salon=self.salon, title="Viva", body="…",
                                            status="scheduled", scheduled_at=later)
        old_copy = self._legacy(live.id, soon)
        current = self._legacy(live.id, later)
        immediate = self._legacy(self.comm.id)                       # invio immediato: partito
        past = self._legacy(self.comm.id, timezone.now() - timedelta(days=1))

        import_module("apps.marketing.migrations.0005_caccia22_marketing_annulla_invii_superati") \
            .forwards(django_apps, None)

        cancelled = {c.payload["communication_id"]: c.payload["outbox_event_ids"]
                     for c in self._cancels()}
        self.assertEqual(cancelled, {
            999_999: [deleted.id],
            draft.id: [edited.id, retrying.id],
            live.id: [old_copy.id],
        })
        # ognuno vale fino all'invio più lontano che annulla
        dates = {c.payload["communication_id"]: c.payload["scheduled_at"] for c in self._cancels()}
        self.assertEqual(dates, {999_999: soon.isoformat(), draft.id: later.isoformat(), live.id: soon.isoformat()})
        retrying.refresh_from_db()
        self.assertEqual(retrying.status, OutboxEvent.Status.SUPERSEDED)
        for event in (current, immediate, past):
            event.refresh_from_db()
            self.assertEqual(event.status, OutboxEvent.Status.SENT)
