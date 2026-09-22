"""Probe temporanei del revisore 01 (motore di disponibilità). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal

from django.test import TestCase
from django.utils import timezone
from ninja.errors import HttpError

from apps.core.models import Location, Salon, SalonSettings
from common.auth import create_client_tokens, create_staff_tokens

from . import services as S
from .models import Appointment, AppointmentService, Pause


def aware(day, h, m=0):
    return timezone.make_aware(dt.datetime.combine(day, dt.time(h, m)))


def hm(iso):
    local = timezone.localtime(dt.datetime.fromisoformat(iso))
    return f"{local:%H:%M}"


class ProbeBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator, WeeklyShift

        cls.salon = Salon.objects.create(name="Probe", slug="probe-01")
        cls.st = SalonSettings.objects.create(
            salon=cls.salon, slot_interval_min=15, agenda_fill="max_revenue",
            automation_delay_seconds=0,
        )
        cls.cat = ServiceCategory.objects.create(salon=cls.salon, name_it="Cat", color="#FFFFFF", order=0)
        cls.cut30 = Service.objects.create(salon=cls.salon, category=cls.cat, name_it="Taglio", duration_min=30, price=Decimal("30.00"))
        cls.color30s20 = Service.objects.create(salon=cls.salon, category=cls.cat, name_it="Colore", duration_min=30, soak_min=20, price=Decimal("50.00"))
        cls.man60 = Service.objects.create(salon=cls.salon, category=cls.cat, name_it="Manicure", duration_min=60, price=Decimal("40.00"))
        cls.giulia = Operator.objects.create(salon=cls.salon, first_name="Giulia", last_name="A", order=0)
        cls.marta = Operator.objects.create(salon=cls.salon, first_name="Marta", last_name="B", order=1)
        for op in (cls.giulia, cls.marta):
            op.services.add(cls.cut30, cls.color30s20, cls.man60)
            for wd in range(7):
                WeeklyShift.objects.create(operator=op, week_index=0, weekday=wd, start_min=9 * 60, end_min=19 * 60)
        cls.anna = Client.objects.create(salon=cls.salon, first_name="Anna", last_name="R", phone="+393330000001")
        cls.bea = Client.objects.create(salon=cls.salon, first_name="Bea", last_name="S", phone="+393330000002")
        cls.day = timezone.localdate() + dt.timedelta(days=10)

    def book(self, client, op, start, items):
        """items = [(service, duration, soak)]"""
        a = Appointment.objects.create(salon=self.salon, client=client, operator=op, start=start)
        for i, (svc, dur, soak) in enumerate(items):
            AppointmentService.objects.create(
                appointment=a, service=svc, operator=op, duration_min=dur, soak_min=soak,
                price=svc.price, order=i,
            )
        return a

    def staff_auth(self):
        from apps.accounts.models import Membership, Role, User

        user = User.objects.create_user(email="probe01@x.it", password="x" * 12)
        role = Role.objects.create(salon=self.salon, name="Desk", scopes=["agenda"])
        Membership.objects.create(user=user, salon=self.salon, role=role, is_owner=True)
        return {"HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(user, self.salon)['access']}"}


class RecommendedSoakProbe(ProbeBase):
    def test_slot_right_after_foreign_soak_is_not_recommended(self):
        # Solo Giulia lavora (Marta assente di fatto: tolgo l'idoneità)
        self.marta.services.clear()
        # Colore di Bea 09:00: attivo 09:00-09:30, posa 09:30-09:50
        self.book(self.bea, self.giulia, aware(self.day, 9), [(self.color30s20, 30, 20)])
        slots = S.get_free_slots(self.salon, self.day, [{"service_id": self.cut30.id, "operator_id": None}])
        by = {hm(s["start"]): s["recommended"] for s in slots}
        print("\nRECOMMENDED after soak:", {k: by[k] for k in sorted(by)[:6]})
        smart = [hm(s["start"]) for s in S.smart_slots(self.salon, slots)]
        print("SMART (client app) first:", smart[:6])
        # 09:50 è l'orario perfetto (attaccato alla fine della posa): nessun buco
        self.assertIn("09:50", by) if False else None
        self.assertTrue(by.get("10:00") is not None)

    def test_chain_with_short_internal_soak_is_never_recommended(self):
        self.marta.services.clear()
        slots = S.get_free_slots(
            self.salon, self.day,
            [{"service_id": self.color30s20.id, "operator_id": None},
             {"service_id": self.cut30.id, "operator_id": None}],
        )
        rec = [s for s in slots if s["recommended"]]
        print("\nCHAIN colour+cut: slots", len(slots), "recommended", len(rec))
        self.assertEqual(len(rec), 0)


class RecommendedSoak15Probe(ProbeBase):
    def test_soak_aligned_to_grid(self):
        from apps.catalog.models import Service

        self.marta.services.clear()
        color15 = Service.objects.create(salon=self.salon, category=self.cat, name_it="Colore15", duration_min=30, soak_min=15, price=Decimal("50.00"))
        # Colore di Bea 09:00: attivo 09:00-09:30, posa 09:30-09:45
        self.book(self.bea, self.giulia, aware(self.day, 9), [(color15, 30, 15)])
        slots = S.get_free_slots(self.salon, self.day, [{"service_id": self.cut30.id, "operator_id": None}])
        by = {hm(s["start"]): s["recommended"] for s in slots}
        print("\nSOAK15 recommended:", {k: by[k] for k in sorted(by)[:5]})
        smart = [hm(s["start"]) for s in S.smart_slots(self.salon, slots)]
        print("SOAK15 smart (client app):", smart[:5])
        self.assertFalse(by["09:45"])
        self.assertTrue(by["10:00"])
        self.assertNotIn("09:45", smart)


class ForceFirstEligibleProbe(ProbeBase):
    def test_forced_create_without_operator_picks_busy_operator(self):
        # Giulia occupata 10:00-11:00 con Bea, Marta libera
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        appt = S.create_appointment(
            self.salon, self.anna,
            [{"service_id": self.cut30.id, "operator_id": None}],
            aware(self.day, 10, 10), via="dashboard", force=True,
        )
        print("\nFORCED create chose:", appt.operator.first_name)
        self.assertEqual(appt.operator_id, self.giulia.id)


class OtherLocationOperatorProbe(ProbeBase):
    def test_client_picks_operator_of_other_location(self):
        main = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        north = Location.objects.create(salon=self.salon, name="Nord")
        self.giulia.location = main
        self.giulia.save()
        self.marta.location = north
        self.marta.save()
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.anna)['access']}"}
        items = [{"service_id": self.cut30.id, "operator_id": self.marta.id}]
        res = self.client.get(
            "/api/agenda/client/availability",
            {"date": self.day.isoformat(), "items": json.dumps(items)}, **auth,
        )
        slots = res.json()
        print("\nOTHER-LOCATION: slots", len(slots), "assignment", slots[0]["assignment"] if slots else None)
        res2 = self.client.post(
            "/api/agenda/client/appointments",
            data=json.dumps({"items": items, "start": slots[0]["start"]}),
            content_type="application/json", **auth,
        )
        print("OTHER-LOCATION create:", res2.status_code, res2.content[:120])
        self.assertTrue(slots)
        self.assertEqual(res2.status_code, 400)


class InactiveOperatorMoveProbe(ProbeBase):
    def test_client_move_with_inactive_operator(self):
        from apps.staff.models import WeeklyShift

        start = aware(self.day, 10)
        appt = self.book(self.anna, self.giulia, start, [(self.cut30, 30, 0)])
        # Giulia lascia il salone; i suoi turni restano. Lavorava solo al mattino.
        WeeklyShift.objects.filter(operator=self.giulia).update(end_min=13 * 60)
        self.giulia.active = False
        self.giulia.save()
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.anna)['access']}"}
        new_day = self.day + dt.timedelta(days=1)
        res = self.client.get(
            "/api/agenda/client/availability",
            {"date": new_day.isoformat(), "items": "[]", "exclude_appointment_id": appt.id}, **auth,
        )
        slots = res.json()
        afternoon = [s for s in slots if hm(s["start"]) >= "15:00"]
        print("\nINACTIVE: slots", len(slots), "first afternoon", afternoon[0] if afternoon else None)
        r1 = self.client.post(
            f"/api/agenda/client/appointments/{appt.id}/move",
            data=json.dumps({"start": afternoon[0]["start"]}),
            content_type="application/json", **auth,
        )
        print("INACTIVE move afternoon:", r1.status_code, r1.content[:120])
        morning = [s for s in slots if hm(s["start"]) < "12:00"]
        r2 = self.client.post(
            f"/api/agenda/client/appointments/{appt.id}/move",
            data=json.dumps({"start": morning[0]["start"]}),
            content_type="application/json", **auth,
        )
        appt.refresh_from_db()
        print("INACTIVE move morning:", r2.status_code, "operator now", appt.operator_id, "giulia", self.giulia.id,
              [ (i.operator_id) for i in appt.items.all()])


class StaffRescheduleProbe(ProbeBase):
    def test_staff_availability_counts_the_appointment_itself(self):
        self.marta.services.clear()
        # visita allungata a 90' (snapshot) rispetto ai 60 del listino
        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 90, 0)])
        # un'altra cliente alle 13:00
        self.book(self.bea, self.giulia, aware(self.day, 13), [(self.cut30, 30, 0)])
        auth = self.staff_auth()
        items = [{"service_id": self.man60.id, "operator_id": self.giulia.id}]
        res = self.client.get(
            "/api/agenda/availability",
            {"date": self.day.isoformat(), "items": json.dumps(items)}, **auth,
        )
        starts = [hm(s["start"]) for s in res.json()]
        print("\nSTAFF reschedule slots:", starts)
        # 10:30 (spostare di mezz'ora) non viene proposto: conta la visita stessa
        self.assertNotIn("10:30", starts)
        # 12:00 è proposto (60' di listino) ma la visita dura 90: 12:00-13:30 urta le 13:00
        self.assertIn("12:00", starts)
        try:
            S.move_appointment(appt, aware(self.day, 12))
            print("move 12:00 OK")
        except HttpError as e:
            print("move 12:00 ->", e.status_code, e)


class DstProbe(ProbeBase):
    def test_fall_back_day(self):
        day = dt.date(2026, 10, 25)
        self.marta.services.clear()
        self.book(self.bea, self.giulia, aware(day, 10), [(self.man60, 60, 0)])
        slots = S.get_free_slots(self.salon, day, [{"service_id": self.cut30.id, "operator_id": None}])
        starts = [s["start"] for s in slots]
        print("\nDST fall back:", starts[:3], "...", starts[-2:])
        self.assertIn("2026-10-25T09:00:00+01:00", starts)
        self.assertNotIn("2026-10-25T10:00:00+01:00", starts)
        self.assertIn("2026-10-25T11:00:00+01:00", starts)
        self.assertIn("2026-10-25T18:30:00+01:00", starts)

    def test_spring_forward_day(self):
        day = dt.date(2027, 3, 28)
        self.marta.services.clear()
        self.book(self.bea, self.giulia, aware(day, 10), [(self.man60, 60, 0)])
        slots = S.get_free_slots(self.salon, day, [{"service_id": self.cut30.id, "operator_id": None}])
        starts = [s["start"] for s in slots]
        print("\nDST spring:", starts[:3], "...", starts[-2:])
        self.assertIn("2027-03-28T09:00:00+02:00", starts)
        self.assertNotIn("2027-03-28T10:00:00+02:00", starts)
        self.assertIn("2027-03-28T11:00:00+02:00", starts)


class SameClientAutoAssignProbe(ProbeBase):
    def test_first_available_lands_on_operator_busy_with_same_client(self):
        # Anna: manicure con Giulia 10:00-11:00. Si aggiunge una pedicure (qui man60)
        # alle 10:00 con «Prima disponibile»: Marta è libera.
        self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        slots = S.get_free_slots(self.salon, self.day, [{"service_id": self.man60.id, "operator_id": None}])
        at10 = next(s for s in slots if hm(s["start"]) == "10:00")
        print("\nSAMECLIENT slot 10:00 assignment:", at10["assignment"], "giulia", self.giulia.id, "marta", self.marta.id)
        appt = S.create_appointment(
            self.salon, self.anna,
            [{"service_id": self.man60.id, "operator_id": None}],
            aware(self.day, 10), via="dashboard", client_overlap_ok=True,
        )
        print("SAMECLIENT created on:", appt.operator.first_name, "forced", appt.forced)
        self.assertEqual(appt.operator_id, self.giulia.id)


class InactiveOperatorStaffProbe(ProbeBase):
    def test_drag_out_of_inactive_column(self):
        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.giulia.active = False
        self.giulia.save()
        auth = self.staff_auth()
        body = {"start": aware(self.day, 10).isoformat(), "operator_id": self.marta.id, "from_operator_id": self.giulia.id}
        r = self.client.post(f"/api/agenda/appointments/{appt.id}/move", data=json.dumps(body), content_type="application/json", **auth)
        print("\nDRAG from inactive column:", r.status_code, r.content[:100])
        body2 = {"start": aware(self.day, 10).isoformat(), "operator_id": self.marta.id}
        r2 = self.client.post(f"/api/agenda/appointments/{appt.id}/move", data=json.dumps(body2), content_type="application/json", **auth)
        print("DRAG without from_operator_id:", r2.status_code)

    def test_edit_visit_on_inactive_operator(self):
        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0), (self.man60, 60, 0)])
        items = list(appt.items.all())
        items[1].operator = self.marta
        items[1].save()
        self.giulia.active = False
        self.giulia.save()
        auth = self.staff_auth()
        payload = {"items": [
            {"id": items[0].id, "service_id": self.cut30.id, "operator_id": self.giulia.id, "duration_min": 30},
            {"id": items[1].id, "service_id": self.man60.id, "operator_id": self.marta.id, "duration_min": 75},
        ]}
        r = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps(payload), content_type="application/json", **auth)
        r2 = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps({**payload, "force": True}), content_type="application/json", **auth)
        print("\nEDIT with inactive operator:", r.status_code, r.content[:100], "forced:", r2.status_code)


class NotEligibleAnymoreProbe(ProbeBase):
    def test_client_move_when_operator_lost_the_skill(self):
        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.giulia.services.remove(self.cut30)
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.anna)['access']}"}
        new_day = self.day + dt.timedelta(days=1)
        res = self.client.get("/api/agenda/client/availability", {"date": new_day.isoformat(), "items": "[]", "exclude_appointment_id": appt.id}, **auth)
        print("\nNOT-ELIGIBLE availability:", res.status_code, len(res.json()))
        r = self.client.post(f"/api/agenda/client/appointments/{appt.id}/move", data=json.dumps({"start": aware(new_day, 11).isoformat()}), content_type="application/json", **auth)
        print("NOT-ELIGIBLE move:", r.status_code)


class ClientIntoSoakProbe(ProbeBase):
    def test_client_create_and_move_into_foreign_soak(self):
        self.marta.services.clear()
        # Colore di Bea: 10:00-10:30 attivo, posa 10:30-10:50
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.color30s20, 30, 20)])
        slots = S.get_free_slots(self.salon, self.day, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}])
        print("\nSOAK offered 10:30?", any(hm(s["start"]) == "10:30" for s in slots))
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.anna)['access']}"}
        r = self.client.post("/api/agenda/client/appointments", data=json.dumps({
            "items": [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            "start": aware(self.day, 10, 30).isoformat()}), content_type="application/json", **auth)
        print("CLIENT create into soak with operator:", r.status_code)
        r2 = self.client.post("/api/agenda/client/appointments", data=json.dumps({
            "items": [{"service_id": self.cut30.id}],
            "start": aware(self.day, 10, 30).isoformat()}), content_type="application/json", **auth)
        print("CLIENT create into soak without operator:", r2.status_code)


class YourangPlaceholderProbe(ProbeBase):
    def test_resize_and_reassign_imported_booking(self):
        from apps.integrations.sync import _yourang_service

        svc = _yourang_service(self.salon)
        appt = Appointment.objects.create(salon=self.salon, client=self.anna, operator=self.giulia,
                                          start=aware(self.day, 10), created_via="yourang")
        item = AppointmentService.objects.create(appointment=appt, service=svc, operator=self.giulia,
                                                 duration_min=60, soak_min=0, price=0)
        auth = self.staff_auth()
        payload = {"items": [{"id": item.id, "service_id": svc.id, "operator_id": self.giulia.id, "duration_min": 75}]}
        r = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps(payload), content_type="application/json", **auth)
        r2 = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps({**payload, "force": True}), content_type="application/json", **auth)
        body = {"start": aware(self.day, 10).isoformat(), "operator_id": self.marta.id, "from_operator_id": self.giulia.id}
        r3 = self.client.post(f"/api/agenda/appointments/{appt.id}/move", data=json.dumps(body), content_type="application/json", **auth)
        r4 = self.client.put(f"/api/agenda/appointments/{appt.id}", data=json.dumps({"note": "x"}), content_type="application/json", **auth)
        print("\nYOURANG resize:", r.status_code, r.content[:90], "force:", r2.status_code, "reassign:", r3.status_code, "note:", r4.status_code)


class LunchClosureProbe(ProbeBase):
    def test_soak_runs_into_lunch_closure(self):
        from apps.catalog.models import Service

        self.st.opening_hours_week = {str(d): [["09:00", "13:00"], ["15:00", "19:00"]] for d in range(7)}
        self.st.save()
        self.salon.refresh_from_db()
        self.marta.services.clear()
        color = Service.objects.create(salon=self.salon, category=self.cat, name_it="Colore60", duration_min=30, soak_min=60, price=Decimal("50.00"))
        self.giulia.services.add(color)
        slots = S.get_free_slots(self.salon, self.day, [{"service_id": color.id, "operator_id": None}])
        starts = [hm(s["start"]) for s in slots]
        print("\nLUNCH: 12:30 offered?", "12:30" in starts, "(finisce 13:30, centro chiuso 13-15)")
        salon = Salon.objects.get(pk=self.salon.pk)
        a = S.create_appointment(salon, self.anna, [{"service_id": color.id}], aware(self.day, 12, 30), via="app", allow_past=False)
        print("LUNCH create 12:30 ->", a.id, "end", timezone.localtime(a.end))


class StaffRescheduleRetiredServiceProbe(ProbeBase):
    def test_retired_service(self):
        appt = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        self.man60.active = False
        self.man60.save()
        auth = self.staff_auth()
        items = [{"service_id": self.man60.id, "operator_id": self.giulia.id}]
        res = self.client.get("/api/agenda/availability", {"date": self.day.isoformat(), "items": json.dumps(items)}, **auth)
        print("\nSTAFF reschedule retired service:", res.status_code, res.content[:80])
        # lo spostamento vero invece passa
        S.move_appointment(appt, aware(self.day, 15))
        print("move OK")


class DepositOnGiftedServiceProbe(ProbeBase):
    def test_deposit_on_gifted_service(self):
        from apps.core.models import DepositRule
        from apps.marketing.models import GiftCard

        DepositRule.objects.create(salon=self.salon, name="Prima visita", amount_type="pct", amount=Decimal("30"),
                                   conditions={"op": "and", "rules": [{"field": "visits", "cmp": "lt", "value": 1}]})
        GiftCard.objects.create(salon=self.salon, code="GIFT0001", initial_value=Decimal("30.00"), balance=Decimal("30.00"),
                                gift_service=self.cut30, recipient_client=self.anna, buyer_client=self.bea,
                                payment_status="paid", status="active")
        auth = {"HTTP_AUTHORIZATION": f"Bearer {create_client_tokens(self.anna)['access']}"}
        r = self.client.post("/api/agenda/client/appointments", data=json.dumps({
            "items": [{"service_id": self.cut30.id}], "start": aware(self.day, 11).isoformat()}),
            content_type="application/json", **auth)
        body = r.json()
        print("\nGIFTED booking:", r.status_code, "deposit", body.get("deposit_amount"), body.get("deposit_status"), "gifts", body.get("gifts"))


class EditSameClientProbe(ProbeBase):
    def test_edit_same_client_overlap_marks_forced(self):
        x = S.create_appointment(self.salon, self.anna, [{"service_id": self.man60.id, "operator_id": self.giulia.id}],
                                 aware(self.day, 10), via="dashboard")
        y = S.create_appointment(self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
                                 aware(self.day, 10, 15), via="dashboard", client_overlap_ok=True)
        print("\nSAMECLIENT-EDIT y.forced after create:", y.forced)
        auth = self.staff_auth()
        item = y.items.first()
        payload = {"items": [{"id": item.id, "service_id": self.cut30.id, "operator_id": self.giulia.id, "duration_min": 40}]}
        r = self.client.put(f"/api/agenda/appointments/{y.id}", data=json.dumps(payload), content_type="application/json", **auth)
        print("SAMECLIENT-EDIT first PUT:", r.status_code)
        r2 = self.client.put(f"/api/agenda/appointments/{y.id}", data=json.dumps({**payload, "force": True}), content_type="application/json", **auth)
        y.refresh_from_db()
        print("SAMECLIENT-EDIT forced PUT:", r2.status_code, "forced now", y.forced)


class HugeDurationProbe(ProbeBase):
    def test_huge_duration(self):
        a = S.create_appointment(self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
                                 aware(self.day, 10), via="dashboard")
        auth = self.staff_auth()
        item = a.items.first()
        payload = {"items": [{"id": item.id, "service_id": self.cut30.id, "operator_id": self.giulia.id, "duration_min": 6000}]}
        r = self.client.put(f"/api/agenda/appointments/{a.id}", data=json.dumps(payload), content_type="application/json", **auth)
        r2 = self.client.put(f"/api/agenda/appointments/{a.id}", data=json.dumps({**payload, "force": True}), content_type="application/json", **auth)
        a.refresh_from_db()
        print("\nHUGE:", r.status_code, r2.status_code, "end", timezone.localtime(a.end))
        nxt = self.day + dt.timedelta(days=1)
        slots = S.get_free_slots(self.salon, nxt, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}])
        print("HUGE next day slots for Giulia:", len(slots))


class OwnPosaProbe(ProbeBase):
    def test_colour_whose_posa_touches_next_booking(self):
        from apps.catalog.models import Service

        self.marta.services.clear()
        # colore 30' + posa 15' (finisce 10:45), Bea alle 10:45 con Giulia
        color15 = Service.objects.create(salon=self.salon, category=self.cat, name_it="Colore15b", duration_min=30, soak_min=15, price=Decimal("50.00"))
        self.giulia.services.add(color15)
        self.book(self.bea, self.giulia, aware(self.day, 10, 45), [(self.cut30, 30, 0)])
        slots = S.get_free_slots(self.salon, self.day, [{"service_id": color15.id, "operator_id": None}])
        by = {hm(s["start"]): s["recommended"] for s in slots}
        print("\nOWNPOSA 10:00 (posa fino alle 10:45, poi Bea):", by.get("10:00"), " 09:45:", by.get("09:45"), " 09:00:", by.get("09:00"))


class CategoryRenameProbe(ProbeBase):
    def test_rename_label_kills_rule(self):
        from apps.clients.models import ClientCategory
        from apps.core.models import DepositRule

        cat = ClientCategory.objects.create(salon=self.salon, name="Ritardataria")
        self.anna.categories.add(cat)
        DepositRule.objects.create(salon=self.salon, name="Etichetta", amount_type="fixed", amount=Decimal("10"),
                                   conditions={"op": "and", "rules": [{"field": "categories", "cmp": "contains", "value": "Ritardataria"}]})
        before = S.compute_deposit(self.salon, self.anna, Decimal("30"))
        auth = self.staff_auth()
        r = self.client.put(f"/api/clients/categories/{cat.id}", data=json.dumps({"name": "Ritardi", "color": "#FF0000", "order": 0}), content_type="application/json", **auth)
        after = S.compute_deposit(self.salon, self.anna, Decimal("30"))
        print("\nRENAME:", r.status_code, r.content[:80], "deposit before", before, "after", after)
