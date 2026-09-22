"""PROBE temporanei del revisore 06 (clienti). Da cancellare a fine revisione.

Ogni test afferma il comportamento CORRETTO: se fallisce, il difetto è confermato.
"""

import datetime as dt
from decimal import Decimal
from types import SimpleNamespace

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Salon
from common.auth import ClientContext, StaffContext
from common.phone import normalize_phone, phone_key

from .api import (
    client_history,
    create_category,
    create_client,
    delete_client,
    list_clients,
    update_category,
    update_client,
)
from .models import Client, ClientCategory, ClientNote
from .schemas import CategoryIn, ClientIn
from .services import client_facts, client_stats, import_rows


def staff(salon, scopes=("clients", "sales"), owner=False):
    return SimpleNamespace(
        auth=StaffContext(user=None, salon=salon, membership=None, scopes=set(scopes), is_owner=owner)
    )


class Base(TestCase):
    def setUp(self):
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="Probe", slug="probe")
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Verdi", phone="+393331112233"
        )
        self.operator = Operator.objects.create(salon=self.salon, first_name="Sofia", last_name="Ricci")

    def appointment(self, **kw):
        from apps.agenda.models import Appointment

        defaults = dict(
            salon=self.salon, client=self.client_obj, operator=self.operator,
            start=timezone.now() - dt.timedelta(days=1), status="closed",
        )
        defaults.update(kw)
        return Appointment.objects.create(**defaults)

    def checkout(self, appointment, total, deducted=Decimal("0")):
        from apps.sales.models import Payment, Sale, SaleLine

        sale = Sale.objects.create(
            salon=self.salon, kind="checkout", client=self.client_obj,
            appointment=appointment, total=total, deposit_deducted=deducted,
        )
        SaleLine.objects.create(sale=sale, line_type="service", qty=1, unit_price=total, amount=total)
        Payment.objects.create(sale=sale, method="cash", amount=total - deducted)
        return sale


class StatsProbe(Base):
    def test_deposit_is_not_a_second_visit_nor_extra_spend(self):
        from apps.sales.services import record_deposit_cashed

        appt = self.appointment(deposit_status="paid", deposit_amount=Decimal("30"))
        record_deposit_cashed(self.salon, appt, method="card")
        self.checkout(appt, Decimal("100"), deducted=Decimal("30"))
        stats = client_stats(self.client_obj)
        print("\n[probe] deposito+checkout ->", stats)
        self.assertEqual(stats["visits"], 1)
        self.assertEqual(stats["total_spent"], Decimal("100"))

    def test_refunded_deposit_of_a_cancelled_booking_is_not_a_visit(self):
        from apps.agenda.services import record_deposit_refund
        from apps.sales.services import record_deposit_cashed

        appt = self.appointment(
            start=timezone.now() + dt.timedelta(days=3), status="confirmed",
            deposit_status="paid", deposit_amount=Decimal("30"),
        )
        record_deposit_cashed(self.salon, appt, method="card")
        appt.status = "cancelled"
        appt.save(update_fields=["status"])
        record_deposit_refund(appt, refund_id="re_1", cents=3000, status="succeeded")
        stats = client_stats(self.client_obj)
        print("\n[probe] caparra rimborsata, mai venuta ->", stats)
        self.assertEqual(stats["visits"], 0)
        self.assertEqual(stats["total_spent"], Decimal("0"))

    def test_no_show_charge_is_not_a_visit(self):
        from apps.sales.services import record_no_show_charge

        appt = self.appointment(status="no_show")
        record_no_show_charge(self.salon, appt, amount=Decimal("40"))
        facts = client_facts(self.client_obj)
        print("\n[probe] no-show addebitato ->", facts["visits"], facts["noshow_count"])
        self.assertEqual(facts["visits"], 0)

    def test_first_visit_deposit_rule_still_applies_before_the_first_visit(self):
        from apps.agenda.services import compute_deposit
        from apps.core.models import DepositRule
        from apps.sales.services import record_deposit_cashed

        DepositRule.objects.create(
            salon=self.salon, name="Prima visita", amount_type="pct", amount=Decimal("30"),
            conditions={"op": "and", "rules": [{"field": "visits", "cmp": "lt", "value": 1}]},
        )
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("30.00"))
        first = self.appointment(
            start=timezone.now() + dt.timedelta(days=5), status="confirmed",
            deposit_status="paid", deposit_amount=Decimal("30"),
        )
        record_deposit_cashed(self.salon, first, method="card")
        # la cliente non è ancora mai venuta: la seconda prenotazione chiede ancora la caparra
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("30.00"))


class RenameLabelProbe(Base):
    def test_renaming_a_label_keeps_deposit_rules_working(self):
        from apps.agenda.services import compute_deposit
        from apps.core.models import DepositRule

        req = staff(self.salon)
        cat = create_category(req, CategoryIn(name="Da seguire"))
        self.client_obj.categories.add(cat)
        DepositRule.objects.create(
            salon=self.salon, name="Da seguire", amount_type="fixed", amount=Decimal("20"),
            conditions={"op": "and", "rules": [{"field": "categories", "cmp": "contains", "value": "Da seguire"}]},
        )
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))
        update_category(req, cat.id, CategoryIn(name="Da seguire!", color=cat.color))
        self.assertEqual(compute_deposit(self.salon, self.client_obj, Decimal("100")), Decimal("20.00"))

    def test_duplicate_label_name_is_a_400_not_a_500(self):
        req = staff(self.salon)
        create_category(req, CategoryIn(name="VIP"))
        try:
            create_category(req, CategoryIn(name="VIP"))
        except HttpError as exc:
            self.assertEqual(exc.status_code, 400)
        # IntegrityError non gestita → 500: il test esce con errore


class HistoryProbe(Base):
    def test_history_without_sales_scope_distinguishes_hidden_from_unpaid(self):
        appt = self.appointment()
        self.checkout(appt, Decimal("50"))
        data = client_history(staff(self.salon, scopes=("clients", "agenda")), self.client_obj.id)
        visit = [e for e in data["entries"] if e["kind"] == "visit"][0]
        print("\n[probe] visita pagata vista da Operatrice -> sale =", visit["sale"], "| chiavi:", sorted(data))
        self.assertTrue(visit["sale"] is not None or "sales_hidden" in data)

    def test_deposit_sale_is_not_a_counter_sale_in_history(self):
        from apps.sales.services import record_deposit_cashed

        appt = self.appointment(deposit_status="paid", deposit_amount=Decimal("30"))
        record_deposit_cashed(self.salon, appt, method="card")
        self.checkout(appt, Decimal("100"), deducted=Decimal("30"))
        data = client_history(staff(self.salon), self.client_obj.id)
        kinds = [e["kind"] for e in data["entries"]]
        print("\n[probe] storico con caparra ->", kinds, data["counts"])
        self.assertNotIn("sale", kinds)


class ArchivedProbe(Base):
    def test_archived_client_can_be_found_or_re_added(self):
        req = staff(self.salon)
        delete_client(req, self.client_obj.id)
        found = list_clients(req, q="333 111 2233", is_active=True)
        print("\n[probe] ricerca archiviata (is_active=True come la dashboard) ->", found["count"])
        try:
            create_client(req, ClientIn(first_name="Anna", last_name="Verdi", phone="+39 333 111 2233"))
        except HttpError as exc:
            self.fail(f"vicolo cieco: ricerca {found['count']} risultati, creazione {exc.status_code} {exc.message}")


class StaleConsentsProbe(Base):
    def test_dashboard_put_does_not_undo_what_the_client_changed_in_the_app(self):
        from apps.accounts.api import client_update_me
        from apps.accounts.schemas import ClientMeIn

        stale = Client.objects.get(pk=self.client_obj.pk)  # scheda aperta in dashboard
        # la cliente, dall'app (Profilo), passa all'inglese e spegne i promemoria WhatsApp
        client_update_me(
            SimpleNamespace(auth=ClientContext(client=Client.objects.get(pk=self.client_obj.pk), salon=self.salon)),
            ClientMeIn(lang="en", whatsapp_reminders=False),
        )
        vip = ClientCategory.objects.create(salon=self.salon, name="VIP")
        # corpo di toClientIn(prev, {category_ids}) come lo manda ClientProfile.updateClient
        body = ClientIn(
            first_name=stale.first_name, last_name=stale.last_name, phone=stale.phone, email=stale.email,
            wa=stale.wa, lang=stale.lang, category_ids=[vip.id], reliability=stale.reliability,
            origin=stale.origin, gender=stale.gender, birthday=None, since=stale.since,
            consents=dict(stale.consents), whatsapp_reminders=stale.whatsapp_reminders,
            deposit_always=stale.deposit_always, is_active=stale.is_active,
        )
        update_client(staff(self.salon), self.client_obj.id, body)
        after = Client.objects.get(pk=self.client_obj.pk)
        print("\n[probe] dopo la PUT della dashboard -> lang", after.lang, "whatsapp_reminders", after.whatsapp_reminders)
        self.assertEqual(after.lang, "en")
        self.assertFalse(after.whatsapp_reminders)


class PhoneProbe(TestCase):
    def test_foreign_number_without_plus_like_frontend(self):
        # frontend normalizePhone('380501234567') === '+380501234567'
        for raw, expected in [
            ("380501234567", "+380501234567"),
            ("355691234567", "+355691234567"),
            ("212612345678", "+212612345678"),
            ("5511912345678", "+5511912345678"),
        ]:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_phone(raw), expected)

    def test_double_italian_prefix_is_the_same_person(self):
        self.assertEqual(phone_key("+39 39 333 1234567"), phone_key("+39 333 1234567"))


class ImportProbe(Base):
    def test_feb_29_of_a_common_year_does_not_drop_the_client(self):
        res = import_rows(self.salon, [{"first_name": "Bea", "phone": "3339990000", "birthday": "1990-02-29"}])
        print("\n[probe] import 29/02/1990 ->", res)
        self.assertEqual(res["created"], 1)

    def test_reimport_does_not_duplicate_notes(self):
        row = {"first_name": "Carla", "phone": "3338887777", "note": "Allergia al nichel"}
        import_rows(self.salon, [row])
        import_rows(self.salon, [row])
        n = ClientNote.objects.filter(client__phone="+393338887777").count()
        print("\n[probe] note dopo due import dello stesso file ->", n)
        self.assertEqual(n, 1)

    def test_phoneless_row_with_shared_email_does_not_rename_someone_else(self):
        res = import_rows(self.salon, [
            {"first_name": "Mamma", "last_name": "Rossi", "phone": "3337776666", "email": "famiglia@rossi.it"},
            {"first_name": "Figlia", "last_name": "Rossi", "phone": "", "email": "famiglia@rossi.it"},
        ])
        mamma = Client.objects.get(phone="+393337776666")
        print("\n[probe] riga senza telefono con email condivisa ->", res, "| scheda:", mamma.full_name)
        self.assertEqual(mamma.first_name, "Mamma")

    def test_yearless_birthday_in_file_does_not_erase_the_known_year(self):
        self.client_obj.birthday = dt.date(1990, 3, 15)
        self.client_obj.save()
        import_rows(self.salon, [{"first_name": "Anna", "phone": "+393331112233", "birthday": "--03-15"}])
        c = Client.objects.get(pk=self.client_obj.pk)
        print("\n[probe] compleanno dopo import senza anno ->", c.birthday, c.birthday_year_known)
        self.assertTrue(c.birthday_year_known)


class SearchProbe(Base):
    def test_search_ignores_accents(self):
        Client.objects.create(salon=self.salon, first_name="Nicolò", last_name="Bellò", phone="+393330001234")
        res = list_clients(staff(self.salon), q="nicolo")
        print("\n[probe] ricerca 'nicolo' ->", res["count"])
        self.assertEqual(res["count"], 1)


class CheckDuplicatesProbe(Base):
    def test_command_runs_on_real_duplicates(self):
        from io import StringIO

        from django.core.management import call_command

        other = Client.objects.create(salon=self.salon, first_name="Dup", phone="+393339998888")
        # doppione «storico»: stesso numero scritto diversamente, phone_key lasciata vecchia
        Client.objects.filter(pk=other.pk).update(phone="333 111 2233")
        self.appointment()
        out = StringIO()
        with self.assertRaises(SystemExit):
            call_command("check_phone_duplicates", stdout=out)
        print("\n[probe] check_phone_duplicates ->\n" + out.getvalue()[:600])


import shutil as _shutil
import tempfile as _tempfile

from django.conf import settings as _settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings


@override_settings(MEDIA_ROOT=_tempfile.mkdtemp(prefix="probe06-media-"))
class SheetPhotoProbe(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, Role, User
        from common.auth import create_staff_tokens

        self.salon = Salon.objects.create(name="Probe", slug="probe")
        user = User.objects.create_user(email="p06@probe.it", password="x" * 10)
        role = Role.objects.create(salon=self.salon, name="Operatrice", scopes=["agenda", "clients"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=False)
        self.auth = {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}
        self.c = Client.objects.create(salon=self.salon, first_name="Sofia", phone="+393331110000")

    def tearDown(self):
        _shutil.rmtree(_settings.MEDIA_ROOT, ignore_errors=True)

    def test_sheet_photo_url_is_usable(self):
        res = self.client.post(
            f"/api/clients/{self.c.id}/sheets",
            data={"category": "hair", "treatment": "Colore"}, content_type="application/json", **self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        sheet_id = res.json()["id"]
        png = SimpleUploadedFile("dopo.png", b"\x89PNG\r\n\x1a\n" + b"1" * 64, content_type="image/png")
        up = self.client.post(f"/api/clients/{self.c.id}/sheets/{sheet_id}/photo", data={"photo": png}, **self.auth)
        self.assertEqual(up.status_code, 200, up.content)
        after_upload = up.json()["photo"]
        listed = self.client.get(f"/api/clients/{self.c.id}/sheets", **self.auth).json()[0]["photo"]
        history = self.client.get(f"/api/clients/{self.c.id}/history", **self.auth).json()
        in_history = [e for e in history["entries"] if e["kind"] == "sheet"][0]["sheet"]["photo"]
        print("\n[probe] foto scheda: upload ->", after_upload, "| lista ->", listed, "| storico ->", in_history)
        print("[probe] GET lista ->", self.client.get(listed).status_code, "| GET storico ->", self.client.get(in_history).status_code)
        self.assertEqual(self.client.get(listed).status_code, 200)
