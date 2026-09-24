"""Normalizzazione dei telefoni: la chiave con cui una scheda ritrova il suo contatto Yourang."""

from django.test import SimpleTestCase

from apps.integrations.sync import normalize_phone


class PhoneTests(SimpleTestCase):
    def test_italian_default_cc(self):
        self.assertEqual(normalize_phone("333 1234567"), "+393331234567")

    def test_passthrough_e164(self):
        self.assertEqual(normalize_phone("+41 79 123 45 67"), "+41791234567")

    def test_double_zero_prefix(self):
        self.assertEqual(normalize_phone("0039 333 1234567"), "+393331234567")

    def test_italian_landline_keeps_the_area_zero(self):
        # In Italia lo 0 di distretto fa parte del numero: +39 02 …, non +39 2 …
        self.assertEqual(normalize_phone("02 1234567"), "+39021234567")
        self.assertEqual(normalize_phone("0577 12345"), "+39057712345")

    def test_italian_landline_spellings_converge(self):
        # Il fallimento vero: due modi di scrivere lo stesso fisso non devono
        # dare due chiavi diverse, o diventano due contatti Yourang.
        self.assertEqual(normalize_phone("011 1234567"), normalize_phone("+39 011 1234567"))
        self.assertEqual(normalize_phone("011 1234567"), normalize_phone("0039 011 1234567"))

    def test_foreign_trunk_zero_dropped(self):
        # Fuori dall'Italia lo 0 iniziale è prefisso interurbano e va tolto.
        self.assertEqual(normalize_phone("0161 4960000", default_cc="44"), "+441614960000")

    def test_foreign_landline_spellings_converge(self):
        # L'altra faccia dello stesso errore: lo 0 va tolto anche quando il
        # numero arriva già con il suo prefisso internazionale.
        self.assertEqual(normalize_phone("+44 020 7946 0958"), "+442079460958")
        self.assertEqual(normalize_phone("+44 020 7946 0958"), normalize_phone("+44 20 7946 0958"))
        self.assertEqual(normalize_phone("0049 030 12345678"), normalize_phone("+49 30 12345678"))

    def test_unknown_country_code_left_untouched(self):
        # CC fuori tabella: intatto è meglio che accorciato a caso. La tabella
        # ora è l'elenco ITU completo (06-04) e +675 (Papua Nuova Guinea) ne fa
        # parte: il caso resta con un prefisso che l'ITU non ha assegnato.
        self.assertEqual(normalize_phone("+289 0123456"), "+2890123456")

    def test_garbage_returns_none(self):
        self.assertIsNone(normalize_phone("n/a"))
