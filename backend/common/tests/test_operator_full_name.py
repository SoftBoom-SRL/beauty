"""`Operator.full_name` (apps/staff/models.py) contro le copie scritte a mano.

Al commit 4ecefc8 la stessa espressione `f"{first_name} {last_name}".strip()`
stava in sales/api.py e agenda/api.py (`_operator_name`), inventory/schemas.py
(`resolve_operator_name`) e clients/api.py (storico cliente). I controlli su
«nessuna operatrice» restano ai chiamanti: erano diversi in ogni copia.
"""

from django.test import SimpleTestCase

from apps.staff.models import Operator


def _copied_name(op):
    return f"{op.first_name} {op.last_name}".strip()


class OperatorFullNameTests(SimpleTestCase):
    def test_first_and_last_name(self):
        self.assertEqual(Operator(first_name="Giulia", last_name="Bianchi").full_name, "Giulia Bianchi")

    def test_a_missing_part_leaves_no_space(self):
        self.assertEqual(Operator(first_name="Giulia", last_name="").full_name, "Giulia")
        self.assertEqual(Operator(first_name="", last_name="Bianchi").full_name, "Bianchi")
        self.assertEqual(Operator(first_name="", last_name="").full_name, "")

    def test_only_the_borders_are_stripped(self):
        op = Operator(first_name=" Anna  Maria", last_name="De  Luca\t")
        self.assertEqual(op.full_name, "Anna  Maria De  Luca")

    def test_same_as_the_copies(self):
        for first in ("Giulia", "", " Anna", "Ana María"):
            for last in ("Bianchi", "", "Rossi ", "D'Amico"):
                op = Operator(first_name=first, last_name=last)
                self.assertEqual(op.full_name, _copied_name(op), (first, last))

    def test_str_is_unchanged(self):
        # `__str__` non fa `strip`: l'admin mostra i nomi come sempre.
        self.assertEqual(str(Operator(first_name="Giulia", last_name="")), "Giulia ")
        self.assertEqual(str(Operator(first_name="Giulia", last_name="Bianchi")), "Giulia Bianchi")

    def test_is_not_a_model_field(self):
        # Una proprietà, non una colonna: nessuna migrazione, niente in `values()`.
        self.assertNotIn("full_name", {f.name for f in Operator._meta.get_fields()})
