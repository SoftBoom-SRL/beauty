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
