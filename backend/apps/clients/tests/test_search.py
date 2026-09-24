"""Caccia 22/09 — ricerca in anagrafica senza accenti né apostrofi tipografici.

06-16 + 13-22: «nicolo» non trovava «Nicolò», «d'amico» non trovava la
«D’Amico» scritta con l'apostrofo di iPhone e Word. La ricerca usa `iregex`,
che è `~*` su PostgreSQL in produzione e la REGEXP di Django su SQLite qui.
"""

from types import SimpleNamespace

from django.test import TestCase

from apps.core.models import Salon
from common.auth import StaffContext

from ..api import list_clients
from ..models import Client


class AccentInsensitiveSearchTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(
            auth=StaffContext(user=None, salon=self.salon, membership=None, scopes={"clients"}, is_owner=False)
        )
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
