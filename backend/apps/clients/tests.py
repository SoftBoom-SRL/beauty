"""Test essenziali: import CSV (upsert), client_facts su dati minimi (sales/agenda
non ancora pronte → degrado a 0/[] senza eccezioni), immutabilità delle schede
tecniche (nessuna rotta di update/delete registrata sul router).

Le view sono chiamate direttamente (bypassando l'HTTP layer): usano solo
`request.auth`, quindi basta un `SimpleNamespace` con uno `StaffContext`
costruito a mano — evita di dipendere dal login reale di apps.accounts.
"""

import datetime as dt
import json
import shutil
import tempfile
from decimal import Decimal
from types import SimpleNamespace

from django.conf import settings
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import ActivityLog, Salon, SalonSettings
from common.auth import StaffContext, create_staff_tokens

from .api import (
    create_category,
    create_client,
    create_note,
    create_sheet,
    delete_client,
    delete_note,
    get_client,
    import_clients,
    list_client_appointments,
    list_clients,
    list_notes,
    list_sheets,
    router,
    update_client,
)
from .models import Client, ClientCategory, ClientNote, ClientNoteAttachment, TechnicalSheet
from .schemas import CategoryIn, ClientIn, ImportIn, ImportRowIn, NoteIn, TechnicalSheetIn
from .services import client_facts, client_stats, import_rows


class ClientsTestCase(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        ctx = StaffContext(
            user=None, salon=self.salon, membership=None, scopes={"clients"}, is_owner=False
        )
        self.request = SimpleNamespace(auth=ctx)

    def make_client(self, **kwargs):
        defaults = dict(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+391110000000")
        defaults.update(kwargs)
        return Client.objects.create(**defaults)


class ClientCrudTests(ClientsTestCase):
    def test_create_and_update_client(self):
        data = ClientIn(first_name="Giulia", last_name="Bianchi", phone="+393331112222")
        client = create_client(self.request, data)
        self.assertEqual(client.full_name, "Giulia Bianchi")
        self.assertTrue(Client.objects.filter(id=client.id, salon=self.salon).exists())

        update_data = ClientIn(first_name="Giulia", last_name="Verdi", phone="+393331112222")
        updated = update_client(self.request, client.id, update_data)
        self.assertEqual(updated.last_name, "Verdi")

    def test_duplicate_phone_rejected_on_create(self):
        self.make_client(phone="+393339990000")
        data = ClientIn(first_name="Altra", last_name="Persona", phone="+393339990000")
        with self.assertRaises(HttpError) as exc:
            create_client(self.request, data)
        self.assertEqual(exc.exception.status_code, 400)

    def test_since_is_filled_at_creation(self):
        """Senza `since` il KPI «nuovi clienti» resta a zero per sempre."""
        client = create_client(
            self.request, ClientIn(first_name="Giada", phone="+393334445555")
        )
        self.assertEqual(client.since, timezone.localdate())

    def test_given_since_is_kept(self):
        """Chi importa uno storico dice da quando è cliente: non si sovrascrive."""
        client = create_client(
            self.request,
            ClientIn(first_name="Giada", phone="+393334446666", since=dt.date(2019, 5, 2)),
        )
        self.assertEqual(client.since, dt.date(2019, 5, 2))

    def test_the_database_refuses_two_cards_for_the_same_number(self):
        """L'identità è phone_key, non la stringa digitata.

        Il vincolo su (salone, telefono) guardava il testo: «+39 333 000 1111»
        e «+393330001111» erano due schede per la stessa persona, con storico,
        affidabilità e caparre spaccati a metà.
        """
        from django.db import IntegrityError, transaction

        self.make_client(phone="+393330001111")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.make_client(phone="+39 333 000 1111", first_name="Doppia")

    def test_a_concurrent_duplicate_answers_400_not_500(self):
        """Il controllo di unicità non è atomico: a fermare la seconda scheda è
        il vincolo del database, e la violazione deve uscire come 400."""
        from unittest.mock import patch

        self.make_client(phone="+393337778888")
        data = ClientIn(first_name="Altra", phone="+39 333 777 8888")
        # find_client_by_phone cieco = le due richieste simultanee che superano
        # entrambe il controllo e arrivano insieme alla INSERT.
        with patch("apps.clients.api.find_client_by_phone", return_value=None):
            with self.assertRaises(HttpError) as exc:
                create_client(self.request, data)
        self.assertEqual(exc.exception.status_code, 400)


class ClientPartialUpdateTests(ClientsTestCase):
    """Il PUT applica solo i campi presenti nel corpo.

    `ClientIn` ha un default per quasi tutto: riversarlo intero su una scheda
    esistente cancellava i consensi (con la prova del consenso privacy),
    riportava l'affidabilità a 100 e riattivava le schede disattivate.
    """

    def test_a_partial_put_does_not_wipe_consents_and_reliability(self):
        client = self.make_client(
            phone="+393332221111",
            reliability=42,
            consents={"privacy": True, "privacy_at": "2026-01-02T10:00:00", "marketing": True},
        )
        update_client(
            self.request,
            client.id,
            ClientIn(first_name="Sofia", last_name="Neri", phone="+393332221111"),
        )
        client.refresh_from_db()
        self.assertEqual(client.last_name, "Neri")
        self.assertEqual(client.reliability, 42)
        self.assertTrue(client.consents["privacy"])
        self.assertEqual(client.consents["privacy_at"], "2026-01-02T10:00:00")
        self.assertTrue(client.consents["marketing"])

    def test_a_partial_put_does_not_reactivate_a_disabled_card(self):
        client = self.make_client(phone="+393332223333", is_active=False)
        update_client(self.request, client.id, ClientIn(first_name="Sofia", phone="+393332223333"))
        client.refresh_from_db()
        self.assertFalse(client.is_active)

    def test_what_is_in_the_body_is_applied(self):
        client = self.make_client(phone="+393332224444", reliability=100)
        update_client(
            self.request,
            client.id,
            ClientIn(first_name="Sofia", phone="+393332224444", reliability=30, is_active=False),
        )
        client.refresh_from_db()
        self.assertEqual(client.reliability, 30)
        self.assertFalse(client.is_active)

    def test_categories_are_left_alone_when_the_body_omits_them(self):
        client = self.make_client(phone="+393332225555")
        vip = ClientCategory.objects.create(salon=self.salon, name="VIP")
        client.categories.add(vip)
        update_client(self.request, client.id, ClientIn(first_name="Sofia", phone="+393332225555"))
        self.assertEqual(list(client.categories.all()), [vip])

    def test_stripe_identifiers_are_not_writable_from_the_client(self):
        """Copiare gli identificativi Stripe di un'altra cliente su questa
        scheda permetteva di addebitare un no-show sulla carta di lei."""
        client = self.make_client(phone="+393332226666")
        data = ClientIn.model_validate(
            {
                "first_name": "Sofia",
                "phone": "+393332226666",
                "stripe_customer_id": "cus_di_un_altra",
                "stripe_payment_method_id": "pm_di_un_altra",
            }
        )
        self.assertFalse(hasattr(data, "stripe_customer_id"))
        update_client(self.request, client.id, data)
        client.refresh_from_db()
        self.assertEqual(client.stripe_customer_id, "")
        self.assertEqual(client.stripe_payment_method_id, "")

    def test_soft_delete_sets_is_active_false_and_logs(self):
        client = self.make_client()
        delete_client(self.request, client.id)
        client.refresh_from_db()
        self.assertFalse(client.is_active)
        self.assertTrue(ActivityLog.objects.filter(type="client.deleted").exists())

    def test_detail_has_zeroed_computed_fields_without_sales_app(self):
        client = self.make_client()
        detail = get_client(self.request, client.id)
        self.assertEqual(detail.visits, 0)
        self.assertEqual(detail.total_spent, Decimal("0"))
        self.assertIsNone(detail.last_visit)


class ClientListTests(ClientsTestCase):
    def test_list_filters_by_query(self):
        self.make_client(first_name="Sofia", last_name="Ricci", phone="+391110001111")
        self.make_client(first_name="Elena", last_name="Conti", phone="+391110002222")
        result = list_clients(self.request, q="Sofia")
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["items"][0].first_name, "Sofia")

    def test_search_finds_the_full_name(self):
        """«Sofia Ricci» non stava in nessuna colonna: il filtro campo per
        campo non trovava nulla e si creava un doppione."""
        self.make_client(first_name="Sofia", last_name="Ricci", phone="+391110001111")
        self.make_client(first_name="Sofia", last_name="Conti", phone="+391110002222")
        result = list_clients(self.request, q="Sofia Ricci")
        self.assertEqual([c.last_name for c in result["items"]], ["Ricci"])

    def test_search_finds_a_formatted_phone_number(self):
        """In archivio il numero è E.164 senza separatori, sulla scheda si legge
        formattato: copiarlo dalla scheda nella ricerca non trovava nessuno."""
        client = self.make_client(phone="+393331234567")
        for written in ("+39 333 123 4567", "333 123 4567", "3331234567"):
            result = list_clients(self.request, q=written)
            self.assertEqual([c.id for c in result["items"]], [client.id], written)

    def test_list_filters_by_is_active(self):
        active = self.make_client(phone="+391110003333")
        inactive = self.make_client(phone="+391110004444", is_active=False)
        result = list_clients(self.request, is_active=True)
        ids = [c.id for c in result["items"]]
        self.assertIn(active.id, ids)
        self.assertNotIn(inactive.id, ids)


class ClientFactsTests(ClientsTestCase):
    """client_facts deve degradare a 0/[] senza eccezioni quando sales/agenda
    non sono installate (come in questo ambiente di sviluppo/test)."""

    def test_client_facts_minimal_data_no_exceptions(self):
        client = self.make_client(reliability=80, deposit_always=True)
        facts = client_facts(client)
        self.assertEqual(
            facts,
            {
                "reliability": 80,
                "categories": [],
                "total_spent": Decimal("0"),
                "visits": 0,
                "noshow_count": 0,
                "latecancel_count": 0,
                "deposit_always": True,
            },
        )

    def test_client_facts_includes_category_names(self):
        client = self.make_client()
        cat = ClientCategory.objects.create(salon=self.salon, name="VIP")
        client.categories.add(cat)
        facts = client_facts(client)
        self.assertEqual(facts["categories"], ["VIP"])

    def test_client_stats_degrades_to_zero_without_sales_app(self):
        client = self.make_client()
        stats = client_stats(client)
        self.assertEqual(stats, {"visits": 0, "total_spent": Decimal("0"), "last_visit": None})


class ImportUpsertTests(ClientsTestCase):
    def test_import_creates_and_updates(self):
        existing = self.make_client(phone="+393330001111", first_name="Old", last_name="Name")
        rows = [
            {"first_name": "New", "last_name": "Name", "phone": "+393330001111", "email": ""},
            {"first_name": "Fresh", "last_name": "Client", "phone": "+393339998888", "email": ""},
        ]
        result = import_rows(self.salon, rows)
        self.assertEqual((result["created"], result["updated"]), (1, 1))
        existing.refresh_from_db()
        self.assertEqual(existing.first_name, "New")
        self.assertTrue(Client.objects.filter(salon=self.salon, phone="+393339998888").exists())

    def test_import_matches_by_email_when_no_phone_match(self):
        existing = self.make_client(phone="+393330005555", email="giulia@example.com")
        result = import_rows(
            self.salon, [{"first_name": "Giulia", "email": "giulia@example.com", "phone": ""}]
        )
        self.assertEqual((result["created"], result["updated"]), (0, 1))
        existing.refresh_from_db()
        self.assertEqual(existing.first_name, "Giulia")

    def test_import_row_without_phone_or_match_is_skipped(self):
        result = import_rows(self.salon, [{"first_name": "Nessuno", "email": "", "phone": ""}])
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (0, 0, 1))

    def test_rows_with_their_own_phone_are_never_merged_by_email(self):
        """L'email è la rete di sicurezza delle righe SENZA telefono.

        Un file esportato con lo stesso indirizzo di servizio su tutte le
        schede (`info@salone.it`) faceva finire 250 persone su una sola scheda,
        con la risposta «1 nuovo · 249 aggiornati» e nessun errore.
        """
        rows = [
            {"first_name": "Anna", "last_name": "Uno", "phone": "+393330001111", "email": "info@salone.it"},
            {"first_name": "Bea", "last_name": "Due", "phone": "+393330002222", "email": "info@salone.it"},
            {"first_name": "Carla", "last_name": "Tre", "phone": "+393330003333", "email": "info@salone.it"},
        ]
        result = import_rows(self.salon, rows)
        self.assertEqual((result["created"], result["updated"]), (3, 0))
        self.assertEqual(
            sorted(Client.objects.filter(salon=self.salon).values_list("first_name", flat=True)),
            ["Anna", "Bea", "Carla"],
        )

    def test_an_email_match_never_moves_the_phone_number(self):
        existing = self.make_client(phone="+393330005555", email="giulia@example.com")
        import_rows(self.salon, [{"first_name": "Giulia", "email": "giulia@example.com", "phone": ""}])
        existing.refresh_from_db()
        self.assertEqual(existing.phone, "+393330005555")

    def test_phones_without_a_single_digit_are_refused(self):
        """`phone_key("n/d") == ""`: tutte queste righe condividevano la chiave
        vuota e si sovrascrivevano l'una con l'altra sulla stessa scheda."""
        rows = [
            {"first_name": "Anna", "phone": "n/d"},
            {"first_name": "Bea", "phone": "-"},
            {"first_name": "Carla", "phone": "nessuno"},
        ]
        result = import_rows(self.salon, rows)
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (0, 0, 3))
        self.assertEqual([e["row"] for e in result["errors"]], [0, 1, 2])
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 0)

    def test_imported_clients_get_a_since_date(self):
        import_rows(self.salon, [{"first_name": "Anna", "phone": "+393330007777"}])
        client = Client.objects.get(salon=self.salon, first_name="Anna")
        self.assertEqual(client.since, timezone.localdate())

    def test_import_refuses_a_file_bigger_than_the_cap(self):
        """Ogni riga costa 2-5 query in una richiesta sincrona: senza tetto un
        file enorme tiene occupato un worker finché il proxy non chiude."""
        from pydantic import ValidationError

        from .schemas import IMPORT_MAX_ROWS

        rows = [{"first_name": f"C{i}", "phone": f"+3933310{i:05d}"} for i in range(IMPORT_MAX_ROWS + 1)]
        with self.assertRaises(ValidationError):
            ImportIn(rows=rows)

    def test_import_endpoint_logs_activity(self):
        data = ImportIn(rows=[ImportRowIn(first_name="A", phone="+393330000000")])
        result = import_clients(self.request, data)
        self.assertEqual(result["created"], 1)
        self.assertTrue(ActivityLog.objects.filter(type="client.imported").exists())


class NotesTests(ClientsTestCase):
    def test_create_and_delete_note(self):
        client = self.make_client()
        note = create_note(self.request, client.id, NoteIn(text="Allergica al lattice"))
        self.assertEqual(len(list_notes(self.request, client.id)), 1)
        delete_note(self.request, client.id, note["id"])
        self.assertFalse(ClientNote.objects.filter(id=note["id"]).exists())


class TechnicalSheetTests(ClientsTestCase):
    def test_create_sheet(self):
        client = self.make_client()
        sheet = create_sheet(
            self.request,
            client.id,
            TechnicalSheetIn(category="hair", treatment="Colore"),
        )
        self.assertEqual(TechnicalSheet.objects.filter(client=client).count(), 1)
        self.assertEqual(list(list_sheets(self.request, client.id)), [sheet])

    def _operator(self, salon=None):
        from apps.staff.models import Operator

        return Operator.objects.create(
            salon=salon or self.salon, first_name="Giulia", last_name="Bianchi"
        )

    def test_sheet_linked_to_an_appointment_of_this_client(self):
        from apps.agenda.models import Appointment

        client = self.make_client()
        appointment = Appointment.objects.create(
            salon=self.salon, client=client, operator=self._operator(), start=timezone.now()
        )
        sheet = create_sheet(
            self.request,
            client.id,
            TechnicalSheetIn(category="hair", treatment="Colore", appointment_id=appointment.id),
        )
        self.assertEqual(sheet.appointment_id, appointment.id)

    def test_an_appointment_of_someone_else_is_refused(self):
        """Prima l'id finiva dritto nella create: quello di un altro salone
        veniva salvato e la scheda spariva dallo storico (che la cerca fra gli
        appuntamenti di questa cliente), quello inesistente usciva come 500."""
        from apps.agenda.models import Appointment

        client = self.make_client()
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        stranger = Client.objects.create(
            salon=other_salon, first_name="Estranea", phone="+390001112222"
        )
        foreign = Appointment.objects.create(
            salon=other_salon,
            client=stranger,
            operator=self._operator(other_salon),
            start=timezone.now(),
        )
        other_client = self.make_client(phone="+393338889999", first_name="Altra")
        mine_but_hers = Appointment.objects.create(
            salon=self.salon, client=other_client, operator=self._operator(), start=timezone.now()
        )
        for appointment_id in (foreign.id, mine_but_hers.id, 999999):
            with self.assertRaises(HttpError) as caught:
                create_sheet(
                    self.request,
                    client.id,
                    TechnicalSheetIn(
                        category="hair", treatment="Colore", appointment_id=appointment_id
                    ),
                )
            self.assertEqual(caught.exception.status_code, 404, appointment_id)
        self.assertEqual(TechnicalSheet.objects.count(), 0)

    def test_no_update_or_delete_routes_for_sheets(self):
        """Verifica di contratto: le schede tecniche sono sola lettura dopo la
        creazione, quindi il router non deve esporre PUT/PATCH/DELETE su di esse."""
        methods: set[str] = set()
        for path, path_view in router.path_operations.items():
            if "sheets" in path:
                for operation in path_view.operations:
                    methods.update(operation.methods)
        self.assertIn("GET", methods)
        self.assertIn("POST", methods)
        self.assertNotIn("PUT", methods)
        self.assertNotIn("PATCH", methods)
        self.assertNotIn("DELETE", methods)

    def test_no_update_or_delete_view_functions_exported(self):
        import apps.clients.api as api_module

        self.assertFalse(hasattr(api_module, "update_sheet"))
        self.assertFalse(hasattr(api_module, "delete_sheet"))


class CategoryTests(ClientsTestCase):
    def test_create_category(self):
        category = create_category(self.request, CategoryIn(name="VIP"))
        self.assertTrue(ClientCategory.objects.filter(id=category.id).exists())


class ClientAppointmentsApiTests(TestCase):
    """GET /api/clients/{id}/appointments: storico appuntamenti del cliente (staff)."""

    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        user = User.objects.create_user(email="sole@theparlour.it", password="theparlour")
        role = Role.objects.create(salon=self.salon, name="Manager", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        tokens = create_staff_tokens(user, self.salon)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}

        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi", color="#AACCEE"
        )
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+391112223333"
        )

    def _appointment(self, client, start):
        from apps.agenda.models import Appointment

        return Appointment.objects.create(
            salon=self.salon, client=client, operator=self.operator, start=start
        )

    def test_returns_past_and_future_ordered_by_start(self):
        past = self._appointment(self.client_obj, timezone.now() - dt.timedelta(days=10))
        future = self._appointment(self.client_obj, timezone.now() + dt.timedelta(days=5))
        resp = self.client.get(
            f"/api/clients/{self.client_obj.id}/appointments", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        ids = [a["id"] for a in resp.json()]
        self.assertEqual(ids, [past.id, future.id])

    def test_only_returns_appointments_of_that_client(self):
        other_client = Client.objects.create(
            salon=self.salon, first_name="Altra", last_name="Persona", phone="+399998887777"
        )
        mine = self._appointment(self.client_obj, timezone.now())
        self._appointment(other_client, timezone.now())
        resp = self.client.get(
            f"/api/clients/{self.client_obj.id}/appointments", **self.auth
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual([a["id"] for a in resp.json()], [mine.id])

    def test_unknown_client_404(self):
        resp = self.client.get("/api/clients/999999/appointments", **self.auth)
        self.assertEqual(resp.status_code, 404)

    def test_client_of_other_salon_404(self):
        """Isolamento multi-tenant: un cliente di un altro salone non è raggiungibile."""
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        foreign_client = Client.objects.create(
            salon=other_salon, first_name="Estranea", last_name="Cliente", phone="+390001112222"
        )
        resp = self.client.get(
            f"/api/clients/{foreign_client.id}/appointments", **self.auth
        )
        self.assertEqual(resp.status_code, 404)


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
        with patch("apps.clients.api.find_client_by_phone", side_effect=[None, Client.objects.get()]):
            self.assertEqual(self._post().status_code, 200)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)

    def test_a_disabled_card_comes_back_as_a_new_lead(self):
        """Una cliente cancellata che ricompila il modulo: prima il consenso
        veniva registrato ma la scheda restava spenta, quindi fuori da ogni
        lista e da ogni audience. Contatto raccolto e mai visto da nessuno."""
        disabled = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331234567", is_active=False
        )
        self.assertEqual(self._post().status_code, 200)
        disabled.refresh_from_db()
        self.assertTrue(disabled.is_active)
        self.assertTrue(disabled.consents["privacy"])
        self.assertTrue(disabled.categories.filter(name="Da form").exists())
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)
        self.assertTrue(ActivityLog.objects.filter(type="client.created").exists())

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
# Genere + compleanno senza anno, import flessibile, note con allegati, storico
# ---------------------------------------------------------------------------


def _staff_http(salon, scopes):
    from apps.accounts.models import Membership, Role, User

    user = User.objects.create_user(email=f"staff{salon.id}@theparlour.it", password="x" * 10)
    role = Role.objects.create(salon=salon, name="Ruolo test", scopes=scopes)
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=False)
    tokens = create_staff_tokens(user, salon)
    return user, {"HTTP_AUTHORIZATION": f"Bearer {tokens['access']}"}


class ClientGenderBirthdayApiTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])

    def _post(self, payload):
        return self.client.post("/api/clients/", data=json.dumps(payload), content_type="application/json", **self.auth)

    def test_birthday_without_year_roundtrip(self):
        res = self._post({"first_name": "Sofia", "phone": "+393331112233", "birthday": "--03-15", "gender": "female"})
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["birthday"], "--03-15")
        self.assertFalse(body["birthday_year_known"])
        self.assertIsNone(body["age"])
        self.assertEqual(body["gender"], "female")
        client = Client.objects.get(id=body["id"])
        self.assertEqual((client.birthday.month, client.birthday.day), (3, 15))
        self.assertEqual(client.birthday.year, Client.BIRTHDAY_YEAR_UNKNOWN)

        detail = self.client.get(f"/api/clients/{body['id']}", **self.auth).json()
        self.assertEqual(detail["birthday"], "--03-15")

    def test_full_birthday_gives_age_and_update_keeps_format(self):
        res = self._post({"first_name": "Giada", "phone": "+393331112299", "birthday": "1990-03-15"})
        body = res.json()
        self.assertEqual(body["birthday"], "1990-03-15")
        self.assertTrue(body["birthday_year_known"])
        # Età esatta, non «almeno 30»: l'asserzione larga restava verde anche
        # con l'off-by-one del compleanno non ancora passato quest'anno.
        today = timezone.localdate()
        expected = today.year - 1990 - ((today.month, today.day) < (3, 15))
        self.assertEqual(body["age"], expected)
        put = self.client.put(
            f"/api/clients/{body['id']}",
            data=json.dumps({"first_name": "Giada", "phone": "+393331112299", "birthday": "--12-24", "gender": "other"}),
            content_type="application/json", **self.auth,
        )
        self.assertEqual(put.status_code, 200, put.content)
        self.assertEqual(put.json()["birthday"], "--12-24")
        self.assertEqual(put.json()["gender"], "other")

    def test_invalid_birthday_or_gender_rejected(self):
        self.assertEqual(self._post({"first_name": "X", "phone": "+39111", "birthday": "--13-40"}).status_code, 400)
        self.assertEqual(self._post({"first_name": "X", "phone": "+39111", "birthday": "15/03/1990"}).status_code, 400)
        self.assertEqual(self._post({"first_name": "X", "phone": "+39111", "gender": "boh"}).status_code, 400)
        self.assertEqual(self._post({"first_name": "", "phone": "+39111"}).status_code, 400)


class ImportFlexibleTests(ClientsTestCase):
    def test_phone_key_matching_and_extra_fields(self):
        existing = self.make_client(phone="+39 348 221 0094", first_name="Sofia", last_name="")
        result = import_rows(self.salon, [{
            "first_name": "Sofia", "last_name": "Ricci", "phone": "3482210094",
            "gender": "female", "birthday": "--03-15", "categories": ["VIP", " Expat "],
            "note": "Allergica al nichel", "lang": "en",
        }])
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (0, 1, 0))
        existing.refresh_from_db()
        self.assertEqual(existing.last_name, "Ricci")
        self.assertEqual(existing.gender, "female")
        self.assertFalse(existing.birthday_year_known)
        self.assertEqual(existing.lang, "en")
        self.assertEqual(existing.phone, "+39 348 221 0094")  # il numero originale resta
        self.assertEqual(sorted(existing.categories.values_list("name", flat=True)), ["Expat", "VIP"])
        self.assertEqual(existing.notes.count(), 1)

    def test_update_existing_false_skips_matches(self):
        self.make_client(phone="+393331112233")
        result = import_rows(self.salon, [{"first_name": "Sofia", "phone": "+39 333 111 2233"}], update_existing=False)
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (0, 0, 1))

    def test_errors_are_reported_per_row(self):
        result = import_rows(self.salon, [
            {"first_name": "", "phone": "+39111"},              # nome mancante
            {"first_name": "A", "phone": "+39222", "birthday": "--02-30"},  # data impossibile
            {"first_name": "B", "phone": "+39333", "gender": "male"},       # ok
        ])
        self.assertEqual(result["created"], 1)
        self.assertEqual(result["skipped"], 2)
        self.assertEqual([e["row"] for e in result["errors"]], [0, 1])


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix="youty-test-media-"))
class NoteAttachmentsApiTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+391112223333")

    def tearDown(self):
        shutil.rmtree(settings.MEDIA_ROOT, ignore_errors=True)

    def test_upload_note_with_files_then_remove_attachment(self):
        png = SimpleUploadedFile("prima.png", b"\x89PNG\r\n\x1a\n" + b"0" * 64, content_type="image/png")
        pdf = SimpleUploadedFile("consenso.pdf", b"%PDF-1.4 test", content_type="application/pdf")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "Prima seduta", "visibility": "private", "files": [png, pdf]},
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        note = res.json()
        self.assertEqual(note["text"], "Prima seduta")
        self.assertEqual(len(note["attachments"]), 2)
        self.assertTrue(note["attachments"][0]["is_image"])
        self.assertFalse(note["attachments"][1]["is_image"])
        self.assertTrue(note["attachments"][0]["url"].startswith("/media/"))

        att_id = note["attachments"][0]["id"]
        res = self.client.delete(f"/api/clients/{self.client_obj.id}/notes/{note['id']}/attachments/{att_id}", **self.auth)
        self.assertEqual(res.status_code, 200)
        notes = self.client.get(f"/api/clients/{self.client_obj.id}/notes", **self.auth).json()
        self.assertEqual(len(notes[0]["attachments"]), 1)

    def test_private_attachment_requires_signed_url(self):
        content = b"\x89PNG\r\n\x1a\n" + b"7" * 64
        png = SimpleUploadedFile("riservata.png", content, content_type="image/png")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "Riservata", "visibility": "private", "files": [png]},
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        url = res.json()["attachments"][0]["url"]
        path, _, query = url.partition("?")
        self.assertTrue(path.startswith("/media/client_notes/"))
        self.assertTrue(query.startswith("t="))
        # chi conosce solo il percorso non scarica nulla
        self.assertEqual(self.client.get(path).status_code, 403)
        # token manomesso: negato
        self.assertEqual(self.client.get(f"{path}?t={query[2:-3]}xyz").status_code, 403)
        # URL firmato restituito dall'API: il file
        res = self.client.get(url)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(b"".join(res.streaming_content), content)

    def test_private_attachment_cannot_be_reached_with_a_disguised_path(self):
        """Il controllo della firma non si aggira riscrivendo il percorso.

        `django.views.static.serve` normalizza il percorso dopo di noi: senza
        normalizzare prima, `/media/./client_notes/…` e `/media/x/../client_notes/…`
        (anche codificati) scaricavano il file senza token.
        """
        content = b"\x89PNG\r\n\x1a\n" + b"9" * 64
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "Riservata", "visibility": "private",
                  "files": [SimpleUploadedFile("nascosta.png", content, content_type="image/png")]},
            **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        path = res.json()["attachments"][0]["url"].split("?")[0]   # /media/client_notes/…
        rel = path[len("/media/"):]
        for disguised in (
            f"/media/./{rel}",
            f"/media/pub/../{rel}",
            f"/media/a/%2e%2e/{rel}",
            f"/media/%2e/{rel}",
            f"/media/client_notes/../{rel}",
        ):
            self.assertEqual(self.client.get(disguised).status_code, 403, disguised)

    def test_unsupported_type_rejected(self):
        zipf = SimpleUploadedFile("x.zip", b"PK\x03\x04", content_type="application/zip")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [zipf]}, **self.auth,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(ClientNote.objects.count(), 0)

    def test_an_extension_that_lies_about_the_type_is_refused(self):
        """Il Content-Type lo dichiara il client. Quello che conta è come il
        file finisce su disco: un .html servito da /media/ girerebbe sullo
        stesso origin di /admin/."""
        evil = SimpleUploadedFile(
            "foto.png.html", b"<script>alert(1)</script>", content_type="image/png"
        )
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [evil]}, **self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(ClientNote.objects.count(), 0)
        self.assertEqual(ClientNoteAttachment.objects.count(), 0)

    def test_the_stored_name_is_the_servers_and_the_original_stays_on_the_card(self):
        png = SimpleUploadedFile("prima seduta.png", b"\x89PNG\r\n\x1a\n" + b"0" * 8, content_type="image/png")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [png]}, **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        attachment = ClientNoteAttachment.objects.get()
        # sulla scheda resta il nome che l'operatrice riconosce…
        self.assertEqual(attachment.name, "prima seduta.png")
        # …su disco no: nome generato dal server, estensione coerente col tipo
        stored = attachment.file.name.rsplit("/", 1)[-1]
        self.assertNotIn("prima seduta", stored)
        self.assertTrue(stored.endswith(".png"), stored)

    def test_a_rejected_file_leaves_no_half_saved_attachment(self):
        good = SimpleUploadedFile("buona.png", b"\x89PNG\r\n\x1a\n", content_type="image/png")
        bad = SimpleUploadedFile("x.zip", b"PK\x03\x04", content_type="application/zip")
        res = self.client.post(
            f"/api/clients/{self.client_obj.id}/notes/upload",
            data={"text": "x", "files": [good, bad]}, **self.auth,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(ClientNoteAttachment.objects.count(), 0)

    def test_note_can_be_edited(self):
        note = ClientNote.objects.create(client=self.client_obj, text="vecchio")
        res = self.client.put(
            f"/api/clients/{self.client_obj.id}/notes/{note.id}",
            data=json.dumps({"text": "nuovo", "visibility": "ai"}), content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["text"], "nuovo")
        self.assertEqual(res.json()["visibility"], "ai")


class ClientHistoryApiTests(TestCase):
    def setUp(self):
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients", "agenda"])
        self.operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+391112223333")

    def test_history_groups_notes_and_sheets_under_the_visit(self):
        from apps.agenda.models import Appointment

        now = timezone.now()
        past = Appointment.objects.create(salon=self.salon, client=self.client_obj, operator=self.operator, start=now - dt.timedelta(days=10))
        future = Appointment.objects.create(salon=self.salon, client=self.client_obj, operator=self.operator, start=now + dt.timedelta(days=3))
        ClientNote.objects.create(client=self.client_obj, appointment=past, text="Nota di trattamento", author=self.user)
        ClientNote.objects.create(client=self.client_obj, text="Nota libera")
        TechnicalSheet.objects.create(client=self.client_obj, appointment=past, category="nail", treatment="Gel")

        res = self.client.get(f"/api/clients/{self.client_obj.id}/history", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        data = res.json()
        kinds = [e["kind"] for e in data["entries"]]
        self.assertEqual(kinds.count("visit"), 2)
        self.assertEqual(kinds.count("note"), 1)  # solo quella non legata a una visita
        self.assertEqual(kinds.count("sheet"), 0)  # la scheda sta dentro la visita
        visits = [e for e in data["entries"] if e["kind"] == "visit"]
        self.assertTrue(visits[0]["upcoming"])
        self.assertEqual(visits[0]["appointment"]["id"], future.id)
        past_entry = visits[1]
        self.assertEqual(len(past_entry["notes"]), 1)
        self.assertEqual(past_entry["notes"][0]["author_name"], self.user.email)
        self.assertEqual(len(past_entry["sheets"]), 1)
        self.assertEqual(past_entry["operator_name"], "Giulia Bianchi")
        self.assertEqual(data["counts"], {"visits": 1, "upcoming": 1, "notes": 2, "sheets": 1, "sales": 0})

    def test_history_of_other_salon_client_is_404(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        foreign = Client.objects.create(salon=other, first_name="X", phone="+39999")
        res = self.client.get(f"/api/clients/{foreign.id}/history", **self.auth)
        self.assertEqual(res.status_code, 404)


class PhoneNormalizationTests(ClientsTestCase):
    """Lo stesso numero scritto in modi diversi è lo stesso cliente."""

    def test_same_number_written_differently_is_one_client(self):
        created = create_client(
            self.request, ClientIn(first_name="Sofia", last_name="Ricci", phone="+39 333 1234567")
        )
        self.assertEqual(created.phone, "+393331234567")
        with self.assertRaises(HttpError) as caught:
            create_client(self.request, ClientIn(first_name="Sofia", last_name="Bis", phone="3331234567"))
        self.assertEqual(caught.exception.status_code, 400)

    def test_an_international_number_without_the_plus_is_not_prefixed_again(self):
        """«393331234567» è E.164 scritto senza il «+», non un numero italiano.

        Antependendo il prefisso diventava «+39393331234567»: una seconda
        scheda per la stessa persona, promemoria e OTP verso un numero che non
        esiste, e il login dell'app cliente che non riaggancia più lo storico.
        La regola è la stessa di splitPhone nel frontend (oltre 11 cifre =
        numero internazionale).
        """
        from common.phone import normalize_phone

        self.assertEqual(normalize_phone("393331234567"), "+393331234567")
        self.assertEqual(normalize_phone("39 333 1234567"), "+393331234567")
        self.assertEqual(normalize_phone("447911123456"), "+447911123456")
        # Sotto la soglia resta un numero nazionale, anche se comincia per 33
        # (Francia) o 39: «3331234567» è un cellulare italiano.
        self.assertEqual(normalize_phone("3331234567"), "+393331234567")
        self.assertEqual(normalize_phone("3391234567"), "+393391234567")

    def test_the_same_person_written_both_ways_is_one_client(self):
        created = create_client(
            self.request, ClientIn(first_name="Sofia", phone="+393331234567")
        )
        with self.assertRaises(HttpError) as caught:
            create_client(self.request, ClientIn(first_name="Sofia", phone="393331234567"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)
        self.assertEqual(created.phone, "+393331234567")

    def test_lookup_finds_legacy_spellings(self):
        from common.phone import find_client_by_phone

        legacy = self.make_client(phone="+39 333 987 6543")  # salvato prima della normalizzazione
        self.assertEqual(find_client_by_phone(self.salon, "3339876543"), legacy)
        self.assertEqual(find_client_by_phone(self.salon, "0039 333 9876543"), legacy)
        self.assertIsNone(find_client_by_phone(self.salon, "3330000000"))
        other = Salon.objects.create(name="Altro", slug="altro")
        self.assertIsNone(find_client_by_phone(other, "3339876543"))  # mai fuori dal salone


class ImportRobustnessTests(ClientsTestCase):
    """L'import non deve fermarsi a metà lasciando dati scritti e conteggi falsi."""

    def test_a_row_the_database_refuses_does_not_stop_the_import(self):
        # Due righe con lo stesso telefono: la seconda viola il vincolo di
        # unicità (salone, telefono). Prima l'eccezione usciva da import_rows e
        # l'utente vedeva un errore 500 con metà file già importato.
        rows = [
            {"first_name": "Prima", "phone": "+393330001111", "email": ""},
            {"first_name": "Doppia", "phone": "+39 333 000 1111", "email": ""},
            {"first_name": "Terza", "phone": "+393330002222", "email": ""},
        ]
        result = import_rows(self.salon, rows, update_existing=False)
        self.assertEqual(result["created"], 2)
        self.assertEqual(
            sorted(Client.objects.filter(salon=self.salon).values_list("first_name", flat=True)),
            ["Prima", "Terza"],
        )

    def test_counters_match_what_was_actually_written(self):
        rows = [{"first_name": "Solo", "phone": "+393330003333", "email": ""}]
        result = import_rows(self.salon, rows)
        written = Client.objects.filter(salon=self.salon).count()
        self.assertEqual(result["created"] + result["updated"], written)


class SensitiveReadsNeedTheClientsScopeTests(TestCase):
    """Storico, note e schede tecniche sono i dati più delicati del gestionale:
    leggerli richiede il permesso «clienti», non il solo accesso allo staff."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222"
        )
        no_scope = StaffContext(
            user=None, salon=self.salon, membership=None, scopes=set(), is_owner=False
        )
        self.request = SimpleNamespace(auth=no_scope)

    def test_history_notes_sheets_and_appointments_are_refused(self):
        from .api import client_history

        # list_client_appointments non lo chiedeva: le visite di una persona
        # sono un dato della sua scheda, non dell'agenda del giorno, e da lì si
        # leggevano nomi, servizi e importi senza il permesso «clienti».
        for view in (client_history, list_notes, list_sheets, list_client_appointments):
            with self.assertRaises(HttpError) as caught:
                view(self.request, self.client_obj.id)
            self.assertEqual(caught.exception.status_code, 403, view.__name__)

    def test_the_owner_still_reads_everything(self):
        from .api import client_history

        owner = SimpleNamespace(
            auth=StaffContext(
                user=None, salon=self.salon, membership=None, scopes=set(), is_owner=True
            )
        )
        self.assertEqual(list_notes(owner, self.client_obj.id), [])
        self.assertEqual(list(list_sheets(owner, self.client_obj.id)), [])
        self.assertEqual(list_client_appointments(owner, self.client_obj.id), [])
        self.assertIn("entries", client_history(owner, self.client_obj.id))


class InputValidationApiTests(TestCase):
    """Valori più lunghi della colonna o fuori dalle scelte del modello.

    Gli schemi dichiaravano `str` nudi e nessun endpoint chiama `full_clean()`:
    su Postgres una stringa troppo lunga usciva come 500 (`DataError` non
    gestita), e quando ci stava restava scritto un valore che nessuna lettura
    sa interpretare.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )

    def _json(self, method, url, payload):
        return getattr(self.client, method)(
            url, data=json.dumps(payload), content_type="application/json", **self.auth
        )

    def test_note_visibility_outside_the_choices_is_refused(self):
        for bad in ("da-condividere", "shared", "pubblica"):
            res = self._json("post", f"/api/clients/{self.client_obj.id}/notes", {"text": "x", "visibility": bad})
            self.assertEqual(res.status_code, 422, bad)
        self.assertEqual(ClientNote.objects.count(), 0)

    def test_client_language_outside_the_choices_is_refused(self):
        res = self._json("post", "/api/clients/", {"first_name": "X", "phone": "+393334445555", "lang": "italiano"})
        self.assertEqual(res.status_code, 422, res.content)

    def test_reliability_out_of_range_is_refused(self):
        res = self._json("post", "/api/clients/", {"first_name": "X", "phone": "+393334445555", "reliability": 5000})
        self.assertEqual(res.status_code, 422, res.content)

    def test_category_name_and_color_are_bounded(self):
        self.assertEqual(self._json("post", "/api/clients/categories", {"name": "A" * 61}).status_code, 422)
        self.assertEqual(
            self._json("post", "/api/clients/categories", {"name": "VIP", "color": "rgb(255,0,0)"}).status_code, 422
        )
        self.assertEqual(ClientCategory.objects.count(), 0)

    def test_sheet_fields_longer_than_the_column_are_refused(self):
        res = self._json(
            "post",
            f"/api/clients/{self.client_obj.id}/sheets",
            {"category": "a" * 41, "treatment": "Colore"},
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(TechnicalSheet.objects.count(), 0)


class SalesFiguresNeedTheSalesScopeTests(TestCase):
    """Spesa totale e incassi di ogni visita sono dati di cassa: si leggono con
    il permesso «vendite», come la lista degli incassi (che a questi ruoli è
    già preclusa)."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )
        from apps.sales.models import Sale

        Sale.objects.create(salon=self.salon, client=self.client_obj, kind="pos", total=Decimal("80"))

    def _ctx(self, scopes):
        return SimpleNamespace(
            auth=StaffContext(
                user=None, salon=self.salon, membership=None, scopes=set(scopes), is_owner=False
            )
        )

    def test_without_the_sales_scope_the_figures_are_zero(self):
        detail = get_client(self._ctx({"clients"}), self.client_obj.id)
        self.assertEqual(detail.total_spent, Decimal("0"))
        self.assertEqual(detail.visits, 0)
        self.assertIsNone(detail.last_visit)
        # Zero e «non ti e permesso vedere» devono restare distinguibili: senza
        # questo flag l'interfaccia mostrava «0 visite - 0 EUR spesi» e una
        # cliente storica sembrava alla prima visita, con il rischio che
        # l'operatrice le chiedesse la caparra riservata alle nuove.
        self.assertTrue(detail.stats_hidden)

    def test_with_the_sales_scope_the_figures_are_there(self):
        detail = get_client(self._ctx({"clients", "sales"}), self.client_obj.id)
        self.assertEqual(detail.total_spent, Decimal("80"))
        self.assertEqual(detail.visits, 1)
        self.assertFalse(detail.stats_hidden)

    def test_the_owner_sees_the_figures_without_the_scope(self):
        ctx = SimpleNamespace(
            auth=StaffContext(
                user=None, salon=self.salon, membership=None, scopes=set(), is_owner=True
            )
        )
        detail = get_client(ctx, self.client_obj.id)
        self.assertEqual(detail.total_spent, Decimal("80"))
        self.assertFalse(detail.stats_hidden)

    def test_the_history_hides_the_takings_too(self):
        from .api import client_history

        data = client_history(self._ctx({"clients"}), self.client_obj.id)
        self.assertEqual(data["counts"]["sales"], 0)
        self.assertEqual([e for e in data["entries"] if e["kind"] == "sale"], [])
        full = client_history(self._ctx({"clients", "sales"}), self.client_obj.id)
        self.assertEqual(full["counts"]["sales"], 1)


class ClientStatsOnRealSalesTests(TestCase):
    """client_stats su dati veri: finora era testata solo senza nessuna vendita."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )

    def _sale(self, total, line_types):
        from apps.sales.models import Sale, SaleLine

        sale = Sale.objects.create(
            salon=self.salon, client=self.client_obj, kind="pos", total=Decimal(total)
        )
        for line_type in line_types:
            SaleLine.objects.create(
                sale=sale, line_type=line_type, qty=1, unit_price=Decimal(total), amount=Decimal(total)
            )
        return sale

    def test_visits_and_total_spent_add_up(self):
        self._sale("40", ["service"])
        self._sale("25", ["product"])
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 2)
        self.assertEqual(stats["total_spent"], Decimal("65"))
        self.assertIsNotNone(stats["last_visit"])

    def test_a_gift_card_bought_at_the_counter_is_not_a_visit(self):
        """Chi regala un buono non si è seduto in poltrona. Contarlo gonfiava
        le visite e con esse le regole caparra («sotto le N visite chiedi la
        caparra»), che vedevano come abituale chi non era mai passata.
        L'incasso però resta: quei soldi il salone li ha presi."""
        self._sale("50", ["gift_card"])
        stats = client_stats(self.client_obj)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("50"))

    def test_a_visit_paid_together_with_a_gift_card_still_counts(self):
        self._sale("70", ["service", "gift_card"])
        self.assertEqual(client_stats(self.client_obj)["visits"], 1)


class ClientHistoryQueryCountTests(TestCase):
    """Lo storico non deve costare di più man mano che la cliente torna."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.ctx = SimpleNamespace(
            auth=StaffContext(
                user=None, salon=self.salon, membership=None, scopes={"clients"}, is_owner=True
            )
        )
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )
        from apps.staff.models import Operator

        self.operator = Operator.objects.create(
            salon=self.salon, first_name="Giulia", last_name="Bianchi"
        )

    def _appointments(self, how_many):
        from apps.agenda.models import Appointment

        for i in range(how_many):
            Appointment.objects.create(
                salon=self.salon,
                client=self.client_obj,
                operator=self.operator,
                start=timezone.now() - dt.timedelta(days=i + 1),
            )

    def _queries(self, view, how_many):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self._appointments(how_many)
        with CaptureQueriesContext(connection) as captured:
            view(self.ctx, self.client_obj.id)
        return len(captured)

    def test_the_cost_does_not_grow_with_the_number_of_visits(self):
        """_appointment_out senza indice regali interrogava le gift card una
        volta per appuntamento, e `salon` non era in select_related: due query
        in più a visita, oltre 160 per una cliente con 80 visite."""
        from .api import client_history

        for view in (list_client_appointments, client_history):
            with self.subTest(view=view.__name__):
                first = self._queries(view, 1)
                grown = self._queries(view, 6)
                self.assertEqual(grown, first, f"{view.__name__}: query in più per ogni visita")


class PhoneLookupTests(ClientsTestCase):
    """La ricerca per numero usa una colonna indicizzata, non una scansione."""

    def test_a_client_is_found_however_the_number_was_written(self):
        from common.phone import find_client_by_phone

        client = self.make_client(phone="+393331234567")
        for written in ("+393331234567", "333 123 4567", "00393331234567", "3331234567"):
            self.assertEqual(find_client_by_phone(self.salon, written), client, written)

    def test_the_key_is_kept_in_sync_when_the_number_changes(self):
        client = self.make_client(phone="+393331234567")
        self.assertEqual(client.phone_key, "393331234567")
        client.phone = "+447911123456"
        client.save(update_fields=["phone"])
        client.refresh_from_db()
        self.assertEqual(client.phone_key, "447911123456")

    def test_the_search_does_not_read_the_whole_address_book(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from common.phone import find_client_by_phone

        for n in range(30):
            self.make_client(phone=f"+39333100{n:04d}", first_name=f"C{n}")
        target = self.make_client(phone="+393339999999", first_name="Target")
        with CaptureQueriesContext(connection) as queries:
            found = find_client_by_phone(self.salon, "333 999 9999")
        self.assertEqual(found, target)
        self.assertLessEqual(len(queries), 3, [q["sql"] for q in queries])
