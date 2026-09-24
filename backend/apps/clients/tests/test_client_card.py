"""Scheda cliente: creazione, modifica anche parziale, archiviazione, consensi.

Anche genere e compleanno senza anno, i valori troppo lunghi o fuori dalle
scelte del modello (422) e i codici delle gift card mostrati nella scheda.
"""

import datetime as dt
import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import ActivityLog, Salon
from common.testing import bearer, post_json, put_json, staff_context

from ..api import create_client, delete_client, get_client, update_client
from ..models import Client, ClientCategory, ClientNote, TechnicalSheet
from ..schemas import ClientIn, ClientUpdateIn
from .base import ClientsTestCase, _staff_http


class ClientCrudTests(ClientsTestCase):
    def test_create_and_update_client(self):
        data = ClientIn(first_name="Giulia", last_name="Bianchi", phone="+393331112222")
        client = create_client(self.request, data)
        self.assertEqual(client.full_name, "Giulia Bianchi")
        self.assertTrue(Client.objects.filter(id=client.id, salon=self.salon).exists())

        update_data = ClientIn(first_name="Giulia", last_name="Verdi", phone="+393331112222")
        updated = update_client(self.request, client.id, update_data)
        self.assertEqual(updated.last_name, "Verdi")

    def test_duplicate_phone_rejected_on_create(self):
        self.make_client(phone="+393339990000")
        data = ClientIn(first_name="Altra", last_name="Persona", phone="+393339990000")
        with self.assertRaises(HttpError) as exc:
            create_client(self.request, data)
        self.assertEqual(exc.exception.status_code, 400)

    def test_since_is_filled_at_creation(self):
        """Senza `since` il KPI «nuovi clienti» resta a zero per sempre."""
        client = create_client(
            self.request, ClientIn(first_name="Giada", phone="+393334445555")
        )
        self.assertEqual(client.since, timezone.localdate())

    def test_given_since_is_kept(self):
        """Chi importa uno storico dice da quando è cliente: non si sovrascrive."""
        client = create_client(
            self.request,
            ClientIn(first_name="Giada", phone="+393334446666", since=dt.date(2019, 5, 2)),
        )
        self.assertEqual(client.since, dt.date(2019, 5, 2))

    def test_the_database_refuses_two_cards_for_the_same_number(self):
        """L'identità è phone_key, non la stringa digitata.

        Il vincolo su (salone, telefono) guardava il testo: «+39 333 000 1111»
        e «+393330001111» erano due schede per la stessa persona, con storico,
        affidabilità e caparre spaccati a metà.
        """
        from django.db import IntegrityError, transaction

        self.make_client(phone="+393330001111")
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.make_client(phone="+39 333 000 1111", first_name="Doppia")

    def test_a_concurrent_duplicate_answers_400_not_500(self):
        """Il controllo di unicità non è atomico: a fermare la seconda scheda è
        il vincolo del database, e la violazione deve uscire come 400."""
        from unittest.mock import patch

        self.make_client(phone="+393337778888")
        data = ClientIn(first_name="Altra", phone="+39 333 777 8888")
        # find_client_by_phone cieco = le due richieste simultanee che superano
        # entrambe il controllo e arrivano insieme alla INSERT.
        with patch("apps.clients.profiles.find_client_by_phone", return_value=None) as finder:
            with self.assertRaises(HttpError) as exc:
                create_client(self.request, data)
        finder.assert_called_once()
        self.assertEqual(exc.exception.status_code, 400)


class ClientPartialUpdateTests(ClientsTestCase):
    """Il PUT applica solo i campi presenti nel corpo.

    `ClientIn` ha un default per quasi tutto: riversarlo intero su una scheda
    esistente cancellava i consensi (con la prova del consenso privacy),
    riportava l'affidabilità a 100 e riattivava le schede disattivate.
    """

    def test_a_partial_put_does_not_wipe_consents_and_reliability(self):
        client = self.make_client(
            phone="+393332221111",
            reliability=42,
            consents={"privacy": True, "privacy_at": "2026-01-02T10:00:00", "marketing": True},
        )
        update_client(
            self.request,
            client.id,
            ClientIn(first_name="Sofia", last_name="Neri", phone="+393332221111"),
        )
        client.refresh_from_db()
        self.assertEqual(client.last_name, "Neri")
        self.assertEqual(client.reliability, 42)
        self.assertTrue(client.consents["privacy"])
        self.assertEqual(client.consents["privacy_at"], "2026-01-02T10:00:00")
        self.assertTrue(client.consents["marketing"])

    def test_a_partial_put_does_not_reactivate_a_disabled_card(self):
        client = self.make_client(phone="+393332223333", is_active=False)
        update_client(self.request, client.id, ClientIn(first_name="Sofia", phone="+393332223333"))
        client.refresh_from_db()
        self.assertFalse(client.is_active)

    def test_what_is_in_the_body_is_applied(self):
        client = self.make_client(phone="+393332224444", reliability=100)
        update_client(
            self.request,
            client.id,
            ClientIn(first_name="Sofia", phone="+393332224444", reliability=30, is_active=False),
        )
        client.refresh_from_db()
        self.assertEqual(client.reliability, 30)
        self.assertFalse(client.is_active)

    def test_categories_are_left_alone_when_the_body_omits_them(self):
        client = self.make_client(phone="+393332225555")
        vip = ClientCategory.objects.create(salon=self.salon, name="VIP")
        client.categories.add(vip)
        update_client(self.request, client.id, ClientIn(first_name="Sofia", phone="+393332225555"))
        self.assertEqual(list(client.categories.all()), [vip])

    def test_stripe_identifiers_are_not_writable_from_the_client(self):
        """Copiare gli identificativi Stripe di un'altra cliente su questa
        scheda permetteva di addebitare un no-show sulla carta di lei."""
        client = self.make_client(phone="+393332226666")
        data = ClientIn.model_validate(
            {
                "first_name": "Sofia",
                "phone": "+393332226666",
                "stripe_customer_id": "cus_di_un_altra",
                "stripe_payment_method_id": "pm_di_un_altra",
            }
        )
        self.assertFalse(hasattr(data, "stripe_customer_id"))
        update_client(self.request, client.id, data)
        client.refresh_from_db()
        self.assertEqual(client.stripe_customer_id, "")
        self.assertEqual(client.stripe_payment_method_id, "")

    def test_soft_delete_sets_is_active_false_and_logs(self):
        client = self.make_client()
        delete_client(self.request, client.id)
        client.refresh_from_db()
        self.assertFalse(client.is_active)
        self.assertTrue(ActivityLog.objects.filter(type="client.deleted").exists())

    def test_detail_has_zeroed_computed_fields_without_sales_app(self):
        client = self.make_client()
        detail = get_client(self.request, client.id)
        self.assertEqual(detail.visits, 0)
        self.assertEqual(detail.total_spent, Decimal("0"))
        self.assertIsNone(detail.last_visit)


class ClientGenderBirthdayApiTests(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])

    def _post(self, payload):
        return post_json(self.client, "/api/clients/", payload, **self.auth)

    def test_birthday_without_year_roundtrip(self):
        res = self._post({"first_name": "Sofia", "phone": "+393331112233", "birthday": "--03-15", "gender": "female"})
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertEqual(body["birthday"], "--03-15")
        self.assertFalse(body["birthday_year_known"])
        self.assertIsNone(body["age"])
        self.assertEqual(body["gender"], "female")
        client = Client.objects.get(id=body["id"])
        self.assertEqual((client.birthday.month, client.birthday.day), (3, 15))
        self.assertEqual(client.birthday.year, Client.BIRTHDAY_YEAR_UNKNOWN)

        detail = self.client.get(f"/api/clients/{body['id']}", **self.auth).json()
        self.assertEqual(detail["birthday"], "--03-15")

    def test_full_birthday_gives_age_and_update_keeps_format(self):
        res = self._post({"first_name": "Giada", "phone": "+393331112299", "birthday": "1990-03-15"})
        body = res.json()
        self.assertEqual(body["birthday"], "1990-03-15")
        self.assertTrue(body["birthday_year_known"])
        # Età esatta, non «almeno 30»: l'asserzione larga restava verde anche
        # con l'off-by-one del compleanno non ancora passato quest'anno.
        today = timezone.localdate()
        expected = today.year - 1990 - ((today.month, today.day) < (3, 15))
        self.assertEqual(body["age"], expected)
        put = put_json(
            self.client,
            f"/api/clients/{body['id']}",
            {"first_name": "Giada", "phone": "+393331112299", "birthday": "--12-24", "gender": "other"},
            **self.auth,
        )
        self.assertEqual(put.status_code, 200, put.content)
        self.assertEqual(put.json()["birthday"], "--12-24")
        self.assertEqual(put.json()["gender"], "other")

    def test_invalid_birthday_or_gender_rejected(self):
        self.assertEqual(self._post({"first_name": "X", "phone": "+39111", "birthday": "--13-40"}).status_code, 400)
        self.assertEqual(self._post({"first_name": "X", "phone": "+39111", "birthday": "15/03/1990"}).status_code, 400)
        self.assertEqual(self._post({"first_name": "X", "phone": "+39111", "gender": "boh"}).status_code, 400)
        self.assertEqual(self._post({"first_name": "", "phone": "+39111"}).status_code, 400)


class InputValidationApiTests(TestCase):
    """Valori più lunghi della colonna o fuori dalle scelte del modello.

    Gli schemi dichiaravano `str` nudi e nessun endpoint chiama `full_clean()`:
    su Postgres una stringa troppo lunga usciva come 500 (`DataError` non
    gestita), e quando ci stava restava scritto un valore che nessuna lettura
    sa interpretare.
    """

    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.user, self.auth = _staff_http(self.salon, ["clients"])
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", phone="+393331112222"
        )

    def _json(self, method, url, payload):
        return getattr(self.client, method)(
            url, data=json.dumps(payload), content_type="application/json", **self.auth
        )

    def test_note_visibility_outside_the_choices_is_refused(self):
        for bad in ("da-condividere", "shared", "pubblica"):
            res = self._json("post", f"/api/clients/{self.client_obj.id}/notes", {"text": "x", "visibility": bad})
            self.assertEqual(res.status_code, 422, bad)
        self.assertEqual(ClientNote.objects.count(), 0)

    def test_client_language_outside_the_choices_is_refused(self):
        res = self._json("post", "/api/clients/", {"first_name": "X", "phone": "+393334445555", "lang": "italiano"})
        self.assertEqual(res.status_code, 422, res.content)

    def test_reliability_out_of_range_is_refused(self):
        res = self._json("post", "/api/clients/", {"first_name": "X", "phone": "+393334445555", "reliability": 5000})
        self.assertEqual(res.status_code, 422, res.content)

    def test_category_name_and_color_are_bounded(self):
        self.assertEqual(self._json("post", "/api/clients/categories", {"name": "A" * 61}).status_code, 422)
        self.assertEqual(
            self._json("post", "/api/clients/categories", {"name": "VIP", "color": "rgb(255,0,0)"}).status_code, 422
        )
        self.assertEqual(ClientCategory.objects.count(), 0)

    def test_sheet_fields_longer_than_the_column_are_refused(self):
        res = self._json(
            "post",
            f"/api/clients/{self.client_obj.id}/sheets",
            {"category": "a" * 41, "treatment": "Colore"},
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(TechnicalSheet.objects.count(), 0)


# ---------------------------------------------------------------------------
# Caccia 22/09 — la scheda cliente: PUT parziale, consensi, archiviate.
#
# C15 + 18-07: il PUT applica solo i campi presenti e scrive solo le colonne
# cambiate; le date dei consensi le scrive il server (14-14, 06-10). 07-03: la
# revoca del consenso e la disattivazione valgono anche per gli invii marketing
# in coda. 06-02: il numero di una scheda archiviata porta a quella scheda,
# invece che a un «già registrato» senza via d'uscita.
# ---------------------------------------------------------------------------


MARKETING = "apps.marketing.consent"


def _reception_auth(salon, scopes=("clients",)):
    """Un membro nuovo col ruolo «Reception»: ridà solo l'header (`_staff_http` anche l'utente)."""
    from apps.accounts.models import Membership, Role, User

    user = User.objects.create_user(email=f"reception{salon.id}@theparlour.it", password="x" * 10)
    role = Role.objects.create(salon=salon, name="Reception", scopes=list(scopes))
    Membership.objects.create(user=user, salon=salon, role=role, is_owner=False)
    return bearer(user, salon)


class _Base(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        self.request = SimpleNamespace(auth=staff_context(self.salon, {"clients"}))

    def card(self, **kw):
        defaults = dict(salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331234567")
        defaults.update(kw)
        return Client.objects.create(**defaults)


class PartialPutOverHttpTests(_Base):
    def setUp(self):
        super().setUp()
        self.auth = _reception_auth(self.salon)

    def put(self, client, body):
        return put_json(self.client, f"/api/clients/{client.id}", body, **self.auth)

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
        with patch(f"{MARKETING}.marketing_consent_changed") as changed:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": False}))
        changed.assert_called_once()
        self.assertEqual(changed.call_args.args[0].id, client.id)
        self.assertEqual(changed.call_args.kwargs, {"accepted": False})

    def test_granting_marketing_notifies_too(self):
        client = self.card(consents={"privacy": True, "marketing": False})
        with patch(f"{MARKETING}.marketing_consent_changed") as changed:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": True}))
        self.assertEqual(changed.call_args.kwargs, {"accepted": True})

    def test_an_unchanged_consent_notifies_nobody(self):
        client = self.card(consents={"privacy": True, "marketing": True})
        with patch(f"{MARKETING}.marketing_consent_changed") as changed:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": True}, last_name="Neri"))
        changed.assert_not_called()

    def test_deactivating_drops_her_from_pending_sends(self):
        client = self.card()
        with patch(f"{MARKETING}.drop_from_pending_sends") as drop:
            update_client(self.request, client.id, ClientUpdateIn(is_active=False))
        drop.assert_called_once()
        self.assertEqual(drop.call_args.args[0].id, client.id)

    def test_archiving_drops_her_from_pending_sends(self):
        client = self.card()
        with patch(f"{MARKETING}.drop_from_pending_sends") as drop:
            delete_client(self.request, client.id)
        drop.assert_called_once()
        self.assertEqual(drop.call_args.args[0].id, client.id)

    def test_without_the_marketing_functions_the_card_is_saved_anyway(self):
        import apps.marketing.consent as marketing_consent

        client = self.card(consents={"marketing": True})
        # Tolta per la durata del test, se c'è (dopo l'integrazione col marketing).
        saved = vars(marketing_consent).pop("marketing_consent_changed", None)
        try:
            update_client(self.request, client.id, ClientUpdateIn(consents={"marketing": False}))
        finally:
            if saved is not None:
                marketing_consent.marketing_consent_changed = saved
        client.refresh_from_db()
        self.assertFalse(client.consents["marketing"])


class ArchivedPhoneTests(_Base):
    def test_creating_with_the_number_of_an_archived_card_points_to_it(self):
        archived = self.card(first_name="Anna", last_name="Verdi", is_active=False)
        res = post_json(
            self.client,
            "/api/clients/",
            {"first_name": "Anna", "last_name": "Verdi", "phone": "333 123 4567"},
            **_reception_auth(self.salon),
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
        from apps.marketing.gift_cards import create_gift_card
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
        auth = _reception_auth(self.salon, scopes)
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
