"""Schede senza telefono e telefono di contatto (`Client.phone` vuoto, `contact_client`).

Il modello e `contact_phone`; poi l'API della scheda (telefono facoltativo, «si
contatta tramite», il numero già di un'altra cliente, l'archiviazione di chi fa
da contatto), la ricerca, i messaggi della visita e i flussi pubblici con una
rubrica che ha schede senza numero: niente deve andare in 500 né trovare la
scheda sbagliata.
"""

import datetime as dt
from types import SimpleNamespace

from django.db import IntegrityError, transaction
from django.test import TestCase
from django.utils import timezone

from apps.core.models import ActivityLog, Salon
from common.testing import client_bearer, post_json, put_json, staff_context

from ..api import list_clients
from ..models import Client
from .base import _staff_http


class NoPhoneTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")

    def test_many_clients_without_phone(self):
        Client.objects.create(salon=self.salon, first_name="Anna")
        Client.objects.create(salon=self.salon, first_name="Bea")
        self.assertEqual(Client.objects.filter(salon=self.salon, phone="").count(), 2)

    def test_same_phone_still_refused(self):
        Client.objects.create(salon=self.salon, first_name="Anna", phone="+393331112233")
        with self.assertRaises(IntegrityError), transaction.atomic():
            Client.objects.create(salon=self.salon, first_name="Bea", phone="+393331112233")

    def test_contact_phone_falls_back_to_contact_client(self):
        mamma = Client.objects.create(salon=self.salon, first_name="Laura", phone="+393331112233")
        figlia = Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=mamma)
        self.assertEqual(figlia.contact_phone, "+393331112233")
        self.assertEqual(mamma.contact_phone, "+393331112233")
        self.assertEqual(list(mamma.dependents.all()), [figlia])

    def test_own_phone_wins_and_no_phone_is_empty(self):
        mamma = Client.objects.create(salon=self.salon, first_name="Laura", phone="+393331112233")
        figlia = Client.objects.create(
            salon=self.salon, first_name="Giulia", phone="+393334445566", contact_client=mamma
        )
        self.assertEqual(figlia.contact_phone, "+393334445566")
        sola = Client.objects.create(salon=self.salon, first_name="Sola")
        self.assertEqual(sola.contact_phone, "")


class AmountDueTests(TestCase):
    """`sales.dues`: il debito della cliente letto in un posto solo."""

    def test_sums_only_what_is_still_due(self):
        from decimal import Decimal

        from apps.sales.dues import amounts_due_by_client, client_amount_due, open_dues
        from apps.sales.models import Sale

        salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        anna = Client.objects.create(salon=salon, first_name="Anna", phone="+393331112233")
        bea = Client.objects.create(salon=salon, first_name="Bea", phone="+393334445566")
        Sale.objects.create(salon=salon, kind="pos", client=anna, total=Decimal("100"), amount_due=Decimal("40"))
        Sale.objects.create(salon=salon, kind="pos", client=anna, total=Decimal("50"), amount_due=Decimal("10.50"))
        Sale.objects.create(salon=salon, kind="pos", client=anna, total=Decimal("70"))
        self.assertEqual(client_amount_due(anna), Decimal("50.50"))
        self.assertEqual(client_amount_due(bea), Decimal("0.00"))
        self.assertEqual(client_amount_due(None), Decimal("0.00"))
        self.assertEqual(open_dues(anna).count(), 2)
        self.assertEqual(amounts_due_by_client(salon, [anna.id, bea.id]), {anna.id: Decimal("50.50")})


class _Api(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])
        self.laura = Client.objects.create(
            salon=self.salon, first_name="Laura", last_name="Rossi", phone="+393331112233"
        )

    def post(self, body):
        return post_json(self.client, "/api/clients/", body, **self.auth)

    def put(self, client, body):
        return put_json(self.client, f"/api/clients/{client.id}", body, **self.auth)


class PhoneOptionalApiTests(_Api):
    def test_a_card_without_phone_is_created(self):
        for name in ("Giulia", "Bea"):
            res = self.post({"first_name": name})
            self.assertEqual(res.status_code, 200, res.content)
            self.assertEqual((res.json()["phone"], res.json()["contact"]), ("", None))
        self.assertEqual(Client.objects.filter(salon=self.salon, phone="").count(), 2)

    def test_the_number_of_an_active_card_says_whose_it_is(self):
        """Invece del solo «già registrato», chi ha il numero: la dashboard
        propone «Usa il numero di Laura come contatto»."""
        res = self.post({"first_name": "Giulia", "phone": "333 111 2233"})
        self.assertEqual(res.status_code, 400, res.content)
        body = res.json()
        self.assertEqual(body["phone_holder_id"], self.laura.id)
        self.assertEqual(body["phone_holder_name"], "Laura Rossi")
        self.assertTrue(body["contact_allowed"])
        self.assertIn("già registrato", body["detail"])

    def test_the_offer_creates_a_card_without_phone_linked_to_her(self):
        res = self.post({"first_name": "Giulia", "last_name": "Rossi", "contact_client_id": self.laura.id})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            res.json()["contact"], {"id": self.laura.id, "full_name": "Laura Rossi", "phone": "+393331112233"}
        )
        giulia = Client.objects.get(pk=res.json()["id"])
        self.assertEqual((giulia.phone, giulia.contact_client_id), ("", self.laura.id))
        self.assertEqual(giulia.contact_phone, "+393331112233")

    def test_a_card_that_passes_through_another_cannot_be_a_contact(self):
        """Niente catene: la nonna tramite la figlia che passa dalla nipote
        riceverebbe i messaggi su un numero vuoto."""
        giulia = Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=self.laura)
        # una scheda vecchia col numero E un contatto: il numero c'è, ma è una catena
        Client.objects.filter(pk=giulia.pk).update(phone="+393334445566")
        res = self.post({"first_name": "Nonna", "phone": "333 444 5566"})
        self.assertFalse(res.json()["contact_allowed"])
        res = self.post({"first_name": "Nonna", "contact_client_id": giulia.id})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("tramite un'altra cliente", res.json()["detail"])

    def test_the_contact_rules(self):
        other_salon = Salon.objects.create(name="Altro", slug="altro")
        foreign = Client.objects.create(salon=other_salon, first_name="Estranea", phone="+393330000009")
        archived = Client.objects.create(salon=self.salon, first_name="Ex", phone="+393330000008", is_active=False)
        no_phone = Client.objects.create(salon=self.salon, first_name="Senza")
        for contact_id, message in (
            (foreign.id, "non esiste"),
            (archived.id, "archiviata"),
            (no_phone.id, "non ha un numero suo"),
        ):
            with self.subTest(message=message):
                res = self.post({"first_name": "Giulia", "contact_client_id": contact_id})
                self.assertEqual(res.status_code, 400, res.content)
                self.assertIn(message, res.json()["detail"])
        res = self.put(self.laura, {"contact_client_id": self.laura.id})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("sé stessa", res.json()["detail"])

    def test_who_is_a_contact_cannot_pass_through_another(self):
        Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=self.laura)
        marco = Client.objects.create(salon=self.salon, first_name="Marco", phone="+393337778888")
        res = self.put(self.laura, {"phone": "", "contact_client_id": marco.id})
        self.assertEqual(res.status_code, 400, res.content)
        # e il suo numero, a Marco, non si offre come contatto
        res = self.put(self.laura, {"phone": "333 777 8888"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertFalse(res.json()["contact_allowed"])

    def test_the_number_of_a_contact_cannot_be_removed(self):
        Client.objects.create(salon=self.salon, first_name="Giulia", last_name="Rossi", contact_client=self.laura)
        res = self.put(self.laura, {"phone": None})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("Giulia Rossi", res.json()["detail"])
        self.laura.refresh_from_db()
        self.assertEqual(self.laura.phone, "+393331112233")

    def test_the_link_is_set_and_removed_with_a_put(self):
        giulia = Client.objects.create(salon=self.salon, first_name="Giulia")
        res = self.put(giulia, {"contact_client_id": self.laura.id})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["contact"]["id"], self.laura.id)
        log = ActivityLog.objects.filter(type="client.updated").latest("id")
        self.assertEqual(log.payload, {"client_id": giulia.id, "fields": ["contact_client_id"]})
        res = self.put(giulia, {"contact_client_id": None})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIsNone(res.json()["contact"])
        giulia.refresh_from_db()
        self.assertIsNone(giulia.contact_client_id)

    def test_the_card_shows_who_passes_through_her(self):
        Client.objects.create(salon=self.salon, first_name="Giulia", last_name="Rossi", contact_client=self.laura)
        Client.objects.create(salon=self.salon, first_name="Ex", contact_client=self.laura, is_active=False)
        res = self.client.get(f"/api/clients/{self.laura.id}", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([d["full_name"] for d in res.json()["dependents"]], ["Giulia Rossi"])
        rows = self.client.get("/api/clients/", {"q": "Giulia"}, **self.auth).json()["items"]
        self.assertEqual(rows[0]["contact"]["full_name"], "Laura Rossi")


class ArchivingAContactTests(_Api):
    def test_the_linked_cards_lose_the_link_and_the_answer_says_so(self):
        giulia = Client.objects.create(salon=self.salon, first_name="Giulia", last_name="Rossi", contact_client=self.laura)
        res = self.client.delete(f"/api/clients/{self.laura.id}", **self.auth)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(
            res.json(),
            {"ok": True, "unlinked_dependents": [{"id": giulia.id, "full_name": "Giulia Rossi", "phone": ""}]},
        )
        giulia.refresh_from_db()
        self.assertIsNone(giulia.contact_client_id)
        self.assertEqual(giulia.contact_phone, "")
        deleted = ActivityLog.objects.get(type="client.deleted")
        self.assertEqual(deleted.payload["unlinked_dependents"], [giulia.id])
        # la scheda della figlia aperta altrove si rilegge
        self.assertTrue(
            ActivityLog.objects.filter(type="client.updated", payload__client_id=giulia.id).exists()
        )

    def test_archiving_someone_without_dependents_answers_as_before(self):
        res = self.client.delete(f"/api/clients/{self.laura.id}", **self.auth)
        self.assertEqual(res.json(), {"ok": True, "unlinked_dependents": []})
        self.assertEqual(ActivityLog.objects.get(type="client.deleted").payload, {"client_id": self.laura.id})


class SearchWithoutPhoneTests(_Api):
    def _found(self, q):
        request = SimpleNamespace(auth=staff_context(self.salon, {"clients"}))
        return {c.first_name for c in list_clients(request, q=q)["items"]}

    def test_a_number_never_finds_a_card_without_phone(self):
        Client.objects.create(salon=self.salon, first_name="Sola")
        self.assertEqual(self._found("3"), {"Laura"})
        self.assertEqual(self._found("Sola"), {"Sola"})

    def test_the_contact_number_finds_who_passes_through_her(self):
        """La mamma detta il suo numero per prenotare la figlia."""
        Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=self.laura)
        Client.objects.create(salon=self.salon, first_name="Marta", phone="+393339990000", contact_client=self.laura)
        self.assertEqual(self._found("333 111 2233"), {"Laura", "Giulia"})
        self.assertEqual(self._found("1112233"), {"Laura", "Giulia"})
        self.assertEqual(self._found("+393331112233"), {"Laura", "Giulia"})


class MessagesGoToTheContactTests(_Api):
    def test_a_card_without_phone_can_be_booked(self):
        """La prenotazione dal gestionale non chiede un telefono: la conferma va al contatto, se c'è."""
        from unittest.mock import patch

        from apps.agenda.services.appointments import create_appointment
        from apps.catalog.models import Service, ServiceCategory
        from apps.core.models import OutboxEvent
        from apps.staff.models import Operator
        from common.testing import aware

        operator = Operator.objects.create(salon=self.salon, first_name="Bea", last_name="Neri")
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = Service.objects.create(salon=self.salon, category=category, name_it="Manicure", duration_min=60, price=40)
        operator.services.add(service)
        giulia = Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=self.laura)
        day = timezone.localdate() + dt.timedelta(days=3)
        with patch("apps.staff.services.shift_windows", return_value=[(0, 24 * 60)]):
            appointment = create_appointment(
                self.salon, giulia, [{"service_id": service.id, "operator_id": operator.id}],
                aware(day, 10), via="dashboard", actor=self.user,
            )
        self.assertEqual(appointment.client_id, giulia.id)
        event = OutboxEvent.objects.get(event_type="appointment.created")
        self.assertEqual(event.payload["phone"], "+393331112233")

    def test_the_visit_messages_carry_the_contact_number(self):
        from apps.agenda.models import Appointment
        from apps.agenda.services.messages import _event_payload
        from apps.staff.models import Operator

        operator = Operator.objects.create(salon=self.salon, first_name="Bea", last_name="Neri")
        giulia = Client.objects.create(salon=self.salon, first_name="Giulia", contact_client=self.laura)
        sola = Client.objects.create(salon=self.salon, first_name="Sola")
        start = timezone.now() + dt.timedelta(days=2)
        for client, phone in ((giulia, "+393331112233"), (sola, "")):
            appointment = Appointment.objects.create(salon=self.salon, client=client, operator=operator, start=start)
            self.assertEqual(_event_payload(appointment)["phone"], phone)


class PublicFlowsWithoutPhoneTests(TestCase):
    """Le schede senza numero non rispondono a nessun numero, nemmeno a quello vuoto."""

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sola = Client.objects.create(salon=self.salon, first_name="Sola")
        Client.objects.create(salon=self.salon, first_name="Altra")

    def test_no_code_for_an_empty_number(self):
        from apps.accounts.models import ClientOTP

        res = post_json(self.client, "/api/auth/client/request-otp", {"salon_slug": "the-parlour", "phone": ""})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(ClientOTP.objects.exists())
        res = post_json(
            self.client, "/api/auth/client/verify-otp", {"salon_slug": "the-parlour", "phone": "", "code": "123456"}
        )
        self.assertEqual(res.status_code, 400, res.content)

    def test_no_registration_without_a_number(self):
        res = post_json(
            self.client,
            "/api/auth/client/register",
            {"salon_slug": "the-parlour", "first_name": "Nuova", "last_name": "", "phone": ""},
        )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 2)

    def test_a_card_without_phone_has_no_app_session(self):
        """Il numero tolto dalla scheda (era della mamma) chiude anche la sessione aperta prima."""
        res = self.client.get("/api/auth/client/me", **client_bearer(self.sola))
        self.assertEqual(res.status_code, 401)

    def test_the_contact_form_needs_a_number_and_does_not_touch_cards_without_one(self):
        body = {"salon_slug": "the-parlour", "first_name": "Sola", "phone": "", "privacy": True}
        res = post_json(self.client, "/api/clients/public/hook", body)
        self.assertEqual(res.status_code, 400, res.content)
        res = post_json(self.client, "/api/clients/public/hook", {**body, "phone": "333 123 4567"})
        self.assertEqual(res.status_code, 200, res.content)
        self.sola.refresh_from_db()
        self.assertEqual((self.sola.phone, self.sola.consents.get("privacy")), ("", False))
        self.assertTrue(Client.objects.filter(salon=self.salon, phone="+393331234567").exists())

    def test_the_duplicates_check_ignores_cards_without_phone(self):
        import io

        from django.core.management import call_command

        out = io.StringIO()
        call_command("check_phone_duplicates", stdout=out)
        self.assertIn("Nessun doppione", out.getvalue())
