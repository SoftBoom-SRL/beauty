"""Import CSV della rubrica (upsert): chi c'è già si aggiorna, chi manca si crea.

Riconoscimento per telefono comunque scritto (per email solo nelle righe
senza telefono), campi in più, righe che il database rifiuta, conteggi e
avvisi riga per riga.
"""

import datetime as dt

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.core.models import ActivityLog, Salon
from common.testing import bearer, post_json

from ..api import import_clients
from ..models import Client, ClientNote
from ..schemas import ImportIn, ImportRowIn
from ..services import import_rows
from .base import ClientsTestCase


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
        # Stessa persona (stesso nome): la riga senza telefono aggiorna la scheda.
        # Con un nome diverso la salta (06-08, vedi SharedEmailTests qui sotto).
        existing = self.make_client(first_name="Giulia", phone="+393330005555", email="giulia@example.com")
        result = import_rows(
            self.salon, [{"first_name": "Giulia", "email": "giulia@example.com", "phone": "", "lang": "en"}]
        )
        self.assertEqual((result["created"], result["updated"]), (0, 1))
        existing.refresh_from_db()
        self.assertEqual(existing.first_name, "Giulia")
        self.assertEqual(existing.lang, "en")

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
        # «Cliente dal» è quello del file; senza colonna resta vuoto, non la
        # data dell'import: la rubrica storica non è fatta di clienti nuove
        # (06-07, 08-05).
        import_rows(self.salon, [
            {"first_name": "Anna", "phone": "+393330007777"},
            {"first_name": "Bea", "phone": "+393330008888", "since": "2019-05-02"},
        ])
        self.assertIsNone(Client.objects.get(salon=self.salon, first_name="Anna").since)
        self.assertEqual(Client.objects.get(salon=self.salon, first_name="Bea").since, dt.date(2019, 5, 2))

    def test_import_refuses_a_file_bigger_than_the_cap(self):
        """Ogni riga costa 2-5 query in una richiesta sincrona: senza tetto un
        file enorme tiene occupato un worker finché il proxy non chiude."""
        from pydantic import ValidationError

        from ..schemas import IMPORT_MAX_ROWS

        rows = [{"first_name": f"C{i}", "phone": f"+3933310{i:05d}"} for i in range(IMPORT_MAX_ROWS + 1)]
        with self.assertRaises(ValidationError):
            ImportIn(rows=rows)

    def test_import_endpoint_logs_activity(self):
        data = ImportIn(rows=[ImportRowIn(first_name="A", phone="+393330000000")])
        result = import_clients(self.request, data)
        self.assertEqual(result["created"], 1)
        self.assertTrue(ActivityLog.objects.filter(type="client.imported").exists())


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
        # La data impossibile non costa più la cliente: entra senza compleanno,
        # con un avviso (06-13).
        self.assertEqual(result["created"], 2)
        self.assertEqual(result["skipped"], 1)
        self.assertEqual([e["row"] for e in result["errors"]], [0])
        self.assertTrue(any(w["row"] == 1 and "compleanno" in w["reason"] for w in result["warnings"]))


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


# ---------------------------------------------------------------------------
# Caccia 22/09 — import CSV della rubrica.
#
# 06-07 + 08-05 «cliente dal» dell'import; 06-08 email di famiglia; 06-13 +
# 14-15 29/02 di un anno non bisestile; 06-14 compleanno senza anno; 06-15 note
# duplicate al secondo import; 06-02 schede archiviate; 18-07 colonne scritte.
# ---------------------------------------------------------------------------


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def card(self, **kw):
        defaults = dict(salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233")
        defaults.update(kw)
        return Client.objects.create(**defaults)


class SinceTests(_Base):
    def test_a_new_card_has_the_since_of_the_file_or_none(self):
        result = import_rows(self.salon, [
            {"first_name": "Anna", "phone": "3331112233"},
            {"first_name": "Bea", "phone": "3331112244", "since": "2018-04-01"},
        ])
        self.assertEqual(result["created"], 2)
        self.assertIsNone(Client.objects.get(first_name="Anna").since)
        self.assertEqual(Client.objects.get(first_name="Bea").since, dt.date(2018, 4, 1))

    def test_an_unreadable_or_future_since_is_left_out_with_a_warning(self):
        tomorrow = (timezone.localdate() + dt.timedelta(days=1)).isoformat()
        result = import_rows(self.salon, [
            {"first_name": "Anna", "phone": "3331112233", "since": "02/05/2019"},
            {"first_name": "Bea", "phone": "3331112244", "since": tomorrow},
        ])
        self.assertEqual(result["created"], 2)
        self.assertEqual([w["row"] for w in result["warnings"]], [0, 1])
        self.assertFalse(Client.objects.exclude(since=None).exists())

    def test_the_oldest_known_since_wins_on_an_existing_card(self):
        anna = self.card(since=dt.date(2026, 9, 1))
        bea = self.card(first_name="Bea", phone="+393331112244", since=dt.date(2015, 1, 1))
        import_rows(self.salon, [
            {"first_name": "Anna", "phone": "3331112233", "since": "2017-03-10"},
            {"first_name": "Bea", "phone": "3331112244", "since": "2020-01-01"},
        ])
        anna.refresh_from_db()
        bea.refresh_from_db()
        self.assertEqual(anna.since, dt.date(2017, 3, 10))
        self.assertEqual(bea.since, dt.date(2015, 1, 1))


class SharedEmailTests(_Base):
    def test_a_phoneless_row_does_not_rename_someone_else(self):
        mamma = self.card(first_name="Mamma", last_name="Rossi", email="famiglia@rossi.it",
                          birthday=dt.date(1965, 6, 1))
        result = import_rows(self.salon, [
            {"first_name": "Figlia", "last_name": "Rossi", "phone": "", "email": "famiglia@rossi.it",
             "birthday": "2001-02-03", "note": "Allergia al nichel"},
        ])
        mamma.refresh_from_db()
        self.assertEqual((mamma.first_name, mamma.birthday), ("Mamma", dt.date(1965, 6, 1)))
        self.assertFalse(ClientNote.objects.filter(client=mamma).exists())
        self.assertEqual((result["updated"], result["skipped"]), (0, 1))
        self.assertEqual(result["errors"][0]["client_id"], mamma.id)
        self.assertIn("Mamma Rossi", result["errors"][0]["reason"])

    def test_the_same_person_without_phone_is_still_updated(self):
        nicolo = self.card(first_name="Nicolò", last_name="D’Amico", email="nicolo@esempio.it")
        result = import_rows(self.salon, [
            {"first_name": "nicolo", "last_name": "D'Amico", "phone": "", "email": "nicolo@esempio.it",
             "lang": "en"},
        ])
        self.assertEqual(result["updated"], 1)
        nicolo.refresh_from_db()
        self.assertEqual(nicolo.lang, "en")
        self.assertEqual(nicolo.first_name, "Nicolò")  # il nome della scheda non cambia


class BirthdayTests(_Base):
    def test_feb_29_of_a_common_year_imports_the_client_without_birthday(self):
        result = import_rows(self.salon, [{"first_name": "Bea", "phone": "3339990000", "birthday": "1990-02-29"}])
        self.assertEqual((result["created"], result["skipped"], result["errors"]), (1, 0, []))
        self.assertEqual(result["warnings"][0]["row"], 0)
        self.assertIn("senza compleanno", result["warnings"][0]["reason"])
        self.assertIsNone(Client.objects.get(first_name="Bea").birthday)

    def test_a_yearless_birthday_keeps_the_known_year(self):
        anna = self.card(birthday=dt.date(1990, 3, 15))
        import_rows(self.salon, [{"first_name": "Anna", "phone": "+393331112233", "birthday": "--03-15"}])
        anna.refresh_from_db()
        self.assertEqual((anna.birthday, anna.birthday_year_known), (dt.date(1990, 3, 15), True))

    def test_a_different_yearless_birthday_is_taken_from_the_file(self):
        anna = self.card(birthday=dt.date(1990, 3, 15))
        import_rows(self.salon, [{"first_name": "Anna", "phone": "+393331112233", "birthday": "--04-20"}])
        anna.refresh_from_db()
        self.assertEqual((anna.birthday.month, anna.birthday.day), (4, 20))
        self.assertFalse(anna.birthday_year_known)

    def test_an_unknown_gender_does_not_cost_the_row(self):
        result = import_rows(self.salon, [{"first_name": "Bea", "phone": "3339990000", "gender": "F"}])
        self.assertEqual(result["created"], 1)
        self.assertEqual(len(result["warnings"]), 1)


class ReimportTests(_Base):
    def test_reimporting_the_same_file_does_not_duplicate_notes(self):
        row = {"first_name": "Carla", "phone": "3338887777", "note": "Allergia al nichel"}
        import_rows(self.salon, [row])
        import_rows(self.salon, [row])
        self.assertEqual(ClientNote.objects.filter(client__phone="+393338887777").count(), 1)

    def test_an_unchanged_row_writes_no_column(self):
        self.card(email="anna@esempio.it", lang="it")
        row = {"first_name": "Anna", "last_name": "Verdi", "phone": "+393331112233", "email": "anna@esempio.it"}
        with CaptureQueriesContext(connection) as queries:
            result = import_rows(self.salon, [row])
        self.assertEqual(result["updated"], 1)
        self.assertFalse([q for q in queries.captured_queries if q["sql"].startswith('UPDATE "clients_client"')])

    def test_an_update_writes_only_the_changed_columns(self):
        self.card(lang="it")
        with CaptureQueriesContext(connection) as queries:
            import_rows(self.salon, [{"first_name": "Anna", "phone": "+393331112233", "lang": "en"}])
        updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith('UPDATE "clients_client"')]
        self.assertEqual(len(updates), 1)
        assignments = updates[0].split(" SET ", 1)[1].split(" WHERE ", 1)[0]
        self.assertIn('"lang"', assignments)
        for column in ("consents", "is_active", "stripe_customer_id", "reliability"):
            self.assertNotIn(f'"{column}"', assignments)


class ArchivedCardTests(_Base):
    def test_a_row_for_an_archived_card_points_to_it(self):
        archived = self.card(is_active=False, email="")
        for update_existing in (True, False):
            with self.subTest(update_existing=update_existing):
                result = import_rows(
                    self.salon,
                    [{"first_name": "Anna", "phone": "333 111 2233", "email": "nuova@esempio.it"}],
                    update_existing=update_existing,
                )
                self.assertEqual((result["created"], result["updated"], result["skipped"]), (0, 0, 1))
                self.assertEqual(result["errors"][0]["client_id"], archived.id)
                self.assertIn("archiviata", result["errors"][0]["reason"])
        archived.refresh_from_db()
        self.assertFalse(archived.is_active)
        self.assertEqual(archived.email, "")


class ImportApiTests(_Base):
    def test_the_endpoint_returns_warnings_and_the_card_ids(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="import@theparlour.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Reception", scopes=["clients"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=False)
        auth = bearer(user, self.salon)
        archived = self.card(is_active=False)
        res = post_json(
            self.client,
            "/api/clients/import",
            {"rows": [
                {"first_name": "Bea", "phone": "3339990000", "birthday": "1990-02-29"},
                {"first_name": "Anna", "phone": "+393331112233"},
            ]},
            **auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["created"], 1)
        self.assertEqual(body["warnings"][0]["row"], 0)
        self.assertEqual(body["errors"], [{"row": 1, "reason": body["errors"][0]["reason"], "client_id": archived.id}])


class ImplausiblePhoneTests(_Base):
    def test_an_unrecognised_number_is_imported_with_a_warning(self):
        """14-15: «348 221 0094 / 06 1234567» (19 cifre) entrava senza un avviso."""
        result = import_rows(self.salon, [
            {"first_name": "Bea", "phone": "348 221 0094 / 06 1234567"},
            {"first_name": "Carla", "phone": "348 221 0094"},
        ])
        self.assertEqual(result["created"], 2)
        self.assertEqual([w["row"] for w in result["warnings"]], [0])
        self.assertIn("Telefono non riconosciuto", result["warnings"][0]["reason"])
