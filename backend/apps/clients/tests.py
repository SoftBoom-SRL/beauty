"""Test essenziali: import CSV (upsert), client_facts su dati minimi (sales/agenda
non ancora pronte → degrado a 0/[] senza eccezioni), immutabilità delle schede
tecniche (nessuna rotta di update/delete registrata sul router).

Le view sono chiamate direttamente (bypassando l'HTTP layer): usano solo
`request.auth`, quindi basta un `SimpleNamespace` con uno `StaffContext`
costruito a mano — evita di dipendere dal login reale di apps.accounts.
"""

from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import ActivityLog, Salon
from common.auth import StaffContext

from .api import (
    create_category,
    create_client,
    create_note,
    create_sheet,
    delete_client,
    delete_note,
    get_client,
    import_clients,
    list_clients,
    list_notes,
    list_sheets,
    router,
    update_client,
)
from .models import Client, ClientCategory, ClientNote, TechnicalSheet
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
        self.assertEqual(result, {"created": 1, "updated": 1})
        existing.refresh_from_db()
        self.assertEqual(existing.first_name, "New")
        self.assertTrue(Client.objects.filter(salon=self.salon, phone="+393339998888").exists())

    def test_import_matches_by_email_when_no_phone_match(self):
        existing = self.make_client(phone="+393330005555", email="giulia@example.com")
        result = import_rows(
            self.salon, [{"first_name": "Giulia", "email": "giulia@example.com", "phone": ""}]
        )
        self.assertEqual(result, {"created": 0, "updated": 1})
        existing.refresh_from_db()
        self.assertEqual(existing.first_name, "Giulia")

    def test_import_row_without_phone_or_match_is_skipped(self):
        result = import_rows(self.salon, [{"first_name": "Nessuno", "email": "", "phone": ""}])
        self.assertEqual(result, {"created": 0, "updated": 0})

    def test_import_endpoint_logs_activity(self):
        data = ImportIn(rows=[ImportRowIn(first_name="A", phone="+393330000000")])
        result = import_clients(self.request, data)
        self.assertEqual(result["created"], 1)
        self.assertTrue(ActivityLog.objects.filter(type="client.imported").exists())


class NotesTests(ClientsTestCase):
    def test_create_and_delete_note(self):
        client = self.make_client()
        note = create_note(self.request, client.id, NoteIn(text="Allergica al lattice"))
        self.assertEqual(list_notes(self.request, client.id).count(), 1)
        delete_note(self.request, client.id, note.id)
        self.assertFalse(ClientNote.objects.filter(id=note.id).exists())


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
