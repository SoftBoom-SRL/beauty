"""Registro attività, feed live della dashboard (polling) e stream SSE.

In testa i fondamentali del core (CoreTests): log_activity ed emit_event, i
valori predefiniti delle impostazioni, il valutatore delle condizioni.
"""

import datetime as dt
import json
from unittest.mock import patch

from django.test import TestCase, override_settings
from django.utils import timezone

from common.auth import create_staff_tokens
from common.conditions import evaluate

from .. import views
from ..models import ActivityLog, Salon, SalonSettings
from ..services import emit_event, log_activity
from .base import _owner


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


# ---------------------------------------------------------------------------
# Caccia ai bug del 22/09, 08-16: le date del registro attività.
# ---------------------------------------------------------------------------


class ActivityLogDatesTests(TestCase):
    """08-16: una data ben scritta ma inesistente era un 500."""

    def setUp(self):
        self.salon = Salon.objects.create(name="S", slug="s")
        self.auth = _owner(self.salon)
        self.client.raise_request_exception = False
        log_activity(self.salon, "appointment.created", "Oggi")

    def test_impossible_or_malformed_dates_are_a_400(self):
        for query in (
            "date_from=2026-02-30", "date_to=2026-13-01", "date_from=ieri", "date_to=0000-01-01",
        ):
            with self.subTest(query=query):
                resp = self.client.get(f"/api/core/activity?{query}", **self.auth)
                self.assertEqual(resp.status_code, 400)

    def test_valid_dates_still_filter(self):
        resp = self.client.get("/api/core/activity?date_from=2000-01-01&date_to=2999-12-31", **self.auth)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual([row["summary"] for row in resp.json()["items"]], ["Oggi"])
        resp = self.client.get("/api/core/activity?date_to=2000-01-01", **self.auth)
        self.assertEqual(resp.json()["items"], [])


# ---------------------------------------------------------------------------
# Feed live e stream SSE: biglietto monouso, permessi riletti, keep-alive,
# eventi committati fuori ordine.
#
# Caccia ai bug del 22/09: 08-11 + 10-12, 08-12, 08-13 + 18-10 (contratto C20).
# ---------------------------------------------------------------------------


def _frames_events(frames):
    """Eventi consegnati, frame per frame."""
    out = []
    for frame in frames:
        if "event: events" in frame:
            out.append(json.loads(frame.split("data: ", 1)[1])["events"])
    return out


class _Member(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User

        self.salon = Salon.objects.create(name="S", slug="s")
        self.user = User.objects.create_user(email="mara@x.it", password="pw-lunga-123")
        self.role = Role.objects.create(salon=self.salon, name="Reception", scopes=["agenda", "sales"])
        self.membership = Membership.objects.create(user=self.user, salon=self.salon, role=self.role)

    def _auth(self):
        tokens = create_staff_tokens(self.user, self.salon)
        return {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

    def _ticket(self):
        res = self.client.post("/api/core/activity/stream-ticket", **self._auth())
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()["ticket"]

    def _stream(self, ticket, after=None):
        url = f"/api/core/activity/stream?ticket={ticket}" + (f"&after={after}" if after else "")
        return self.client.get(url)


class StreamTicketTests(_Member):
    """08-11 + 10-12: il biglietto era riusabile per 10 minuti e con permessi congelati."""

    def test_a_ticket_opens_one_stream_only(self):
        ticket = self._ticket()
        with patch.object(views, "STREAM_MAX_SECONDS", 0):
            first = self._stream(ticket)
            self.assertEqual(first.status_code, 200)
            b"".join(first.streaming_content)
            again = self._stream(ticket)
        self.assertEqual(again.status_code, 403)

    def test_removal_from_the_salon_invalidates_the_ticket(self):
        ticket = self._ticket()
        self.membership.delete()
        self.assertEqual(self._stream(ticket).status_code, 403)

    def test_a_password_change_invalidates_the_ticket(self):
        ticket = self._ticket()
        self.user.set_password("nuova-password-456")
        self.user.save(update_fields=["password", "token_version"])
        self.assertEqual(self._stream(ticket).status_code, 403)

    def test_a_deactivated_user_cannot_open_the_stream(self):
        ticket = self._ticket()
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.assertEqual(self._stream(ticket).status_code, 403)

    def test_the_stream_uses_the_permissions_of_now(self):
        ticket = self._ticket()
        # dopo il biglietto la titolare le toglie la cassa
        self.role.scopes = ["agenda"]
        self.role.save(update_fields=["scopes"])
        before = log_activity(self.salon, "appointment.created", "Punto di partenza")
        log_activity(self.salon, "sale.created", "Incasso € 80")
        log_activity(self.salon, "appointment.moved", "Spostato")
        with patch.object(views, "STREAM_MAX_SECONDS", 0.05):
            stream = self._stream(ticket, after=before.id)
            self.assertEqual(stream.status_code, 200)
            body = b"".join(stream.streaming_content).decode()
        self.assertIn("appointment.moved", body)
        self.assertNotIn("sale.created", body)

    def test_an_open_stream_stops_soon_after_the_removal(self):
        ticket = self._ticket()
        with patch.object(views, "STREAM_MAX_SECONDS", 5), patch.object(views, "STREAM_ACCESS_CHECK_SECONDS", 0):
            stream = self._stream(ticket)
            frames = iter(stream.streaming_content)
            self.assertIn(b"event: ready", next(frames))
            self.membership.delete()
            log_activity(self.salon, "appointment.created", "Dopo la rimozione")
            rest = b"".join(frames).decode()
        self.assertIn("event: bye", rest)
        self.assertNotIn("Dopo la rimozione", rest)

    def test_a_permission_removed_mid_stream_stops_those_events(self):
        start = log_activity(self.salon, "appointment.created", "Partenza")
        log_activity(self.salon, "sale.created", "Incasso")
        log_activity(self.salon, "appointment.moved", "Spostato")
        with patch.object(views, "STREAM_ACCESS_CHECK_SECONDS", 0):
            frames = list(
                views.event_generator(
                    self.salon.id, start.id, scopes=["agenda", "sales"], max_seconds=0.05, poll=0,
                    access_check=lambda: (False, ["agenda"]),
                )
            )
        delivered = [e["type"] for batch in _frames_events(frames) for e in batch]
        self.assertEqual(delivered, ["appointment.moved"])


class KeepaliveTests(TestCase):
    """08-12: gli eventi invisibili a chi ascolta sopprimevano il keep-alive."""

    def test_a_ping_is_sent_even_while_invisible_events_keep_coming(self):
        salon = Salon.objects.create(name="S", slug="s")
        log_activity(salon, "appointment.created", "base")
        real_sleep = views.time.sleep

        def busy_sleep(seconds):
            # a ogni giro arriva una vendita, che un'operatrice «solo agenda» non vede
            log_activity(salon, "sale.created", "Vendita € 50")
            real_sleep(0.005)

        with patch.object(views, "STREAM_KEEPALIVE_SECONDS", 0.05), patch.object(views.time, "sleep", busy_sleep):
            frames = list(views.event_generator(salon.id, 0, scopes=["agenda"], max_seconds=0.4, poll=0.01))
        self.assertTrue(any(f.startswith(": ping") for f in frames))
        self.assertEqual(_frames_events(frames), [])


class LateCommitTests(_Member):
    """08-13 + 18-10: un evento con id più basso committato dopo uno più alto."""

    def _late_event(self, event_id, type_="appointment.created", age_seconds=0):
        event = ActivityLog.objects.create(id=event_id, salon=self.salon, type=type_, summary=f"late {event_id}")
        if age_seconds:
            ActivityLog.objects.filter(pk=event.pk).update(
                created_at=timezone.now() - dt.timedelta(seconds=age_seconds)
            )
        return event

    def test_the_stream_delivers_an_event_that_shows_up_below_the_cursor(self):
        ActivityLog.objects.create(id=1000, salon=self.salon, type="appointment.created", summary="dopo")
        real_sleep = views.time.sleep
        calls = []

        def commit_late(seconds):
            if not calls:
                # la transazione con l'id 999 committa solo adesso
                self._late_event(999)
                self._late_event(998, age_seconds=120)  # fuori finestra: resta perso
            calls.append(seconds)
            real_sleep(0)

        with patch.object(views.time, "sleep", commit_late):
            frames = list(views.event_generator(self.salon.id, 0, scopes=["agenda"], max_seconds=0.2, poll=0))
        delivered = [e["id"] for batch in _frames_events(frames) for e in batch]
        # consegnato una volta sola, anche se resta nella finestra per altri giri
        self.assertEqual(delivered, [999])
        self.assertIn('"cursor": 1000', frames[0])

    def test_a_fresh_stream_does_not_replay_the_window(self):
        log_activity(self.salon, "appointment.created", "appena prima di aprire")
        frames = list(views.event_generator(self.salon.id, 0, scopes=["agenda"], max_seconds=0.05, poll=0))
        self.assertEqual(_frames_events(frames), [])

    def test_polling_delivers_it_too(self):
        ActivityLog.objects.create(id=1000, salon=self.salon, type="appointment.created", summary="dopo")
        self._late_event(999)
        self._late_event(997, type_="sale.created")
        self._late_event(998, age_seconds=120)
        auth = self._auth()
        # un'operatrice con la sola agenda: il filtro per area vale anche qui
        self.role.scopes = ["agenda"]
        self.role.save(update_fields=["scopes"])
        data = self.client.get("/api/core/activity/feed?after=1000", **auth).json()
        self.assertEqual([e["id"] for e in data["events"]], [999])
        self.assertEqual(data["cursor"], 1000)
