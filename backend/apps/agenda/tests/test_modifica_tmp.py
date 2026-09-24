"""Caccia del 22/09: modifica (PUT) e riassegnazione delle visite dello staff."""

import datetime as dt

from django.utils import timezone
from ninja.errors import HttpError

from .. import services as S
from ..models import Appointment
from .test_disponibilita_tmp import Caccia22Base, aware


class EditBase(Caccia22Base):
    def setUp(self):
        self.auth = self.staff_auth()

    def edit(self, appointment, body):
        return self.put(f"/api/agenda/appointments/{appointment.id}", body, self.auth)

    @staticmethod
    def rows(appointment, changes=None):
        """Le righe della visita come le rimanda il pannello, con ritocchi {id riga: campi}."""
        out = []
        for item in appointment.items.order_by("order", "id"):
            row = {
                "id": item.id, "service_id": item.service_id,
                "operator_id": item.operator_id, "duration_min": item.duration_min,
            }
            row.update((changes or {}).get(item.id, {}))
            out.append(row)
        return out


# ---- 01-06 + 12-12 + 13-13 + 17-10: la riga esistente tiene la sua operatrice --


class ExistingRowKeepsItsOperatorTests(EditBase):
    def _visit(self):
        return self.book(
            self.anna, self.giulia, aware(self.day, 10),
            [(self.cut30, 30, 0), (self.man60, 60, 0, self.marta)],
        )

    def test_resizing_next_to_a_row_of_a_deactivated_operator(self):
        visit = self._visit()
        cut, man = visit.items.order_by("order")
        self.giulia.active = False
        self.giulia.save(update_fields=["active"])
        res = self.edit(visit, {"items": self.rows(visit, {man.id: {"duration_min": 75}})})
        # prima: 400 «Operatrice non idonea», anche forzando
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["forced"])
        self.assertEqual(
            [(i["operator_id"], i["duration_min"]) for i in res.json()["items"]],
            [(self.giulia.id, 30), (self.marta.id, 75)],
        )

    def test_resizing_a_row_whose_operator_lost_the_skill(self):
        visit = self._visit()
        cut, _man = visit.items.order_by("order")
        self.giulia.services.remove(self.cut30)
        res = self.edit(visit, {"items": self.rows(visit, {cut.id: {"duration_min": 45}})})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["items"][0]["operator_id"], self.giulia.id)

    def test_a_row_of_an_operator_of_another_location(self):
        from apps.core.models import Location

        centro = Location.objects.create(salon=self.salon, name="Centro", is_default=True)
        nord = Location.objects.create(salon=self.salon, name="Nord")
        visit = self._visit()
        visit.location = centro
        visit.save(update_fields=["location"])
        self.giulia.location = nord
        self.giulia.save(update_fields=["location"])
        res = self.edit(visit, {"items": self.rows(visit), "note": "allergia alla tinta"})
        self.assertEqual(res.status_code, 200, res.content)

    def test_new_assignments_are_still_checked(self):
        visit = self._visit()
        cut, man = visit.items.order_by("order")
        self.giulia.active = False
        self.giulia.save(update_fields=["active"])
        # la manicure di Marta passata a Giulia (disattivata): nuova assegnazione
        res = self.edit(visit, {"items": self.rows(visit, {man.id: {"operator_id": self.giulia.id}}), "force": True})
        self.assertEqual(res.status_code, 400, res.content)
        # un servizio aggiunto a Giulia: idem
        extra = self.rows(visit) + [{"service_id": self.cut30.id, "operator_id": self.giulia.id}]
        self.assertEqual(self.edit(visit, {"items": extra, "force": True}).status_code, 400)
        # e chi non ha mai saputo fare il servizio non lo riceve
        self.marta.services.remove(self.cut30)
        swapped = self.rows(visit, {cut.id: {"operator_id": self.marta.id}})
        self.assertEqual(self.edit(visit, {"items": swapped, "force": True}).status_code, 400)


class ReassignFromInactiveColumnTests(EditBase):
    """Lato API di 01-06: la colonna di partenza può essere di un'operatrice disattivata."""

    def test_drag_out_of_the_inactive_column(self):
        visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.giulia.active = False
        self.giulia.save(update_fields=["active"])
        res = self.post(
            f"/api/agenda/appointments/{visit.id}/move",
            {"start": aware(self.day, 10).isoformat(), "operator_id": self.marta.id,
             "from_operator_id": self.giulia.id},
            self.auth,
        )
        self.assertEqual(res.status_code, 200, res.content)
        visit.refresh_from_db()
        self.assertEqual(visit.operator_id, self.marta.id)
        self.assertEqual(list(visit.items.values_list("operator_id", flat=True)), [self.marta.id])

    def test_the_target_must_still_be_active(self):
        visit = self.book(self.anna, self.giulia, aware(self.day, 10), [(self.cut30, 30, 0)])
        self.marta.active = False
        self.marta.save(update_fields=["active"])
        res = self.post(
            f"/api/agenda/appointments/{visit.id}/move",
            {"start": aware(self.day, 10).isoformat(), "operator_id": self.marta.id,
             "from_operator_id": self.giulia.id},
            self.auth,
        )
        self.assertEqual(res.status_code, 404, res.content)


# ---- 01-12 + 02-20: accanto alla stessa cliente non è una forzatura ----------


class EditNextToTheSameClientTests(EditBase):
    def test_stretching_next_to_the_same_client_is_not_forced(self):
        S.create_appointment(
            self.salon, self.anna, [{"service_id": self.man60.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )
        nail_art = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10, 15), via="dashboard", client_overlap_ok=True,
        )
        item = nail_art.items.get()
        res = self.edit(nail_art, {"items": self.rows(nail_art, {item.id: {"duration_min": 40}})})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.json()["forced"])

    def test_the_service_itself_treats_the_same_client_as_one_session(self):
        # la modifica è sempre un gesto dello staff: anche chiamata direttamente
        S.create_appointment(
            self.salon, self.anna, [{"service_id": self.man60.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )
        second = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10, 30), via="dashboard", client_overlap_ok=True,
        )
        item = second.items.get()
        S.edit_appointment(second, items=[{
            "id": item.id, "service_id": self.cut30.id, "operator_id": self.giulia.id, "duration_min": 40,
        }])
        second.refresh_from_db()
        self.assertFalse(second.forced)
        self.assertEqual(second.items.get().duration_min, 40)

    def test_another_client_still_conflicts(self):
        S.create_appointment(
            self.salon, self.bea, [{"service_id": self.man60.id, "operator_id": self.giulia.id}],
            aware(self.day, 10, 30), via="dashboard",
        )
        visit = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )
        item = visit.items.get()
        res = self.edit(visit, {"items": self.rows(visit, {item.id: {"duration_min": 45}})})
        self.assertEqual(res.status_code, 409, res.content)

    def test_first_available_row_follows_the_full_map(self):
        # Anna ha già Giulia alle 10:30; una voce nuova «prima disponibile» che
        # cade lì va a Marta, libera, e non sopra la stessa cliente.
        S.create_appointment(
            self.salon, self.anna, [{"service_id": self.man60.id, "operator_id": self.giulia.id}],
            aware(self.day, 10, 30), via="dashboard",
        )
        visit = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )
        items = self.rows(visit) + [{"service_id": self.cut30.id, "operator_id": None}]
        res = self.edit(visit, {"items": items})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["items"][1]["operator_id"], self.marta.id)


# ---- 01-14 + 04-11: durata con un tetto ---------------------------------------


class DurationBoundsTests(EditBase):
    def test_absurd_durations_are_rejected_before_anything_else(self):
        visit = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )
        item = visit.items.get()
        for value in (6000, 0, -5, 2**40):
            res = self.edit(visit, {"items": self.rows(visit, {item.id: {"duration_min": value}}), "force": True})
            self.assertEqual(res.status_code, 422, (value, res.content))
        self.assertEqual(visit.items.get().duration_min, 30)
        ok = self.edit(visit, {"items": self.rows(visit, {item.id: {"duration_min": 45}})})
        self.assertEqual(ok.status_code, 200, ok.content)


# ---- 04-10: servizio senza operatrici abilitate --------------------------------


class NoEligibleOperatorTests(EditBase):
    def setUp(self):
        from apps.catalog.models import Service

        super().setUp()
        self.nuovo = Service.objects.create(
            salon=self.salon, category=self.cat, name_it="Nuovo", duration_min=30, price="20.00",
        )

    def test_put_adding_a_service_nobody_does_is_400_even_forcing(self):
        visit = S.create_appointment(
            self.salon, self.anna, [{"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )
        items = self.rows(visit) + [{"service_id": self.nuovo.id, "operator_id": None}]
        for force in (False, True):
            res = self.edit(visit, {"items": items, "force": force})
            self.assertEqual(res.status_code, 400, res.content)
            self.assertEqual(res.json()["detail"], "Nessuna operatrice abilitata al servizio selezionato")

    def test_eligibility_is_checked_before_availability(self):
        # la prima voce non starebbe in piedi (409), ma il problema vero è la
        # seconda: il banco deve saperlo subito, non dopo un ritentativo forzato
        self.book(self.bea, self.giulia, aware(self.day, 10), [(self.man60, 60, 0)])
        with self.assertRaises(HttpError) as caught:
            S.create_appointment(
                self.salon, self.anna,
                [{"service_id": self.cut30.id, "operator_id": self.giulia.id},
                 {"service_id": self.nuovo.id, "operator_id": None}],
                aware(self.day, 10), via="dashboard",
            )
        self.assertEqual(caught.exception.status_code, 400)

    def test_create_without_force_is_400_too(self):
        res = self.post(
            "/api/agenda/appointments",
            {"client_id": self.anna.id, "items": [{"service_id": self.nuovo.id}],
             "start": aware(self.day, 10).isoformat()},
            self.auth,
        )
        self.assertEqual(res.status_code, 400, res.content)


# ---- 13-03 + 18-06 + 03-13 (C2): versione della visita nel PUT ----------------


class StaleCopyTests(EditBase):
    MESSAGE = "L'appuntamento è stato modificato nel frattempo: ricarica e riprova"

    def _visit(self):
        return S.create_appointment(
            self.salon, self.anna,
            [{"service_id": self.color30s20.id, "operator_id": self.giulia.id},
             {"service_id": self.cut30.id, "operator_id": self.giulia.id}],
            aware(self.day, 10), via="dashboard",
        )

    def test_the_appointment_carries_its_version(self):
        visit = self._visit()
        body = self.client.get(f"/api/agenda/appointments/{visit.id}", **self.auth).json()
        self.assertIn("updated_at", body)
        self.assertIsNotNone(body["updated_at"])

    def test_the_version_just_read_is_accepted_and_chained_edits_work(self):
        visit = self._visit()
        version = self.client.get(f"/api/agenda/appointments/{visit.id}", **self.auth).json()["updated_at"]
        first = self.edit(visit, {"note": "prima", "expected_updated_at": version})
        self.assertEqual(first.status_code, 200, first.content)
        # la risposta porta la versione nuova, e con quella si scrive ancora
        second = self.edit(visit, {"note": "seconda", "expected_updated_at": first.json()["updated_at"]})
        self.assertEqual(second.status_code, 200, second.content)

    def test_an_old_version_is_412_even_forcing(self):
        visit = self._visit()
        # (la copia del pannello è di qualche secondo fa: al millesimo, due
        # scritture nello stesso istante sarebbero indistinguibili)
        Appointment.objects.filter(pk=visit.pk).update(
            updated_at=timezone.now() - dt.timedelta(seconds=5)
        )
        version = self.client.get(f"/api/agenda/appointments/{visit.id}", **self.auth).json()["updated_at"]
        # nel frattempo un'altra postazione sposta la visita
        moved = self.post(
            f"/api/agenda/appointments/{visit.id}/move",
            {"start": aware(self.day, 14).isoformat()}, self.auth,
        )
        self.assertEqual(moved.status_code, 200, moved.content)
        stale = self.rows(visit)
        for force in (False, True):
            res = self.edit(visit, {"items": stale, "expected_updated_at": version, "force": force})
            self.assertEqual(res.status_code, 412, res.content)
            self.assertEqual(res.json()["detail"], self.MESSAGE)
        visit.refresh_from_db()
        self.assertEqual(timezone.localtime(visit.start).hour, 14)

    def test_row_ids_of_another_edit_are_412_not_new_services(self):
        visit = self._visit()
        old_rows = self.rows(visit)
        colour_id = old_rows[0]["id"]
        # una collega allunga il colore: le righe si ricreano con id nuovi
        first = self.edit(visit, {"items": self.rows(visit, {colour_id: {"duration_min": 40}})})
        self.assertEqual(first.status_code, 200, first.content)
        old_rows[1]["duration_min"] = 45
        for force in (False, True):
            res = self.edit(visit, {"items": old_rows, "force": force})
            self.assertEqual(res.status_code, 412, res.content)
        prices = sorted(str(i.price) for i in visit.items.all())
        self.assertEqual(prices, ["30.00", "50.00"])
        self.assertEqual(visit.items.count(), 2)

    def test_row_ids_of_another_visit_are_412(self):
        visit = self._visit()
        other = S.create_appointment(
            self.salon, self.bea, [{"service_id": self.cut30.id, "operator_id": self.marta.id}],
            aware(self.day, 15), via="dashboard",
        )
        foreign = other.items.get()
        rows = self.rows(visit) + [{"id": foreign.id, "service_id": self.cut30.id, "operator_id": self.marta.id}]
        res = self.edit(visit, {"items": rows})
        self.assertEqual(res.status_code, 412, res.content)
        self.assertEqual(Appointment.objects.get(pk=visit.pk).items.count(), 2)

    def test_without_a_version_nothing_changes(self):
        visit = self._visit()
        res = self.edit(visit, {"note": "senza versione"})
        self.assertEqual(res.status_code, 200, res.content)
        visit.refresh_from_db()
        self.assertEqual(visit.note, "senza versione")

    def test_a_naive_version_is_rejected(self):
        visit = self._visit()
        naive = dt.datetime.now().replace(microsecond=0).isoformat()
        self.assertEqual(self.edit(visit, {"note": "x", "expected_updated_at": naive}).status_code, 422)
