"""Riferimenti agli id di un altro gestionale (`ExternalRef`, `core.external_refs`)."""

from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.clients.models import Client

from .. import external_refs
from ..models import ExternalRef, Salon


class ExternalRefTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.other = Salon.objects.create(name="Altro", slug="altro")
        self.anna = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")

    def test_link_and_resolve(self):
        external_refs.link(self.salon, "areabeauty", "cliente", "guid-1", self.anna)
        self.assertEqual(external_refs.resolve(self.salon, "areabeauty", "cliente", "guid-1"), self.anna)
        self.assertEqual(external_refs.resolve(self.salon, "areabeauty", "cliente", "guid-1", model=Client), self.anna)
        self.assertIsNone(external_refs.resolve(self.salon, "areabeauty", "cliente", "guid-2"))
        # un altro salone o un altro tipo non vedono il riferimento
        self.assertIsNone(external_refs.resolve(self.other, "areabeauty", "cliente", "guid-1"))
        self.assertIsNone(external_refs.resolve(self.salon, "areabeauty", "vendita", "guid-1"))

    def test_relink_moves_the_reference(self):
        bea = Client.objects.create(salon=self.salon, first_name="Bea", phone="+393334445566")
        external_refs.link(self.salon, "areabeauty", "cliente", 42, self.anna)
        external_refs.link(self.salon, "areabeauty", "cliente", "42", bea)
        self.assertEqual(ExternalRef.objects.count(), 1)
        self.assertEqual(external_refs.resolve(self.salon, "areabeauty", "cliente", 42), bea)
        self.assertEqual(external_refs.ids_for(self.salon, "areabeauty", "cliente"), {"42": bea.pk})

    def test_deleted_or_other_model_counts_as_missing(self):
        external_refs.link(self.salon, "areabeauty", "cliente", "x", self.anna)
        self.assertIsNone(external_refs.resolve(self.salon, "areabeauty", "cliente", "x", model=Salon))
        self.anna.delete()
        self.assertIsNone(external_refs.resolve(self.salon, "areabeauty", "cliente", "x"))

    def test_unique_per_salon_source_kind_id(self):
        external_refs.link(self.salon, "areabeauty", "cliente", "x", self.anna)
        with self.assertRaises(IntegrityError), transaction.atomic():
            ExternalRef.objects.create(
                salon=self.salon, source="areabeauty", kind="cliente", external_id="x",
                content_type_id=1, object_id=1,
            )
