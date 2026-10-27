"""Chiave per n8n/Make/Zapier: lo strumento esterno legge gli appuntamenti in arrivo."""

import datetime as dt
from urllib.parse import urlencode

from django.utils import timezone

from apps.agenda.models import Appointment
from apps.agenda.tests.base import RealShiftsTestBase
from apps.clients.models import Client
from apps.core.models import Salon
from apps.integrations import automation_key
from common.testing import aware

URL = "/api/integrations/automation/appointments"


class AutomationKeyTest(RealShiftsTestBase):
    def setUp(self):
        self.key = automation_key.rotate_key(self.salon, None)

    def fetch(self, start, end, key=None):
        query = urlencode({"start": start.isoformat(), "end": end.isoformat()})
        return self.client.get(f"{URL}?{query}", HTTP_AUTHORIZATION=f"Bearer {key or self.key}")

    def test_lists_appointments_in_window_with_services_and_phone(self):
        inside = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.book(self.bea, self.giulia, aware(self.day, 11), [(self.man60, 60, 0)])  # fuori: end escluso

        response = self.fetch(aware(self.day, 10), aware(self.day, 11))

        self.assertEqual(response.status_code, 200)
        [row] = response.json()
        self.assertEqual(row["appointment_id"], inside.id)
        self.assertEqual(row["phone"], "+393330000001")
        self.assertEqual(row["services"][0]["name"], "Taglio")
        self.assertEqual(row["services"][0]["id"], self.cut30.id)

    def test_cancelled_and_no_show_are_left_out(self):
        for hour, status in ((10, Appointment.Status.CANCELLED), (11, Appointment.Status.NO_SHOW)):
            appointment = self.book(self.anna, self.giulia, aware(self.day, hour), [(self.cut30, 30, 0)])
            Appointment.objects.filter(pk=appointment.pk).update(status=status)

        self.assertEqual(self.fetch(aware(self.day, 9), aware(self.day, 12)).json(), [])

    def test_a_key_sees_only_its_own_salon(self):
        # La chiave di un altro salone non deve leggere l'agenda di questo.
        other = Salon.objects.create(name="Altro", slug="altro-automation")
        Client.objects.create(salon=other, first_name="X", last_name="Y", phone="+393330000009")
        other_key = automation_key.rotate_key(other, None)
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])

        self.assertEqual(self.fetch(aware(self.day, 9), aware(self.day, 12), key=other_key).json(), [])

    def test_wrong_rotated_or_revoked_key_is_refused(self):
        start, end = aware(self.day, 9), aware(self.day, 12)
        self.assertEqual(self.fetch(start, end, key="yta_sbagliata").status_code, 401)

        old = self.key
        self.key = automation_key.rotate_key(self.salon, None)
        self.assertEqual(self.fetch(start, end, key=old).status_code, 401)
        self.assertEqual(self.fetch(start, end).status_code, 200)

        automation_key.revoke_key(self.salon, None)
        self.assertEqual(self.fetch(start, end).status_code, 401)

    def test_window_over_seven_days_or_malformed_is_rejected(self):
        start = aware(self.day, 9)
        self.assertEqual(self.fetch(start, start - dt.timedelta(hours=1)).status_code, 400)
        self.assertEqual(self.fetch(start, start + dt.timedelta(days=8)).status_code, 400)
        response = self.client.get(f"{URL}?start=ieri&end=oggi", HTTP_AUTHORIZATION=f"Bearer {self.key}")
        self.assertEqual(response.status_code, 400)

    def test_managing_the_key_needs_the_integrations_permission(self):
        desk = self.staff_auth(("agenda",))
        self.assertEqual(self.client.post("/api/integrations/automation/key", **desk).status_code, 403)

        tech = self.staff_auth(("integrations",), email="tech@caccia22.it")
        response = self.client.post("/api/integrations/automation/key", **tech)
        self.assertEqual(response.status_code, 200)
        new_key = response.json()["key"]
        self.assertTrue(new_key.startswith("yta_"))
        # La chiave si vede solo alla generazione.
        self.assertIsNone(self.client.get("/api/integrations/automation/key", **tech).json()["key"])
        self.assertEqual(self.fetch(aware(self.day, 9), aware(self.day, 12), key=new_key).status_code, 200)


class AutomationBirthdaysTest(RealShiftsTestBase):
    """Gli auguri di compleanno: chi compie gli anni il giorno chiesto."""

    def setUp(self):
        self.key = automation_key.rotate_key(self.salon, None)

    def fetch(self, date=None, key=None):
        query = f"?date={date}" if date else ""
        return self.client.get(
            f"/api/integrations/automation/birthdays{query}",
            HTTP_AUTHORIZATION=f"Bearer {key or self.key}",
        )

    def test_appointment_rows_carry_the_birthday(self):
        Client.objects.filter(pk=self.anna.pk).update(birthday=dt.date(1990, 5, 14))
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        query = urlencode({"start": aware(self.day, 9).isoformat(), "end": aware(self.day, 12).isoformat()})
        [row] = self.client.get(f"{URL}?{query}", HTTP_AUTHORIZATION=f"Bearer {self.key}").json()
        self.assertEqual(row["birthday"], "1990-05-14")

    def test_lists_only_active_clients_of_this_salon_born_that_day(self):
        Client.objects.filter(pk=self.anna.pk).update(
            birthday=dt.date(1990, 5, 14), consents={"marketing": True}
        )
        Client.objects.filter(pk=self.bea.pk).update(birthday=dt.date(1985, 5, 15))
        Client.objects.create(
            salon=self.salon, first_name="Ex", phone="+393330000077",
            birthday=dt.date(1990, 5, 14), is_active=False,
        )
        other = Salon.objects.create(name="Altro", slug="altro-birthday")
        Client.objects.create(salon=other, first_name="X", phone="+393330000078", birthday=dt.date(1990, 5, 14))

        response = self.fetch("2027-05-14")

        self.assertEqual(response.status_code, 200)
        [row] = response.json()
        self.assertEqual(row["client_id"], self.anna.id)
        self.assertEqual(row["phone"], "+393330000001")
        self.assertEqual(row["birthday"], "1990-05-14")
        self.assertTrue(row["marketing"])
        self.assertEqual(self.fetch("2027-05-16").json(), [])

    def test_year_unknown_and_leap_day(self):
        Client.objects.filter(pk=self.anna.pk).update(
            birthday=dt.date(Client.BIRTHDAY_YEAR_UNKNOWN, 2, 29), birthday_year_known=False
        )
        # Anno non bisestile: chi è nata il 29 compare il 28.
        [row] = self.fetch("2027-02-28").json()
        self.assertEqual(row["birthday"], "--02-29")
        self.assertFalse(row["marketing"])
        # Anno bisestile: il 28 no, il 29 sì.
        self.assertEqual(self.fetch("2028-02-28").json(), [])
        self.assertEqual(len(self.fetch("2028-02-29").json()), 1)

    def test_defaults_to_today_and_rejects_bad_input(self):
        today = timezone.localdate()
        # 2000 è bisestile: vale anche se oggi è il 29 febbraio.
        Client.objects.filter(pk=self.anna.pk).update(birthday=today.replace(year=2000))
        self.assertEqual([r["client_id"] for r in self.fetch().json()], [self.anna.id])
        self.assertEqual(self.fetch("ieri").status_code, 400)
        self.assertEqual(self.fetch(key="yta_sbagliata").status_code, 401)


class AutomationFirstTimeTest(RealShiftsTestBase):
    """Prima visita al salone e prima volta di ogni trattamento."""

    def setUp(self):
        self.key = automation_key.rotate_key(self.salon, None)

    def rows(self):
        query = urlencode({"start": aware(self.day, 0).isoformat(), "end": aware(self.day, 23).isoformat()})
        response = self.client.get(f"{URL}?{query}", HTTP_AUTHORIZATION=f"Bearer {self.key}")
        return {r["appointment_id"]: r for r in response.json()}

    @staticmethod
    def flags(row):
        return row["first_visit"], [s["first_time"] for s in row["services"]]

    def test_first_visit_then_only_the_new_treatment_is_a_first(self):
        first = self.book(self.anna, self.giulia, aware(self.day, 9), [(self.cut30, 30, 0)])
        second = self.book(self.anna, self.giulia, aware(self.day, 14), [(self.cut30, 30, 0), (self.man60, 60, 0)])

        rows = self.rows()

        self.assertEqual(self.flags(rows[first.id]), (True, [True]))
        self.assertEqual(self.flags(rows[second.id]), (False, [False, True]))

    def test_cancelled_and_no_show_visits_do_not_count_as_history(self):
        for hour, status in ((9, Appointment.Status.CANCELLED), (10, Appointment.Status.NO_SHOW)):
            gone = self.book(self.anna, self.giulia, aware(self.day, hour), [(self.cut30, 30, 0)])
            Appointment.objects.filter(pk=gone.pk).update(status=status)
        real = self.book(self.anna, self.giulia, aware(self.day, 14), [(self.cut30, 30, 0)])

        self.assertEqual(self.flags(self.rows()[real.id]), (True, [True]))

    def test_imported_or_long_standing_client_is_never_a_first_and_new_treatment_is_unknown(self):
        earlier = self.book(self.bea, self.giulia, aware(self.day, 9), [(self.cut30, 30, 0)])
        later = self.book(self.bea, self.giulia, aware(self.day, 14), [(self.cut30, 30, 0), (self.man60, 60, 0)])
        for origin, since in (("Import", None), ("Yourang", None), ("", self.day - dt.timedelta(days=400))):
            Client.objects.filter(pk=self.bea.pk).update(origin=origin, since=since)
            rows = self.rows()
            self.assertEqual(self.flags(rows[earlier.id]), (False, [None]), origin)
            # Il taglio lo ha fatto qui: quello si sa. La manicure no.
            self.assertEqual(self.flags(rows[later.id]), (False, [False, None]), origin)
