"""Caccia 22/09 — import CSV della rubrica.

06-07 + 08-05 «cliente dal» dell'import; 06-08 email di famiglia; 06-13 +
14-15 29/02 di un anno non bisestile; 06-14 compleanno senza anno; 06-15 note
duplicate al secondo import; 06-02 schede archiviate; 18-07 colonne scritte.
"""

import datetime as dt
import json

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from apps.core.models import Salon
from common.auth import create_staff_tokens

from .models import Client, ClientNote
from .services import import_rows


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
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        archived = self.card(is_active=False)
        res = self.client.post(
            "/api/clients/import",
            json.dumps({"rows": [
                {"first_name": "Bea", "phone": "3339990000", "birthday": "1990-02-29"},
                {"first_name": "Anna", "phone": "+393331112233"},
            ]}),
            content_type="application/json",
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
