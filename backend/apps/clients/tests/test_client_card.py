"""Caccia 22/09 — la scheda cliente: PUT parziale, consensi, archiviate.

C15 + 18-07: il PUT applica solo i campi presenti e scrive solo le colonne
cambiate; le date dei consensi le scrive il server (14-14, 06-10). 07-03: la
revoca del consenso e la disattivazione valgono anche per gli invii marketing
in coda. 06-02: il numero di una scheda archiviata porta a quella scheda,
invece che a un «già registrato» senza via d'uscita.
"""

import datetime as dt
import json
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from ninja.errors import HttpError

from apps.core.models import ActivityLog, Salon
from common.auth import StaffContext, create_staff_tokens

from ..api import create_client, delete_client, update_client
from ..models import Client, ClientCategory
from ..schemas import ClientIn, ClientUpdateIn

MARKETING = "apps.marketing.services"


def _staff_http(salon, scopes=("clients",)):
    from apps.accounts.models import Membership, Role, User

    user = User.objects.create_user(email=f"reception{salon.id}@theparlour.it", password="x" * 10)
    role = Role.objects.create(salon=salon, name="Reception", scopes=list(scopes))
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=False)
    return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, salon)['access']}"}


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(
            auth=StaffContext(user=None, salon=self.salon, membership=None, scopes={"clients"}, is_owner=False)
        )

    def card(self, **kw):
        defaults = dict(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567")
        defaults.update(kw)
        return Client.objects.create(**defaults)


class PartialPutOverHttpTests(_Base):
    def setUp(self):
        super().setUp()
        self.auth = _staff_http(self.salon)

    def put(self, client, body):
        return self.client.put(
            f"/api/clients/{client.id}", json.dumps(body), content_type="application/json", **self.auth
        )

    def test_a_label_alone_is_a_valid_body(self):
        """Con lo schema del POST nome e telefono erano obbligatori: il PUT di una
        sola etichetta doveva rimandare tutta la scheda letta all'apertura."""
        client = self.card(lang="en", whatsapp_reminders=False)
        vip = ClientCategory.objects.create(salon=self.salon, name="VIP")
        res = self.put(client, {"category_ids": [vip.id]})
        self.assertEqual(res.status_code, 200, res.content)
        client.refresh_from_db()
        self.assertEqual(list(client.categories.all()), [vip])
        # Quello che la cliente ha cambiato dall'app resta com'è.
        self.assertEqual(client.lang, "en")
        self.assertFalse(client.whatsapp_reminders)
        log = ActivityLog.objects.get(type="client.updated")
        self.assertEqual(log.payload, {"client_id": client.id, "fields": ["category_ids"]})

    def test_an_archived_card_is_reactivated_with_is_active_alone(self):
        client = self.card(is_active=False)
        res = self.put(client, {"is_active": True})
        self.assertEqual(res.status_code, 200, res.content)
        client.refresh_from_db()
        self.assertTrue(client.is_active)
        self.assertIn("riattivato", ActivityLog.objects.get(type="client.updated").summary)

    def test_null_empties_optional_fields_only(self):
        client = self.card(email="sofia@esempio.it", birthday=dt.date(1990, 3, 15))
        res = self.put(client, {"email": None, "birthday": None})
        self.assertEqual(res.status_code, 200, res.content)
        client.refresh_from_db()
        self.assertEqual(client.email, "")
        self.assertIsNone(client.birthday)
        for body in ({"first_name": None}, {"phone": None}, {"is_active": None}, {"consents": None}):
            with self.subTest(body=body):
                self.assertEqual(self.put(client, body).status_code, 400)

    def test_nothing_changed_writes_nothing(self):
        client = self.card()
        res = self.put(client, {"first_name": "Sofia", "phone": "+39 333 123 4567"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(ActivityLog.objects.filter(type="client.updated").exists())


class OnlyChangedColumnsTests(_Base):
    def test_the_update_writes_only_the_changed_column(self):
        """18-07: il save() completo riscriveva anche stripe_*, scritti nel
        frattempo dal webhook, con la copia letta a inizio richiesta."""
        client = self.card()
        with CaptureQueriesContext(connection) as queries:
            update_client(self.request, client.id, ClientUpdateIn(last_name="Neri"))
        updates = [q["sql"] for q in queries.captured_queries if q["sql"].startswith("UPDATE")]
        self.assertEqual(len(updates), 1, updates)
        assignments = updates[0].split(" SET ", 1)[1].split(" WHERE ", 1)[0]
        self.assertIn('"last_name"', assignments)
        for column in ("stripe_customer_id", "consents", "lang", "is_active", "first_name"):
            self.assertNotIn(f'"{column}"', assignments)

    def test_a_changed_phone_brings_its_key_along(self):
        client = self.card()
        update_client(self.request, client.id, ClientUpdateIn(phone="348 221 0094"))
        client.refresh_from_db()
        self.assertEqual((client.phone, client.phone_key), ("+393482210094", "393482210094"))


class ConsentDatesTests(_Base):
    def test_granting_from_the_card_stamps_the_date(self):
        client = self.card(consents={"privacy": False, "marketing": False, "card_charge": False})
        update_client(
            self.request, client.id,
            # La data mandata dal client non conta: la scrive il server.
            ClientUpdateIn(consents={"privacy": True, "privacy_at": "1999-01-01T00:00:00"}),
        )
        client.refresh_from_db()
        self.assertTrue(client.consents["privacy"])
        self.assertTrue(client.consents["privacy_at"].startswith(str(dt.date.today().year)))
        self.assertFalse(client.consents["marketing"])

    def test_revoking_marketing_stamps_the_revocation(self):
        client = self.card(
            consents={"privacy": True, "privacy_at": "2026-01-02T10:00:00",
                      "marketing": True, "marketing_at": "2026-01-02T10:00:00"}
        )
        update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": False}))
        client.refresh_from_db()
        self.assertFalse(client.consents["marketing"])
        self.assertEqual(client.consents["marketing_at"], "")
        self.assertTrue(client.consents["marketing_revoked_at"])
        self.assertEqual(client.consents["privacy_at"], "2026-01-02T10:00:00")

    def test_an_unchanged_flag_keeps_its_dates(self):
        client = self.card(consents={"marketing": False, "marketing_revoked_at": "2026-09-20T09:00:00"})
        update_client(
            self.request, client.id,
            ClientUpdateIn(consents={"marketing": False, "marketing_revoked_at": ""}),
        )
        client.refresh_from_db()
        self.assertEqual(client.consents["marketing_revoked_at"], "2026-09-20T09:00:00")

    def test_a_new_card_has_the_dates_of_what_was_granted(self):
        created = create_client(
            self.request,
            ClientIn(first_name="Giulia", phone="+393339998877", consents={"privacy": True, "marketing": False}),
        )
        self.assertTrue(created.consents["privacy_at"])
        self.assertNotIn("marketing_at", created.consents)
        self.assertFalse(created.consents["card_charge"])


class MarketingFollowsTheCardTests(_Base):
    """07-03: le funzioni stanno in apps.marketing (ramo del fixer MARKETING);
    qui si verifica solo che la scheda le chiami, con `create=True`."""

    def test_revoking_marketing_notifies_the_marketing_side(self):
        client = self.card(consents={"privacy": True, "marketing": True})
        with patch(f"{MARKETING}.marketing_consent_changed", create=True) as changed:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": False}))
        changed.assert_called_once()
        self.assertEqual(changed.call_args.args[0].id, client.id)
        self.assertEqual(changed.call_args.kwargs, {"accepted": False})

    def test_granting_marketing_notifies_too(self):
        client = self.card(consents={"privacy": True, "marketing": False})
        with patch(f"{MARKETING}.marketing_consent_changed", create=True) as changed:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": True}))
        self.assertEqual(changed.call_args.kwargs, {"accepted": True})

    def test_an_unchanged_consent_notifies_nobody(self):
        client = self.card(consents={"privacy": True, "marketing": True})
        with patch(f"{MARKETING}.marketing_consent_changed", create=True) as changed:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": True}, last_name="Neri"))
        changed.assert_not_called()

    def test_deactivating_drops_her_from_pending_sends(self):
        client = self.card()
        with patch(f"{MARKETING}.drop_from_pending_sends", create=True) as drop:
            update_client(self.request, client.id, ClientUpdateIn(is_active=False))
        drop.assert_called_once()
        self.assertEqual(drop.call_args.args[0].id, client.id)

    def test_archiving_drops_her_from_pending_sends(self):
        client = self.card()
        with patch(f"{MARKETING}.drop_from_pending_sends", create=True) as drop:
            delete_client(self.request, client.id)
        drop.assert_called_once()
        self.assertEqual(drop.call_args.args[0].id, client.id)

    def test_without_the_marketing_functions_the_card_is_saved_anyway(self):
        import apps.marketing.services as marketing_services

        client = self.card(consents={"marketing": True})
        # Tolta per la durata del test, se c'è (dopo l'integrazione col marketing).
        saved = vars(marketing_services).pop("marketing_consent_changed", None)
        try:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": False}))
        finally:
            if saved is not None:
                marketing_services.marketing_consent_changed = saved
        client.refresh_from_db()
        self.assertFalse(client.consents["marketing"])


class ArchivedPhoneTests(_Base):
    def test_creating_with_the_number_of_an_archived_card_points_to_it(self):
        archived = self.card(first_name="Anna", last_name="Verdi", is_active=False)
        res = self.client.post(
            "/api/clients/",
            json.dumps({"first_name": "Anna", "last_name": "Verdi", "phone": "333 123 4567"}),
            content_type="application/json",
            **_staff_http(self.salon),
        )
        self.assertEqual(res.status_code, 409, res.content)
        body = res.json()
        self.assertEqual(body["archived_client_id"], archived.id)
        self.assertIn("archiviata", body["detail"])
        self.assertIn("Anna Verdi", body["detail"])
        self.assertEqual(Client.objects.filter(salon=self.salon).count(), 1)

    def test_an_active_duplicate_is_still_a_400(self):
        self.card()
        with self.assertRaises(HttpError) as caught:
            create_client(self.request, ClientIn(first_name="Altra", phone="3331234567"))
        self.assertEqual(caught.exception.status_code, 400)

    def test_moving_a_card_onto_an_archived_number_says_whose_it_is(self):
        self.card(first_name="Anna", last_name="Verdi", is_active=False)
        other = self.card(first_name="Bea", phone="+393480000000")
        with self.assertRaises(HttpError) as caught:
            update_client(self.request, other.id, ClientUpdateIn(phone="+39 333 123 4567"))
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("archiviata", caught.exception.message)

    def test_a_duplicate_with_an_old_key_can_still_be_archived(self):
        """18-02: prima il DELETE ricalcolava la chiave e finiva in IntegrityError."""
        self.card()
        stale = self.card(first_name="Doppia", phone="+390000000001")
        Client.objects.filter(pk=stale.pk).update(phone="393331234567", phone_key="39393331234567")
        delete_client(self.request, stale.id)
        stale.refresh_from_db()
        self.assertFalse(stale.is_active)


class GiftCodesOnTheCardTests(TestCase):
    """C21: nella scheda cliente il codice di una gift card (denaro al portatore)
    esce intero solo a chi ha i permessi marketing o vendite, come in agenda."""

    def setUp(self):
        from decimal import Decimal

        from django.utils import timezone

        from apps.agenda.models import Appointment, AppointmentService
        from apps.catalog.models import Service, ServiceCategory
        from apps.marketing.services import create_gift_card
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.sofia = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567"
        )
        category = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        service = Service.objects.create(
            salon=self.salon, category=category, name_it="Manicure", duration_min=60, price=Decimal("50.00")
        )
        operator = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="Bianchi")
        appointment = Appointment.objects.create(
            salon=self.salon, client=self.sofia, operator=operator,
            start=timezone.now() + dt.timedelta(days=2),
        )
        AppointmentService.objects.create(
            appointment=appointment, service=service, operator=operator, duration_min=60, price=Decimal("50.00")
        )
        self.card = create_gift_card(
            self.salon, Decimal("50.00"), gift_service=service, recipient_client=self.sofia,
            paid=True, paid_method="cash",
        )

    def _codes(self, scopes):
        auth = _staff_http(self.salon, scopes)
        visits = self.client.get(f"/api/clients/{self.sofia.id}/appointments", **auth)
        history = self.client.get(f"/api/clients/{self.sofia.id}/history", **auth)
        self.assertEqual(visits.status_code, 200, visits.content)
        self.assertEqual(history.status_code, 200, history.content)
        from_history = [
            g["code"] for e in history.json()["entries"] if e["kind"] == "visit" for g in e["appointment"]["gifts"]
        ]
        return [g["code"] for a in visits.json() for g in a["gifts"]], from_history

    def test_reception_sees_only_the_last_digits(self):
        visits, history = self._codes(("clients",))
        for code in visits + history:
            self.assertNotEqual(code, self.card.code)
            self.assertTrue(code.endswith(self.card.code[-4:]))
        self.assertEqual(len(visits), 1)
        self.assertEqual(len(history), 1)

    def test_marketing_sees_the_whole_code(self):
        visits, history = self._codes(("clients", "marketing"))
        self.assertEqual(visits + history, [self.card.code, self.card.code])
