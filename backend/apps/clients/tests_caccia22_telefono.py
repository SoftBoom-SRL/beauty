"""Caccia 22/09 — regole dei numeri di telefono (06-04, 06-11, 16-11).

Una sola tabella di casi, una riga per regola: è la stessa che
frontend/packages/shared/src/phone.js deve rispettare (normalizePhone), perché
il numero normalizzato è la chiave con cui si riconosce una cliente già in
rubrica — se backend e frontend divergono, la stessa persona diventa due
schede.

R1 «+» o «00» = internazionale: dopo il prefisso si toglie UNO 0 interurbano,
   per tutti i paesi tranne Italia (+39), San Marino (+378), Vaticano (+379) e
   Costa d'Avorio (+225), dove lo 0 fa parte del numero.
R2 solo cifre: 12 o più cifre che cominciano con un prefisso ITU assegnato =
   internazionale (e vale R1); altrimenti numero italiano → +39.
R3 dopo +39, 12 o più cifre che cominciano per 39 = prefisso ripetuto: quel
   39 si toglie (+39 393 1234567, 10 cifre, è un cellulare vero e resta).
"""

from django.test import SimpleTestCase

from common.phone import normalize_phone, phone_key

CASES = [
    # --- R1: «+» / «00», uno 0 interurbano via, tranne IT / SM / VA / CI ---
    ("R1", "+44 020 7946 0958", "+442079460958"),
    ("R1", "0044 020 7946 0958", "+442079460958"),
    ("R1", "+40 0721 234 567", "+40721234567"),        # Romania: fuori dalla tabella corta di prima
    ("R1", "+355 069 123 4567", "+355691234567"),      # Albania
    ("R1", "+380 050 123 4567", "+380501234567"),      # Ucraina
    ("R1", "+212 0612 345678", "+212612345678"),       # Marocco
    ("R1", "0041 079 123 45 67", "+41791234567"),
    ("R1", "+49 00151 2345678", "+4901512345678"),     # UNO solo, non tutti
    ("R1", "+39 02 1234567", "+39021234567"),          # Italia: lo 0 resta
    ("R1", "0039 06 1234567", "+39061234567"),
    ("R1", "+378 0549 123456", "+3780549123456"),      # San Marino: resta
    ("R1", "+379 06 6981 2345", "+3790669812345"),     # Vaticano: resta
    ("R1", "+225 07 12 34 56 78", "+2250712345678"),   # Costa d'Avorio: resta
    ("R1", "+289 0123456", "+2890123456"),             # prefisso non assegnato: intatto
    # --- R2: solo cifre ---
    ("R2", "380501234567", "+380501234567"),           # 12 cifre, Ucraina: internazionale
    ("R2", "355691234567", "+355691234567"),
    ("R2", "212612345678", "+212612345678"),
    ("R2", "5511912345678", "+5511912345678"),
    ("R2", "971501234567", "+971501234567"),
    ("R2", "393331234567", "+393331234567"),
    ("R2", "447911123456", "+447911123456"),
    ("R2", "4402079460958", "+442079460958"),          # internazionale: vale anche R1
    ("R2", "3331234567", "+393331234567"),             # ≤ 11 cifre: italiano, anche se inizia per 33
    ("R2", "3391234567", "+393391234567"),
    ("R2", "348 221 0094", "+393482210094"),
    ("R2", "02 1234567", "+39021234567"),
    ("R2", "289012345678", "+39289012345678"),         # 12 cifre ma prefisso non assegnato: italiano
    # --- R3: +39 ripetuto ---
    ("R3", "+39 39 333 1234567", "+393331234567"),
    ("R3", "0039 39 333 1234567", "+393331234567"),
    ("R3", "39393331234567", "+393331234567"),         # R2 poi R3
    ("R3", "+39 393 1234567", "+393931234567"),        # 10 cifre: cellulare vero, resta
    ("R3", "+39 39 333 123456", "+3939333123456"),     # 11 cifre: può essere italiano, resta
]


class PhoneRulesTableTests(SimpleTestCase):
    def test_every_rule_of_the_table(self):
        for rule, raw, expected in CASES:
            with self.subTest(rule=rule, raw=raw):
                self.assertEqual(normalize_phone(raw), expected)

    def test_the_table_covers_every_rule(self):
        self.assertEqual({rule for rule, _, _ in CASES}, {"R1", "R2", "R3"})

    def test_garbage_is_not_a_number(self):
        for raw in ("", "n/d", "da chiedere", "+39 12", "+0039 333 1234567"):
            with self.subTest(raw=raw):
                self.assertIsNone(normalize_phone(raw))

    def test_the_same_person_has_the_same_key(self):
        """La chiave è l'identità: scritto in qualunque modo, lo stesso numero."""
        self.assertEqual(phone_key("+39 39 333 1234567"), phone_key("+39 333 1234567"))
        self.assertEqual(phone_key("+40 0721 234 567"), phone_key("+40 721 234 567"))
        self.assertEqual(phone_key("380501234567"), phone_key("+380 50 123 4567"))
        self.assertEqual(phone_key("0721234567"), "390721234567")  # senza prefisso resta italiano


# ---------------------------------------------------------------------------
# 18-02: chiavi scritte con l'algoritmo del 17/09, mai ricalcolate
# ---------------------------------------------------------------------------

import contextlib  # noqa: E402
import importlib  # noqa: E402
import io  # noqa: E402

from django.apps import apps as django_apps  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.test import TestCase  # noqa: E402

from apps.core.models import Salon  # noqa: E402
from common.phone import find_client_by_phone  # noqa: E402

from .models import Client, ClientNote, TechnicalSheet  # noqa: E402

MIGRATION = importlib.import_module("apps.clients.migrations.0008_caccia22_clienti_phone_key")


def _as_before(client, **columns):
    """La scheda come l'ha lasciata il codice del 17/09: UPDATE diretto, senza save()."""
    Client.objects.filter(pk=client.pk).update(**columns)
    client.refresh_from_db()
    return client


def _recompute():
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        MIGRATION.recompute(django_apps, None)
    return out.getvalue()


class PhoneKeyMigrationTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def card(self, first_name, phone):
        return Client.objects.create(salon=self.salon, first_name=first_name, phone=phone)

    def test_the_migration_uses_the_same_algorithm_as_common_phone(self):
        for _, raw, expected in CASES:
            with self.subTest(raw=raw):
                self.assertEqual(MIGRATION._normalize(raw), expected)
                self.assertEqual(MIGRATION._key(raw), phone_key(raw))

    def test_a_raw_number_saved_before_the_17th_is_found_again(self):
        """«393331234567» salvato grezzo: chiave vecchia 39393331234567, al login
        nessuno la trovava e la cliente si registrava una seconda volta."""
        sofia = _as_before(
            self.card("Sofia", "+390000000001"), phone="393331234567", phone_key="39393331234567"
        )
        self.assertIsNone(find_client_by_phone(self.salon, "+39 333 1234567"))
        _recompute()
        sofia.refresh_from_db()
        self.assertEqual(sofia.phone_key, "393331234567")
        self.assertEqual(sofia.phone, "+393331234567")  # l'OTP parte verso Client.phone
        self.assertEqual(find_client_by_phone(self.salon, "+39 333 1234567"), sofia)

    def test_numbers_the_old_rules_got_wrong_are_rewritten(self):
        romena = _as_before(
            self.card("Ioana", "+390000000002"), phone="+400721234567", phone_key="400721234567"
        )
        doppio = _as_before(
            self.card("Marta", "+390000000003"), phone="+39393331112222", phone_key="39393331112222"
        )
        _recompute()
        romena.refresh_from_db()
        doppio.refresh_from_db()
        self.assertEqual((romena.phone, romena.phone_key), ("+40721234567", "40721234567"))
        self.assertEqual((doppio.phone, doppio.phone_key), ("+393331112222", "393331112222"))

    def test_a_duplicate_does_not_stop_the_migration(self):
        vera = self.card("Anna", "+393331234567")
        vecchia = _as_before(
            self.card("Anna", "+390000000004"), phone="393331234567", phone_key="39393331234567"
        )
        altra = _as_before(
            self.card("Bea", "+390000000005"), phone="3487654321", phone_key="3487654321"
        )
        out = _recompute()
        vera.refresh_from_db()
        vecchia.refresh_from_db()
        altra.refresh_from_db()
        self.assertEqual(vera.phone_key, "393331234567")
        # Il doppione resta com'era, ed è elencato.
        self.assertEqual((vecchia.phone, vecchia.phone_key), ("393331234567", "39393331234567"))
        self.assertIn(f"scheda #{vecchia.id}", out)
        self.assertIn(f"#{vera.id}", out)
        # Le altre schede dello stesso salone sono state sistemate comunque.
        self.assertEqual((altra.phone, altra.phone_key), ("+393487654321", "393487654321"))

    def test_a_key_freed_by_another_card_is_taken_whatever_the_order(self):
        """La chiave che vuole B è quella vecchia di A: B aspetta che A si sposti.
        Il vincolo unico si controlla riga per riga, quindi conta l'ordine."""
        for b_first in (True, False):
            with self.subTest(b_first=b_first):
                Client.objects.all().delete()
                cards = {}
                for name in (("B", "A") if b_first else ("A", "B")):
                    cards[name] = self.card(name, f"+39000000001{len(cards)}")
                a = _as_before(cards["A"], phone="+400721234567", phone_key="400721234567")
                b = _as_before(cards["B"], phone="+4000721234567", phone_key="4000721234567")
                self.assertEqual(MIGRATION._key(b.phone), a.phone_key)
                _recompute()
                a.refresh_from_db()
                b.refresh_from_db()
                self.assertEqual(a.phone_key, "40721234567")
                self.assertEqual(b.phone_key, "400721234567")
                # Il numero di B rinormalizzato non è stabile: resta com'era.
                self.assertEqual(b.phone, "+4000721234567")

    def test_a_number_with_words_keeps_its_text(self):
        mamma = _as_before(
            self.card("Carla", "+390000000007"), phone="333 1234567 (mamma)", phone_key="3331234567"
        )
        _recompute()
        mamma.refresh_from_db()
        self.assertEqual(mamma.phone, "333 1234567 (mamma)")
        self.assertEqual(mamma.phone_key, "393331234567")

    def test_nothing_to_do_prints_nothing(self):
        self.card("Sofia", "+393331234567")
        self.assertEqual(_recompute(), "")

    def test_a_card_whose_key_is_stale_can_be_archived(self):
        """Prima archiviare (save con update_fields) ricalcolava la chiave e,
        se era già di un'altra scheda, il DELETE finiva in 500."""
        self.card("Anna", "+393331234567")
        vecchia = _as_before(
            self.card("Anna", "+390000000006"), phone="393331234567", phone_key="39393331234567"
        )
        vecchia.is_active = False
        vecchia.save(update_fields=["is_active"])
        vecchia.refresh_from_db()
        self.assertFalse(vecchia.is_active)
        self.assertEqual(vecchia.phone_key, "39393331234567")


class CheckPhoneDuplicatesTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def _run(self):
        out = io.StringIO()
        code = 0
        try:
            call_command("check_phone_duplicates", stdout=out)
        except SystemExit as exc:
            code = exc.code
        return code, out.getvalue()

    def test_a_stale_stored_key_is_reported(self):
        card = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+390000000001")
        _as_before(card, phone="393331234567", phone_key="39393331234567")
        code, out = self._run()
        # La riallinea migrate: non è un doppione, non blocca il deploy.
        self.assertEqual(code, 0)
        self.assertIn("chiave telefono salvata diversa", out)
        self.assertIn("39393331234567 → 393331234567", out)

    def test_duplicates_show_what_a_deletion_would_take_away(self):
        vera = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331234567")
        vecchia = _as_before(
            Client.objects.create(salon=self.salon, first_name="Anna", phone="+390000000002"),
            phone="393331234567", phone_key="39393331234567",
        )
        ClientNote.objects.create(client=vecchia, text="Allergia al nichel")
        TechnicalSheet.objects.create(client=vecchia, category="hair", treatment="Colore")
        code, out = self._run()
        self.assertEqual(code, 1)
        self.assertIn(f"#{vera.id}", out)
        line = next(row for row in out.splitlines() if f"#{vecchia.id} " in row)
        self.assertIn("note 1", line)
        self.assertIn("schede 1", line)
        self.assertIn("fedeltà 0", line)
        self.assertIn("chiave salvata 39393331234567", out)
        self.assertIn("punti", out)  # il consiglio dice cosa porta via la cancellazione
