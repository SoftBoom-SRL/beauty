"""Caccia 22/09 — etichette cliente e condizioni che le citano.

06-06 + 01-13 + 15-07: le condizioni di regole caparra e automazioni salvano
il NOME dell'etichetta; rinominarla le spegneva in silenzio. 06-12: un nome
già usato (o il doppio clic su «Salva») usciva come 500.
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import OutboxEvent, Salon
from common.auth import StaffContext

from .api import create_category, delete_category, update_category
from .models import Client, ClientCategory
from .schemas import CategoryIn


def _label_rule(name, cmp="contains"):
    return {"op": "and", "rules": [{"field": "categories", "cmp": cmp, "value": name}]}


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(
            auth=StaffContext(user=None, salon=self.salon, membership=None, scopes={"clients"}, is_owner=False)
        )
        self.client_obj = Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")

    def deposit_rule(self, conditions, name="A rischio"):
        from apps.core.models import DepositRule

        return DepositRule.objects.create(
            salon=self.salon, name=name, amount_type="fixed", amount=Decimal("20"), conditions=conditions
        )

    def automation(self, conditions, name="Promo VIP"):
        from apps.automations.models import Automation

        return Automation.objects.create(salon=self.salon, name=name, event="birthday", conditions=conditions)


class RenameLabelTests(_Base):
    def test_renaming_keeps_the_deposit_rule_working(self):
        from apps.agenda.services import compute_deposit

        label = create_category(self.request, CategoryIn(name="Da seguire"))
        self.client_obj.categories.add(label)
        rule = self.deposit_rule(_label_rule("Da seguire"))
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))
        update_category(self.request, label.id, CategoryIn(name="Da seguire!", color=label.color))
        rule.refresh_from_db()
        self.assertEqual(rule.conditions["rules"][0]["value"], "Da seguire!")
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))

    def test_renaming_rewrites_the_automations_and_tells_yourang(self):
        label = create_category(self.request, CategoryIn(name="VIP"))
        automation = self.automation(
            {"op": "or", "rules": [
                {"field": "categories", "cmp": "contains", "value": "vip"},
                {"field": "total_spent", "cmp": "gt", "value": 500},
            ]}
        )
        other = self.automation(_label_rule("Nuova"), name="Benvenuto")
        update_category(self.request, label.id, CategoryIn(name="Clienti VIP"))
        automation.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(
            automation.conditions,
            {"op": "or", "rules": [
                {"field": "categories", "cmp": "contains", "value": "Clienti VIP"},
                {"field": "total_spent", "cmp": "gt", "value": 500},
            ]},
        )
        self.assertEqual(other.conditions, _label_rule("Nuova"))
        sent = OutboxEvent.objects.filter(event_type="automation.updated")
        self.assertEqual([e.payload["id"] for e in sent], [automation.id])
        self.assertEqual(sent[0].payload["conditions"]["rules"][0]["value"], "Clienti VIP")

    def test_a_case_only_rename_is_rewritten_too(self):
        label = create_category(self.request, CategoryIn(name="vip"))
        rule = self.deposit_rule(_label_rule("vip"))
        update_category(self.request, label.id, CategoryIn(name="VIP"))
        rule.refresh_from_db()
        self.assertEqual(rule.conditions["rules"][0]["value"], "VIP")

    def test_changing_only_the_colour_touches_no_rule(self):
        label = create_category(self.request, CategoryIn(name="VIP"))
        rule = self.deposit_rule(_label_rule("VIP"))
        before = rule.updated_at
        self.automation(_label_rule("VIP"))
        update_category(self.request, label.id, CategoryIn(name="VIP", color="#FF0000"))
        rule.refresh_from_db()
        self.assertEqual(rule.updated_at, before)
        self.assertFalse(OutboxEvent.objects.filter(event_type="automation.updated").exists())


class DuplicateLabelTests(_Base):
    def test_a_name_already_used_is_a_400(self):
        create_category(self.request, CategoryIn(name="VIP"))
        for name in ("VIP", "vip", " VIP "):
            with self.subTest(name=name), self.assertRaises(HttpError) as caught:
                create_category(self.request, CategoryIn(name=name))
            self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(ClientCategory.objects.filter(salon=self.salon).count(), 1)

    def test_renaming_onto_another_label_is_a_400(self):
        create_category(self.request, CategoryIn(name="VIP"))
        other = create_category(self.request, CategoryIn(name="Nuova"))
        with self.assertRaises(HttpError) as caught:
            update_category(self.request, other.id, CategoryIn(name="Vip"))
        self.assertEqual(caught.exception.status_code, 400)
        other.refresh_from_db()
        self.assertEqual(other.name, "Nuova")

    def test_a_double_click_racing_the_check_is_a_400_not_a_500(self):
        create_category(self.request, CategoryIn(name="VIP"))
        with patch("apps.clients.api.ClientCategory.objects.filter") as filtered:
            filtered.return_value.exists.return_value = False
            with self.assertRaises(HttpError) as caught:
                create_category(self.request, CategoryIn(name="VIP"))
        self.assertEqual(caught.exception.status_code, 400)

    def test_an_empty_name_is_refused(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, CategoryIn(name="   "))
        self.assertEqual(caught.exception.status_code, 400)


class DeleteLabelTests(_Base):
    def test_a_label_cited_by_a_rule_is_not_deleted_in_silence(self):
        label = create_category(self.request, CategoryIn(name="A rischio"))
        self.deposit_rule(_label_rule("A rischio"), name="Caparra a rischio")
        self.automation(_label_rule("a rischio"), name="Richiamo")
        with self.assertRaises(HttpError) as caught:
            delete_category(self.request, label.id)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Caparra a rischio", caught.exception.message)
        self.assertIn("Richiamo", caught.exception.message)
        self.assertTrue(ClientCategory.objects.filter(id=label.id).exists())

    def test_a_label_nobody_cites_is_deleted(self):
        label = create_category(self.request, CategoryIn(name="Nuova"))
        self.deposit_rule(_label_rule("VIP"))
        delete_category(self.request, label.id)
        self.assertFalse(ClientCategory.objects.filter(id=label.id).exists())
