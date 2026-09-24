"""`apps.core.services.default_location`, spostata qui da agenda/services.py.

Stesso codice dell'agenda al commit 4ecefc8; core/api.py `public_branding` ne
ha una copia identica. Qui si fissa il comportamento: la sede predefinita,
altrimenti la prima per id, altrimenti None, con le stesse query.
"""

from django.test import TestCase

from apps.core.models import Location, Salon
from apps.core.services import default_location


def _copied_default_location(salon):
    # agenda/services.py `default_location` al commit 4ecefc8.
    return salon.locations.filter(is_default=True).first() or salon.locations.first()


class DefaultLocationTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="Atelier Bianchi", slug="atelier-bianchi")

    def test_the_default_location_wins_even_if_created_later(self):
        Location.objects.create(salon=self.salon, name="Centro")
        main = Location.objects.create(salon=self.salon, name="Sede", is_default=True)
        with self.assertNumQueries(1):
            self.assertEqual(default_location(self.salon), main)

    def test_without_a_default_the_first_by_id(self):
        first = Location.objects.create(salon=self.salon, name="Zeta")
        Location.objects.create(salon=self.salon, name="Alfa")
        with self.assertNumQueries(2):
            self.assertEqual(default_location(self.salon), first)

    def test_no_location_is_none(self):
        with self.assertNumQueries(2):
            self.assertIsNone(default_location(self.salon))

    def test_two_defaults_the_first_by_id(self):
        # Il vincolo «una sola predefinita» lo tiene l'API delle sedi, non il
        # database: con due righe vince la prima per id, come nelle copie.
        Location.objects.create(salon=self.salon, name="Centro")
        one = Location.objects.create(salon=self.salon, name="Uno", is_default=True)
        Location.objects.create(salon=self.salon, name="Due", is_default=True)
        self.assertEqual(default_location(self.salon), one)

    def test_other_salons_do_not_count(self):
        other = Salon.objects.create(name="Altro", slug="altro")
        Location.objects.create(salon=other, name="Loro", is_default=True)
        mine = Location.objects.create(salon=self.salon, name="Mia")
        self.assertEqual(default_location(self.salon), mine)

    def test_same_answer_as_the_copies(self):
        self.assertEqual(default_location(self.salon), _copied_default_location(self.salon))
        Location.objects.create(salon=self.salon, name="Centro")
        self.assertEqual(default_location(self.salon), _copied_default_location(self.salon))
        Location.objects.create(salon=self.salon, name="Sede", is_default=True)
        self.assertEqual(default_location(self.salon), _copied_default_location(self.salon))
