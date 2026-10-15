"""Import CSV della rubrica (upsert): chi c'è già si aggiorna, chi manca si crea.

Riconoscimento per telefono comunque scritto (per email solo nelle righe
senza telefono), campi in più, righe che il database rifiuta, conteggi e
avvisi riga per riga.
"""

import datetime as dt
from unittest.mock import patch

from django.db import DataError, connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.core.models import ActivityLog, Salon
from common.testing import bearer, post_json

from ..api import import_clients
from ..models import Client, ClientCategory, ClientNote
from ..schemas import ImportIn, ImportRowIn
from ..importer import import_rows
from .base import ClientsTestCase


class ImportUpsertTests(ClientsTestCase):
    def test_import_creates_and_updates(self):
        existing = self.make_client(phone="+393330001111", first_name="Anna", last_name="Vecchi")
        rows = [
            {"first_name": "anna", "last_name": "Nuovi", "phone": "+393330001111", "email": ""},
            {"first_name": "Fresh", "last_name": "Client", "phone": "+393339998888", "email": ""},
        ]
        result = import_rows(self.salon, rows)
        self.assertEqual((result["created"], result["updated"], result["linked"]), (1, 1, 0))
        existing.refresh_from_db()
        # stesso numero e stesso nome di battesimo: è lei, e il cognome viene dal file
        self.assertEqual((existing.first_name, existing.last_name), ("anna", "Nuovi"))
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

    def test_a_row_without_phone_becomes_a_card_without_phone(self):
        """Prima veniva saltata: un salone arrivato da un altro gestionale
        perdeva tutte le clienti senza un numero valido (114 in uno solo)."""
        result = import_rows(self.salon, [{"first_name": "Nessuno", "email": "", "phone": ""}])
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (1, 0, 0))
        card = Client.objects.get(salon=self.salon)
        self.assertEqual((card.first_name, card.phone, card.contact_client_id), ("Nessuno", "", None))

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

    def test_phones_without_a_single_digit_enter_without_a_number(self):
        """`phone_key("n/d") == ""`: tutte queste righe condividevano la chiave
        vuota e si sovrascrivevano l'una con l'altra sulla stessa scheda; poi
        venivano scartate. Sono clienti senza numero: entrano così, con l'avviso."""
        rows = [
            {"first_name": "Anna", "phone": "n/d"},
            {"first_name": "Bea", "phone": "-"},
            {"first_name": "Carla", "phone": "nessuno"},
        ]
        result = import_rows(self.salon, rows)
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (3, 0, 0))
        self.assertEqual([w["row"] for w in result["warnings"]], [0, 1, 2])
        self.assertIn("«n/d» senza cifre", result["warnings"][0]["reason"])
        self.assertEqual(
            sorted(Client.objects.filter(salon=self.salon).values_list("first_name", "phone")),
            [("Anna", ""), ("Bea", ""), ("Carla", "")],
        )

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
        # Una scheda con la chiave telefono salvata da un algoritmo vecchio
        # (18-02): l'import non la riconosce dal numero, e il vincolo di
        # unicità su (salone, chiave) rifiuta la scheda nuova. Prima
        # l'eccezione usciva da import_rows e l'utente vedeva un errore 500 con
        # metà file già importato.
        stale = self.make_client(first_name="Vecchia", phone="+390000000009")
        Client.objects.filter(pk=stale.pk).update(phone="n/d vecchio", phone_key="393330001111")
        rows = [
            {"first_name": "Prima", "phone": "+393330002222", "email": ""},
            {"first_name": "Doppia", "phone": "+39 333 000 1111", "email": ""},
            {"first_name": "Terza", "phone": "+393330003333", "email": ""},
        ]
        result = import_rows(self.salon, rows, update_existing=False)
        self.assertEqual((result["created"], result["skipped"]), (2, 1))
        self.assertEqual([e["row"] for e in result["errors"]], [1])
        self.assertEqual(
            sorted(Client.objects.filter(salon=self.salon).values_list("first_name", flat=True)),
            ["Prima", "Terza", "Vecchia"],
        )

    def test_counters_match_what_was_actually_written(self):
        rows = [{"first_name": "Solo", "phone": "+393330003333", "email": ""}]
        result = import_rows(self.salon, rows)
        written = Client.objects.filter(salon=self.salon).count()
        self.assertEqual(result["created"] + result["updated"], written)

    def test_a_label_born_in_a_rejected_row_does_not_reject_the_next_ones(self):
        """Bug sospetti del 24/09, voce 23: la prima riga crea l'etichetta «VIP»
        nel suo savepoint, poi il database la rifiuta (PostgreSQL non accetta
        il carattere nullo nella nota). Il savepoint annullava anche
        l'etichetta, ma la cache la teneva: le righe dopo ricevevano
        un'etichetta che non esiste più, e il database rifiutava anche loro."""
        rows = [
            {"first_name": "Prima", "phone": "+393330001111", "categories": ["VIP"], "note": "a\x00b"},
            {"first_name": "Seconda", "phone": "+393330002222", "categories": ["VIP"]},
            {"first_name": "Terza", "phone": "+393330003333", "categories": ["vip"]},
        ]
        with patch("apps.clients.importer.ClientNote") as note_model:
            # SQLite il carattere nullo lo accetta: qui la nota si rifiuta come
            # fa PostgreSQL.
            note_model.objects.filter.return_value.exists.return_value = False
            note_model.objects.create.side_effect = DataError("PostgreSQL text fields cannot contain NUL (0x00) bytes")
            result = import_rows(self.salon, rows)
        note_model.objects.create.assert_called_once()
        self.assertEqual([e["row"] for e in result["errors"]], [0])
        self.assertEqual(result["created"], 2)
        vip = ClientCategory.objects.get(salon=self.salon, name="VIP")
        for name in ("Seconda", "Terza"):
            self.assertEqual(list(Client.objects.get(salon=self.salon, first_name=name).categories.all()), [vip])


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
        """06-08: la figlia senza numero con l'email di famiglia rinominava la
        madre. Poi veniva scartata; ora è una scheda sua, senza telefono, e
        l'avviso dice di chi è l'email."""
        mamma = self.card(first_name="Mamma", last_name="Rossi", email="famiglia@rossi.it",
                          birthday=dt.date(1965, 6, 1))
        row = {"first_name": "Figlia", "last_name": "Rossi", "phone": "", "email": "famiglia@rossi.it",
               "birthday": "2001-02-03", "note": "Allergia al nichel"}
        result = import_rows(self.salon, [row])
        mamma.refresh_from_db()
        self.assertEqual((mamma.first_name, mamma.birthday), ("Mamma", dt.date(1965, 6, 1)))
        self.assertFalse(ClientNote.objects.filter(client=mamma).exists())
        self.assertEqual((result["created"], result["updated"], result["skipped"]), (1, 0, 0))
        figlia = Client.objects.get(salon=self.salon, first_name="Figlia")
        self.assertEqual((figlia.phone, figlia.birthday), ("", dt.date(2001, 2, 3)))
        self.assertEqual(result["warnings"][0]["client_id"], figlia.id)
        self.assertIn("Mamma Rossi", result["warnings"][0]["reason"])
        # Reimportata, è la stessa scheda: niente doppioni né avvisi.
        again = import_rows(self.salon, [row])
        self.assertEqual((again["created"], again["updated"], again["warnings"]), (0, 1, []))
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 2)

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


class LongLabelNameTests(_Base):
    """Un nome d'etichetta oltre i 60 caratteri della colonna: l'import lo creava
    troncato ma lo cercava (e lo teneva in cache) intero. Al secondo import, o
    con due nomi che cominciano con gli stessi 60 caratteri, non lo ritrovava, e
    la nuova creazione urtava il vincolo (salone, nome): ogni riga con
    quell'etichetta finiva fra gli errori con «UNIQUE constraint failed»."""

    LONG = "Clienti arrivate con la promozione di settembre del salone del centro"

    def test_the_truncated_label_is_found_again(self):
        first = import_rows(self.salon, [{"first_name": "Anna", "phone": "+393330009901", "categories": [self.LONG]}])
        second = import_rows(self.salon, [
            {"first_name": "Bea", "phone": "+393330009902", "categories": [self.LONG]},
            {"first_name": "Carla", "phone": "+393330009903", "categories": [self.LONG[:60] + " (bis)"]},
        ])
        self.assertEqual((first["errors"], second["errors"]), ([], []))
        self.assertEqual(second["created"], 2)
        label = ClientCategory.objects.get(salon=self.salon)
        self.assertEqual(label.name, self.LONG[:60])
        for name in ("Anna", "Bea", "Carla"):
            self.assertEqual(list(Client.objects.get(salon=self.salon, first_name=name).categories.all()), [label])


class SharedNumberTests(_Base):
    """Lo stesso numero su più righe con nomi diversi: madre e figlia, coppie.

    In un solo salone arrivato da un altro gestionale 64 numeri erano usati da
    130 schede. Due schede non possono avere lo stesso telefono (è l'identità
    per l'app), e la seconda riga rinominava la prima: ora entra senza
    telefono e si contatta tramite chi ha il numero.
    """

    ROWS = [
        {"first_name": "Laura", "last_name": "Rossi", "phone": "333 111 2233", "birthday": "1968-05-02"},
        {"first_name": "Giulia", "last_name": "Rossi", "phone": "+39 333 1112233", "birthday": "2012-09-14"},
        {"first_name": "Marco", "last_name": "Bianchi", "phone": "3331112233"},
    ]

    def test_the_second_person_is_linked_to_the_first(self):
        result = import_rows(self.salon, self.ROWS)
        self.assertEqual((result["created"], result["updated"], result["linked"]), (3, 0, 2))
        laura = Client.objects.get(salon=self.salon, first_name="Laura")
        self.assertEqual((laura.phone, laura.birthday), ("+393331112233", dt.date(1968, 5, 2)))
        for name in ("Giulia", "Marco"):
            card = Client.objects.get(salon=self.salon, first_name=name)
            self.assertEqual((card.phone, card.contact_client_id), ("", laura.id))
            self.assertEqual(card.contact_phone, "+393331112233")
        self.assertEqual([w["row"] for w in result["warnings"]], [1, 2])
        self.assertIn("Il numero è di Laura Rossi", result["warnings"][0]["reason"])
        giulia = Client.objects.get(salon=self.salon, first_name="Giulia")
        self.assertEqual(result["warnings"][0]["client_id"], giulia.id)
        self.assertEqual(giulia.birthday, dt.date(2012, 9, 14))

    def test_reimporting_does_not_duplicate_the_linked_cards(self):
        import_rows(self.salon, self.ROWS)
        again = import_rows(self.salon, self.ROWS)
        self.assertEqual((again["created"], again["updated"], again["linked"]), (0, 3, 0))
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 3)
        skipped = import_rows(self.salon, self.ROWS, update_existing=False)
        self.assertEqual((skipped["created"], skipped["skipped"]), (0, 3))

    def test_the_same_person_written_another_way_is_still_her(self):
        """Nome e cognome invertiti, senza accenti, o il cognome cambiato: è lei."""
        laura = self.card(first_name="Laura", last_name="Rossi")
        result = import_rows(self.salon, [
            {"first_name": "Rossi", "last_name": "Laura", "phone": "333 111 2233"},
            {"first_name": "LAURA", "last_name": "Bianchi", "phone": "333 111 2233"},
        ])
        self.assertEqual((result["created"], result["updated"]), (0, 2))
        laura.refresh_from_db()
        self.assertEqual(laura.last_name, "Bianchi")

    def test_an_existing_card_without_phone_gets_linked(self):
        laura = self.card(first_name="Laura", last_name="Rossi")
        giulia = self.card(first_name="Giulia", last_name="Rossi", phone="")
        result = import_rows(self.salon, [{"first_name": "Giulia", "last_name": "Rossi", "phone": "3331112233"}])
        self.assertEqual((result["created"], result["updated"], result["linked"]), (0, 1, 1))
        giulia.refresh_from_db()
        self.assertEqual((giulia.phone, giulia.contact_client_id), ("", laura.id))

    def test_an_archived_holder_is_not_a_contact(self):
        self.card(first_name="Laura", last_name="Rossi", is_active=False)
        result = import_rows(self.salon, [{"first_name": "Giulia", "phone": "3331112233"}])
        self.assertEqual((result["created"], result["linked"]), (1, 0))
        giulia = Client.objects.get(salon=self.salon, first_name="Giulia")
        self.assertEqual((giulia.phone, giulia.contact_client_id), ("", None))
        self.assertIn("archiviata", result["warnings"][0]["reason"])


class RowsWithoutPhoneTests(_Base):
    def test_namesakes_without_phone_stay_two_people_across_blocks(self):
        """Due Maria Rossi senza numero sono due persone, anche quando il file
        arriva in due blocchi (la dashboard ne manda 250 alla volta): la riga
        dice quale è con `name_index`. Reimportando, ognuna ritrova la sua."""
        first = {"first_name": "Maria", "last_name": "Rossi", "phone": "", "name_index": 0, "note": "la prima"}
        second = {"first_name": "Maria", "last_name": "Rossi", "phone": "", "name_index": 1, "note": "la seconda"}
        self.assertEqual(import_rows(self.salon, [first])["created"], 1)
        self.assertEqual(import_rows(self.salon, [second])["created"], 1)
        again = import_rows(self.salon, [first, second])
        self.assertEqual((again["created"], again["updated"]), (0, 2))
        marie = list(Client.objects.filter(salon=self.salon).order_by("id"))
        self.assertEqual(len(marie), 2)
        self.assertEqual([m.notes.get().text for m in marie], ["la prima", "la seconda"])

    def test_a_different_email_is_a_different_person(self):
        import_rows(self.salon, [{"first_name": "Maria", "phone": "", "email": "maria@uno.it"}])
        result = import_rows(self.salon, [{"first_name": "Maria", "phone": "", "email": "maria@due.it"}])
        self.assertEqual(result["created"], 1)
        self.assertEqual(Client.objects.filter(salon=self.salon, first_name="Maria").count(), 2)

    def test_an_archived_card_without_phone_is_pointed_to(self):
        archived = self.card(first_name="Maria", last_name="Rossi", phone="", is_active=False)
        result = import_rows(self.salon, [{"first_name": "Maria", "last_name": "Rossi", "phone": ""}])
        self.assertEqual((result["created"], result["skipped"]), (0, 1))
        self.assertEqual(result["errors"][0]["client_id"], archived.id)

    def test_a_row_without_name_or_phone_is_refused(self):
        result = import_rows(self.salon, [{"first_name": "", "phone": "", "email": ""}])
        self.assertEqual((result["created"], result["skipped"]), (0, 1))
        self.assertEqual(result["errors"][0]["reason"], "Nome mancante")
