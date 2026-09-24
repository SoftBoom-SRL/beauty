"""Etichette della cliente (ClientCategory) e le regole che le citano per nome."""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import call, patch

from django.test import TestCase
from ninja.errors import HttpError

from apps.core.models import OutboxEvent, Salon
from common.testing import staff_context
from config.api import api

from ..api import client_counts, create_category, delete_category, update_category
from ..labels import update_label
from ..models import Client, ClientCategory
from ..schemas import ClientCategoryIn
from .base import ClientsTestCase, _staff_http


class CategoryTests(ClientsTestCase):
    def test_create_category(self):
        category = create_category(self.request, ClientCategoryIn(name="VIP"))
        self.assertTrue(ClientCategory.objects.filter(id=category.id).exists())


class LabelOpenApiTests(TestCase):
    """Bug sospetti del 24/09, voce 24: django-ninja dà ai componenti OpenAPI il
    nome della classe, e le `ClientCategoryIn`/`ClientCategoryOut` di etichette cliente,
    listino e magazzino si sovrascrivevano: ne restava una sola, quella del
    magazzino. Le etichette risultavano documentate senza il limite del nome
    né il formato del colore."""

    def test_the_labels_are_documented_with_their_own_schema(self):
        schema = api.get_openapi_schema()
        post = schema["paths"]["/api/clients/categories"]["post"]
        body = post["requestBody"]["content"]["application/json"]["schema"]["$ref"].rsplit("/", 1)[-1]
        fields = schema["components"]["schemas"][body]["properties"]
        self.assertEqual(fields["name"]["maxLength"], 60)
        self.assertEqual(fields["color"]["pattern"], "^#[0-9A-Fa-f]{6}$")


# ---------------------------------------------------------------------------
# Caccia 22/09 — etichette cliente e condizioni che le citano.
#
# 06-06 + 01-13 + 15-07: le condizioni di regole caparra e automazioni salvano
# il NOME dell'etichetta; rinominarla le spegneva in silenzio. 06-12: un nome
# già usato (o il doppio clic su «Salva») usciva come 500.
# ---------------------------------------------------------------------------


def _label_rule(name, cmp="contains"):
    return {"op": "and", "rules": [{"field": "categories", "cmp": cmp, "value": name}]}


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(auth=staff_context(self.salon, {"clients"}))
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
        from apps.agenda.services.deposits import compute_deposit

        label = create_category(self.request, ClientCategoryIn(name="Da seguire"))
        self.client_obj.categories.add(label)
        rule = self.deposit_rule(_label_rule("Da seguire"))
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))
        update_category(self.request, label.id, ClientCategoryIn(name="Da seguire!", color=label.color))
        rule.refresh_from_db()
        self.assertEqual(rule.conditions["rules"][0]["value"], "Da seguire!")
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))

    def test_renaming_rewrites_the_automations_and_tells_yourang(self):
        label = create_category(self.request, ClientCategoryIn(name="VIP"))
        automation = self.automation(
            {"op": "or", "rules": [
                {"field": "categories", "cmp": "contains", "value": "vip"},
                {"field": "total_spent", "cmp": "gt", "value": 500},
            ]}
        )
        other = self.automation(_label_rule("Nuova"), name="Benvenuto")
        update_category(self.request, label.id, ClientCategoryIn(name="Clienti VIP"))
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
        self.assertEqual(sent[0].coalesce_key, f"automation:{automation.id}")
        self.assertEqual(sent[0].payload["conditions"]["rules"][0]["value"], "Clienti VIP")

    def test_a_case_only_rename_is_rewritten_too(self):
        label = create_category(self.request, ClientCategoryIn(name="vip"))
        rule = self.deposit_rule(_label_rule("vip"))
        update_category(self.request, label.id, ClientCategoryIn(name="VIP"))
        rule.refresh_from_db()
        self.assertEqual(rule.conditions["rules"][0]["value"], "VIP")

    def test_changing_only_the_colour_touches_no_rule(self):
        label = create_category(self.request, ClientCategoryIn(name="VIP"))
        rule = self.deposit_rule(_label_rule("VIP"))
        before = rule.updated_at
        self.automation(_label_rule("VIP"))
        update_category(self.request, label.id, ClientCategoryIn(name="VIP", color="#FF0000"))
        rule.refresh_from_db()
        self.assertEqual(rule.updated_at, before)
        self.assertFalse(OutboxEvent.objects.filter(event_type="automation.updated").exists())


class DuplicateLabelTests(_Base):
    def test_a_name_already_used_is_a_400(self):
        create_category(self.request, ClientCategoryIn(name="VIP"))
        for name in ("VIP", "vip", " VIP "):
            with self.subTest(name=name), self.assertRaises(HttpError) as caught:
                create_category(self.request, ClientCategoryIn(name=name))
            self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(ClientCategory.objects.filter(salon=self.salon).count(), 1)

    def test_renaming_onto_another_label_is_a_400(self):
        create_category(self.request, ClientCategoryIn(name="VIP"))
        other = create_category(self.request, ClientCategoryIn(name="Nuova"))
        with self.assertRaises(HttpError) as caught:
            update_category(self.request, other.id, ClientCategoryIn(name="Vip"))
        self.assertEqual(caught.exception.status_code, 400)
        other.refresh_from_db()
        self.assertEqual(other.name, "Nuova")

    def test_a_double_click_racing_the_check_is_a_400_not_a_500(self):
        create_category(self.request, ClientCategoryIn(name="VIP"))
        with patch("apps.clients.labels.ClientCategory.objects.filter") as filtered:
            filtered.return_value.exists.return_value = False
            with self.assertRaises(HttpError) as caught:
                create_category(self.request, ClientCategoryIn(name="VIP"))
        filtered.assert_called_once()
        self.assertEqual(caught.exception.status_code, 400)

    def test_an_empty_name_is_refused(self):
        with self.assertRaises(HttpError) as caught:
            create_category(self.request, ClientCategoryIn(name="   "))
        self.assertEqual(caught.exception.status_code, 400)


class DeleteLabelTests(_Base):
    def test_a_label_cited_by_a_rule_is_not_deleted_in_silence(self):
        label = create_category(self.request, ClientCategoryIn(name="A rischio"))
        self.deposit_rule(_label_rule("A rischio"), name="Caparra a rischio")
        self.automation(_label_rule("a rischio"), name="Richiamo")
        with self.assertRaises(HttpError) as caught:
            delete_category(self.request, label.id)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Caparra a rischio", caught.exception.message)
        self.assertIn("Richiamo", caught.exception.message)
        self.assertTrue(ClientCategory.objects.filter(id=label.id).exists())

    def test_a_label_nobody_cites_is_deleted(self):
        label = create_category(self.request, ClientCategoryIn(name="Nuova"))
        self.deposit_rule(_label_rule("VIP"))
        delete_category(self.request, label.id)
        self.assertFalse(ClientCategory.objects.filter(id=label.id).exists())


def _other_station_first(other_station):
    """`lock_salon` sostituito: mentre si aspetta il lock, `other_station` salva e
    committa per prima; poi il lock arriva."""
    from apps.agenda.services.locking import lock_salon as real_lock

    state = {"done": False}

    def lock_after_the_other_station(salon):
        if not state["done"]:
            state["done"] = True
            other_station()
        return real_lock(salon)

    return patch("apps.agenda.services.locking.lock_salon", side_effect=lock_after_the_other_station)


class DeleteLabelRaceTests(_Base):
    """Bug sospetti del 24/09, voce 26: controllo e cancellazione non erano
    atomici. Una regola salvata da un'altra postazione fra i due passi citava
    un'etichetta che non c'era più, e non scattava per nessuna senza avviso:
    proprio il caso che il controllo vuole evitare. Ora il controllo si fa
    nella transazione della cancellazione, dopo il lock del salone."""

    def test_a_rule_saved_while_waiting_for_the_lock_is_seen(self):
        label = create_category(self.request, ClientCategoryIn(name="A rischio"))
        with _other_station_first(lambda: self.deposit_rule(_label_rule("A rischio"), name="Caparra a rischio")) as lock:
            with self.assertRaises(HttpError) as caught:
                delete_category(self.request, label.id)
        lock.assert_called_once_with(self.salon)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("Caparra a rischio", caught.exception.message)
        self.assertTrue(ClientCategory.objects.filter(id=label.id).exists())

    def test_a_rename_saved_while_waiting_for_the_lock_is_seen(self):
        label = create_category(self.request, ClientCategoryIn(name="A rischio"))
        self.deposit_rule(_label_rule("A rischio"), name="Caparra a rischio")

        def rename():
            # rinomina e riscrive la regola: «A rischio» non la cita più nessuno
            update_category(self.request, label.id, ClientCategoryIn(name="Rischio alto"))

        with _other_station_first(rename) as lock:
            with self.assertRaises(HttpError) as caught:
                delete_category(self.request, label.id)
        # la cancellazione, poi il rinomina dell'altra postazione, che prende lo stesso lock
        self.assertEqual(lock.call_args_list, [call(self.salon), call(self.salon)])
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("«Rischio alto»", caught.exception.message)
        self.assertTrue(ClientCategory.objects.filter(id=label.id).exists())


class UpdateLabelRaceTests(_Base):
    """La modifica salvava con save() completo la copia dell'etichetta letta a
    inizio richiesta. In gara con una cancellazione la riga non c'era più, e
    Django la reinseriva: l'etichetta tornava, senza più le sue clienti. E il
    nome da riscrivere nelle condizioni era quello di prima di un rinomina
    fatto nel frattempo da un'altra postazione."""

    def test_an_edit_arriving_after_the_delete_does_not_bring_the_label_back(self):
        label = create_category(self.request, ClientCategoryIn(name="VIP"))
        stale = ClientCategory.objects.get(pk=label.pk)  # letta dalla modifica prima della cancellazione
        delete_category(self.request, label.id)
        with self.assertRaises(HttpError) as caught:
            update_label(self.request.auth, stale, {"name": "Clienti VIP", "color": "#FF0000", "order": 0})
        self.assertEqual(caught.exception.status_code, 404)
        self.assertFalse(ClientCategory.objects.filter(salon=self.salon).exists())

    def test_the_conditions_are_renamed_from_the_name_it_has_now(self):
        label = create_category(self.request, ClientCategoryIn(name="A rischio"))
        rule = self.deposit_rule(_label_rule("A rischio"), name="Caparra a rischio")
        stale = ClientCategory.objects.get(pk=label.pk)
        update_category(self.request, label.id, ClientCategoryIn(name="Rischio alto"))  # l'altra postazione
        update_label(self.request.auth, stale, {"name": "Rischio altissimo", "color": stale.color, "order": 0})
        rule.refresh_from_db()
        self.assertEqual(rule.conditions["rules"][0]["value"], "Rischio altissimo")

    def test_a_rule_saved_while_waiting_for_the_lock_is_renamed_too(self):
        label = create_category(self.request, ClientCategoryIn(name="A rischio"))
        saved = []
        with _other_station_first(lambda: saved.append(self.deposit_rule(_label_rule("A rischio")))) as lock:
            update_category(self.request, label.id, ClientCategoryIn(name="Rischio alto"))
        lock.assert_called_once_with(self.salon)
        saved[0].refresh_from_db()
        self.assertEqual(saved[0].conditions["rules"][0]["value"], "Rischio alto")


class LabelCountsTests(TestCase):
    """Bug sospetti del 24/09, voce 43: le card in cima alla sezione Clienti si
    contavano con una lista `limit=1` per «Attivi» e una per ogni etichetta, a
    ogni evento del feed dal vivo: con 10 etichette 12 richieste per evento, su
    ogni postazione aperta. GET /api/clients/counts dà tutti i numeri in una
    risposta, con il permesso e il filtro per salone della lista."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        other = Salon.objects.create(name="Altro salone", slug="altro-salone")
        self.vip = ClientCategory.objects.create(salon=self.salon, name="VIP")
        self.form = ClientCategory.objects.create(salon=self.salon, name="Da form")
        self.expat = ClientCategory.objects.create(salon=self.salon, name="Expat")
        foreign = ClientCategory.objects.create(salon=other, name="VIP")

        def card(salon, phone, labels=(), active=True):
            Client.objects.create(salon=salon, first_name="Anna", phone=phone, is_active=active).categories.add(*labels)

        card(self.salon, "+393330000001", [self.vip, self.form])
        card(self.salon, "+393330000002", [self.vip])
        card(self.salon, "+393330000003", [self.vip], active=False)  # archiviata: non conta
        card(self.salon, "+393330000004")
        card(other, "+393330000005", [foreign])  # di un altro salone
        # nessun permesso: la lista clienti la legge ogni membro dello staff
        _, self.auth = _staff_http(self.salon, [])

    def test_one_answer_with_the_numbers_of_the_list(self):
        res = self.client.get("/api/clients/counts", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body, {
            "active": 3,
            "categories": [
                {"id": self.vip.id, "count": 2},
                {"id": self.form.id, "count": 1},
                {"id": self.expat.id, "count": 0},
            ],
        })

        def listed(**params):
            res = self.client.get("/api/clients/", {"is_active": "true", "limit": 1, **params}, **self.auth)
            return res.json()["count"]

        self.assertEqual(body["active"], listed())
        for entry in body["categories"]:
            self.assertEqual(entry["count"], listed(category_id=entry["id"]))

    def test_the_queries_do_not_grow_with_the_labels(self):
        for n in range(10):
            ClientCategory.objects.create(salon=self.salon, name=f"Etichetta {n}")
        request = SimpleNamespace(auth=staff_context(self.salon))
        with self.assertNumQueries(2):
            body = client_counts(request)
        self.assertEqual(len(body["categories"]), 13)
