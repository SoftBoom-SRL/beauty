"""Ricerca in anagrafica: per nome, nome completo e numero comunque scritto."""

from types import SimpleNamespace

from django.test import TestCase

from apps.core.models import Salon
from common.testing import staff_context

from ..api import list_clients
from ..models import Client
from .base import ClientsTestCase


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


class PhoneKeyOnNumbersTests(ClientsTestCase):
    """Bug sospetti del 24/09, voce 20: la chiave telefonica si calcolava su
    tutta la ricerca e andava in OR con il resto. Da «Anna 3» usciva la chiave
    «3», e rispondeva ogni scheda con un 3 nel numero: tutti i cellulari
    italiani (+39 3…). Aggiungendo una cifra al nome la lista si allargava
    invece di restringersi."""

    def setUp(self):
        super().setUp()
        self.anna = self.make_client(first_name="Anna", last_name="Rossi", phone="+393331112222")
        self.sofia = self.make_client(first_name="Sofia", last_name="Bianchi", phone="+393339998888")
        self.anna_uk = self.make_client(first_name="Anna", last_name="Smith", phone="+447911124567")

    def found(self, q):
        return {c.id for c in list_clients(self.request, q=q)["items"]}

    def test_a_digit_after_the_name_narrows_the_list(self):
        self.assertEqual(self.found("Anna 3"), {self.anna.id})

    def test_a_formatted_number_after_the_name_still_needs_the_name(self):
        self.assertEqual(self.found("Anna 333-111-2222"), {self.anna.id})
        self.assertEqual(self.found("Sofia 333-111-2222"), set())

    def test_a_search_made_only_of_a_number_finds_it_however_written(self):
        for written in ("0039 333 111 2222", "333-111-2222", "(333) 111.22.22", "+39 333 1112222", "333 - 1112222"):
            self.assertEqual(self.found(written), {self.anna.id}, written)


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


# ---------------------------------------------------------------------------
# Caccia 22/09 — ricerca in anagrafica senza accenti né apostrofi tipografici.
#
# 06-16 + 13-22: «nicolo» non trovava «Nicolò», «d'amico» non trovava la
# «D’Amico» scritta con l'apostrofo di iPhone e Word. La ricerca usa `iregex`,
# che è `~*` su PostgreSQL in produzione e la REGEXP di Django su SQLite qui.
# ---------------------------------------------------------------------------


class AccentInsensitiveSearchTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(auth=staff_context(self.salon, {"clients"}))
        self.nicolo = Client.objects.create(
            salon=self.salon, first_name="Nicolò", last_name="Bellò", phone="+393330001234"
        )
        self.damico = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="D’Amico", phone="+393330001235"
        )
        self.dangelo = Client.objects.create(
            salon=self.salon, first_name="Luca", last_name="D'Angelo", phone="+393330001236"
        )
        self.plain = Client.objects.create(
            salon=self.salon, first_name="Nicolo", last_name="Russo", phone="+393330001237"
        )

    def found(self, q):
        return {c.id for c in list_clients(self.request, q=q)["items"]}

    def test_without_accents_finds_the_accented_name(self):
        self.assertEqual(self.found("nicolo bello"), {self.nicolo.id})

    def test_with_accents_finds_the_plain_name_too(self):
        self.assertEqual(self.found("NICOLÒ"), {self.nicolo.id, self.plain.id})

    def test_typographic_and_plain_apostrophes_are_the_same(self):
        self.assertEqual(self.found("d'amico"), {self.damico.id})
        self.assertEqual(self.found("d’angelo"), {self.dangelo.id})
        self.assertEqual(self.found("d'a"), {self.damico.id, self.dangelo.id})

    def test_regex_characters_are_just_characters(self):
        self.assertEqual(self.found("Nic.lo"), set())
        self.assertEqual(self.found("("), set())
        self.assertEqual(self.found("[a"), set())

    def test_phone_and_full_name_search_still_work(self):
        self.assertEqual(self.found("+39 333 000 1234"), {self.nicolo.id})
        self.assertEqual(self.found("anna d'amico"), {self.damico.id})
