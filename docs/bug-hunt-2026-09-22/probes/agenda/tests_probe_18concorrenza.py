"""Probe temporanei del revisore 18 (concorrenza e integrità). DA CANCELLARE."""

import datetime as dt
import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

from django.test import TestCase, override_settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.core.models import ActivityLog, DepositRule, OutboxEvent, Salon, SalonSettings
from common.auth import create_client_tokens, create_staff_tokens

from .models import Appointment, AppointmentService
from .services import cancel_appointment, create_appointment, move_appointment


def _aware(day, hour, minute=0):
    return timezone.make_aware(dt.datetime.combine(day, dt.time(hour, minute)))


class ProbeBase(TestCase):
    def setUp(self):
        from apps.accounts.models import Membership, User
        from apps.catalog.models import Service, ServiceCategory
        from apps.clients.models import Client
        from apps.staff.models import Operator

        self.salon = Salon.objects.create(name="The Parlour", slug="the-parlour")
        SalonSettings.objects.create(salon=self.salon)
        self.salon = Salon.objects.get(pk=self.salon.pk)
        self.client_obj = Client.objects.create(
            salon=self.salon, first_name="Sofia", last_name="Ricci", phone="+393331112222",
            consents={"card_charge": True}, stripe_customer_id="cus_1",
            stripe_payment_method_id="pm_1",
        )
        cat = ServiceCategory.objects.create(salon=self.salon, name_it="Unghie")
        self.svc = Service.objects.create(
            salon=self.salon, category=cat, name_it="Manicure", duration_min=60,
            price=Decimal("50.00"),
        )
        self.op = Operator.objects.create(salon=self.salon, first_name="Giulia", last_name="B")
        self.op.services.add(self.svc)
        self.user = User.objects.create_user(email="owner@theparlour.it", password="x" * 10)
        Membership.objects.create(user=self.user, salon=self.salon, is_owner=True)
        self.auth = {
            "HTTP_AUTHORIZATION": f"Bearer {create_staff_tokens(self.user, self.salon)['access']}"
        }
        self.day = timezone.localdate() + dt.timedelta(days=7)

    def _windows(self):
        return patch(
            "apps.staff.services.shift_windows",
            side_effect=lambda operator, date: [(8 * 60, 20 * 60)],
        )

    def _post(self, url, body=None):
        return self.client.post(
            url, data=json.dumps(body or {}), content_type="application/json", **self.auth
        )


class UndoMoneyProbe(ProbeBase):
    @override_settings(
        STRIPE_SECRET_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_test",
        CLIENT_APP_ORIGIN="https://app.example.com",
    )
    def test_d1_undo_create_leaves_link_open_and_payment_is_lost(self):
        DepositRule.objects.create(
            salon=self.salon, name="Tutte", conditions={}, amount_type="fixed",
            amount=Decimal("15.00"),
        )
        session = {"url": "https://checkout.stripe.com/c/pay/cs_1", "id": "cs_1"}
        with self._windows(), patch(
            "stripe.checkout.Session.create", return_value=session
        ), patch("stripe.checkout.Session.expire") as expire:
            res = self._post("/api/agenda/appointments", {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc.id, "operator_id": self.op.id}],
                "start": _aware(self.day, 10).isoformat(),
            })
            self.assertEqual(res.status_code, 200, res.content)
            appt_id = res.json()["id"]
            self.assertEqual(res.json()["deposit_payment_link"], session["url"])
            undo = self._post("/api/agenda/undo")
            self.assertEqual(undo.status_code, 200, undo.content)
        self.assertFalse(Appointment.objects.filter(id=appt_id).exists())
        # il link è partito subito alla cliente e resta vivo
        link_events = OutboxEvent.objects.filter(event_type="deposit.payment_link")
        print("\n[D1] payment_link events:", list(link_events.values_list("status", flat=True)))
        print("[D1] Session.expire chiamata:", expire.called)
        # la cliente paga il link: il webhook non trova l'appuntamento
        event = {
            "type": "checkout.session.completed",
            "data": {"object": {
                "id": "cs_1", "payment_status": "paid", "payment_intent": "pi_1",
                "amount_total": 1500,
                "metadata": {"appointment_id": str(appt_id), "kind": "deposit",
                             "salon_id": str(self.salon.id)},
            }},
        }
        before = ActivityLog.objects.count()
        with patch("stripe.Webhook.construct_event", return_value=event), patch(
            "stripe.Refund.create"
        ) as refund:
            res = self.client.post(
                "/api/sales/stripe/webhook", data=json.dumps(event),
                content_type="application/json", HTTP_STRIPE_SIGNATURE="t=1,v1=x",
            )
        print("[D1] webhook:", res.status_code, "refund chiamato:", refund.called,
              "nuove righe registro:", ActivityLog.objects.count() - before)

    @override_settings(STRIPE_SECRET_KEY="sk_test_x")
    def test_d2_undo_no_show_after_charge(self):
        from apps.sales.models import Sale

        with self._windows():
            res = self._post("/api/agenda/appointments", {
                "client_id": self.client_obj.id,
                "items": [{"service_id": self.svc.id, "operator_id": self.op.id}],
                "start": _aware(self.day, 10).isoformat(),
            })
        appt_id = res.json()["id"]
        res = self._post(f"/api/agenda/appointments/{appt_id}/no-show", {"reason": "non venuta"})
        self.assertEqual(res.status_code, 200, res.content)
        with patch("stripe.PaymentIntent.create", return_value={"id": "pi_ns"}):
            res = self._post(f"/api/sales/appointments/{appt_id}/charge-no-show")
        self.assertEqual(res.status_code, 200, res.content)
        undo = self._post("/api/agenda/undo")
        appt = Appointment.objects.get(id=appt_id)
        print("\n[D2] undo:", undo.status_code, "stato:", appt.status,
              "no_show_pi:", appt.no_show_payment_intent_id,
              "vendite legate:", Sale.objects.filter(appointment_id=appt_id).count())
        res = self._post(f"/api/sales/checkout/{appt_id}", {
            "blocks": [{"operator_id": self.op.id, "lines": [
                {"line_type": "service", "service_id": self.svc.id, "qty": 1,
                 "unit_price": "50.00"}]}],
            "payments": [{"method": "cash", "amount": "50.00"}],
        })
        print("[D2] checkout dopo l'undo:", res.status_code, res.content[:120])


class HeldEventsUndoProbe(ProbeBase):
    def test_d3_undo_cancel_after_move_loses_move(self):
        with self._windows():
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc.id, "operator_id": self.op.id}],
                _aware(self.day, 10), via="dashboard", actor=self.user,
            )
            # la conferma è già arrivata alla cliente (10:00)
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 15), actor=self.user)
            cancel_appointment(appt, reason="dito scivolato", actor=self.user)
            undo = self._post("/api/agenda/undo")
        self.assertEqual(undo.status_code, 200, undo.content)
        appt.refresh_from_db()
        print("\n[D3] dopo undo: stato", appt.status, "inizio", timezone.localtime(appt.start))
        for e in OutboxEvent.objects.order_by("id"):
            print("[D3]  ", e.id, e.event_type, e.status, e.payload.get("start"))
        alive = [
            e for e in OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
            if e.event_type.startswith("appointment.")
        ]
        print("[D3] eventi appuntamento ancora da consegnare:", [(e.event_type, e.payload.get("start")) for e in alive])


class OutboxWorkerProbe(ProbeBase):
    @override_settings(YOURANG_API_URL="https://yourang.example/api/events", YOURANG_API_KEY="k")
    def test_e_merge_while_worker_lists_sends_stale_payload(self):
        from apps.core.management.commands import flush_outbox as fo

        with self._windows():
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc.id, "operator_id": self.op.id}],
                _aware(self.day, 10), via="dashboard", actor=self.user,
            )
        event = OutboxEvent.objects.get(event_type="appointment.created")
        # la trattenuta scade adesso: il worker legge la lista
        OutboxEvent.objects.filter(pk=event.pk).update(next_attempt_at=timezone.now())
        listed = list(
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING)
            .filter(fo._due(timezone.now())).select_related("salon")
        )
        # ...intanto una richiesta che aveva preso il lock un istante prima
        # della scadenza fonde lo spostamento e allunga la trattenuta (commit)
        OutboxEvent.objects.filter(pk=event.pk).update(
            payload={**event.payload, "start": _aware(self.day, 15).isoformat()},
            next_attempt_at=timezone.now() + dt.timedelta(seconds=30),
        )
        sent = []
        client = MagicMock()
        client.post.side_effect = lambda url, json=None, headers=None: (
            sent.append(json["payload"]["start"]) or MagicMock(status_code=200, text="")
        )
        for ev in listed:
            if fo._claim(ev):
                fo.deliver_event(ev, client=client)
        event.refresh_from_db()
        print("\n[E] consegnato con start:", sent, "stato:", event.status,
              "payload a db:", event.payload.get("start"))

    @override_settings(YOURANG_API_URL="https://yourang.example/api/events", YOURANG_API_KEY="k")
    def test_e2_retry_delivers_older_event_after_newer(self):
        from apps.core.management.commands import flush_outbox as fo

        SalonSettings.objects.filter(salon=self.salon).update(automation_delay_seconds=0)
        with self._windows():
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc.id, "operator_id": self.op.id}],
                _aware(self.day, 10), via="dashboard", actor=self.user,
            )
        delivered = []

        def post(status):
            def _p(self_, url, json=None, headers=None):
                if status == 200:
                    delivered.append((json["event_type"], json["payload"].get("start")))
                return MagicMock(status_code=status, text="down")
            return _p

        with patch("httpx.Client.post", post(503)):
            fo.flush_pending()          # Yourang giù: la conferma va in attesa
        with self._windows():
            move_appointment(appt, _aware(self.day, 15), actor=self.user)
        with patch("httpx.Client.post", post(200)):
            fo.flush_pending()          # Yourang torna: parte lo spostamento
            OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).update(
                next_attempt_at=timezone.now()
            )
            fo.flush_pending()          # scade l'attesa: parte la vecchia conferma
        print("\n[E2] ordine di consegna:", delivered)


class PhoneKeyProbe(ProbeBase):
    def test_stale_phone_key_after_normalization_change(self):
        from apps.clients.models import Client
        from common.phone import find_client_by_phone

        legacy = Client.objects.create(
            salon=self.salon, first_name="Anna", last_name="Neri", phone="393331234567",
        )
        # ciò che la migrazione 0006 (5ccb393, algoritmo del 17/09) ha scritto
        Client.objects.filter(pk=legacy.pk).update(phone_key="39393331234567")
        found = find_client_by_phone(self.salon, "333 1234567")
        print("\n[PK] find_client_by_phone('333 1234567') ->", found)
        res = self.client.post(
            "/api/auth/client/register",
            data=json.dumps({"salon_slug": self.salon.slug, "first_name": "Anna",
                             "last_name": "Neri", "phone": "333 1234567"}),
            content_type="application/json",
        )
        print("[PK] registrazione:", res.status_code,
              "schede con quel numero:", Client.objects.filter(first_name="Anna").count())
        try:
            res = self.client.delete(f"/api/clients/{legacy.id}", **self.auth)
            print("[PK] archiviazione scheda vecchia:", res.status_code, res.content[:100])
        except Exception as exc:  # noqa: BLE001
            print("[PK] archiviazione scheda vecchia: ECCEZIONE", type(exc).__name__, exc)


class RegisterRaceProbe(ProbeBase):
    def test_register_double_submit_500(self):
        from apps.clients.models import Client

        Client.objects.create(salon=self.salon, first_name="Lia", phone="+393339998877")
        # la seconda richiesta ha superato il controllo prima che la prima scrivesse
        with patch("apps.accounts.api.find_client_by_phone", return_value=None):
            try:
                res = self.client.post(
                    "/api/auth/client/register",
                    data=json.dumps({"salon_slug": self.salon.slug, "first_name": "Lia",
                                     "last_name": "", "phone": "+39 333 999 8877"}),
                    content_type="application/json",
                )
                print("\n[REG] seconda registrazione:", res.status_code)
            except Exception as exc:  # noqa: BLE001
                print("\n[REG] seconda registrazione: ECCEZIONE", type(exc).__name__)


class CouponResurrectProbe(ProbeBase):
    def test_update_coupon_resurrects_redeemed(self):
        from apps.marketing.models import Coupon
        from apps.marketing import api as mapi

        coupon = Coupon.objects.create(
            salon=self.salon, code="ABCD1234", kind="amount", value=Decimal("10"),
            origin="manual",
        )
        real = mapi._validate_coupon_value

        def redeemed_meanwhile(kind, value):
            # la cassa consuma il buono mentre il PUT è a metà
            Coupon.objects.filter(pk=coupon.pk).update(status="redeemed", redeemed_at=timezone.now())
            return real(kind, value)

        with patch("apps.marketing.api._validate_coupon_value", side_effect=redeemed_meanwhile):
            res = self.client.put(
                f"/api/marketing/coupons/{coupon.id}",
                data=json.dumps({"kind": "amount", "value": "12.00"}),
                content_type="application/json", **self.auth,
            )
        coupon.refresh_from_db()
        print("\n[CP] PUT:", res.status_code, "stato dopo:", coupon.status, "redeemed_at:", coupon.redeemed_at)


class CustomerRaceProbe(ProbeBase):
    @override_settings(STRIPE_SECRET_KEY="sk_test_x")
    def test_two_setup_intents_two_customers(self):
        from apps.clients.models import Client
        from apps.sales import stripe_service

        fresh = Client.objects.create(salon=self.salon, first_name="Eva", phone="+393331110000")
        created = iter(["cus_A", "cus_B"])
        nested = {"done": False}

        def customer_create(**kwargs):
            cid = next(created)
            if not nested["done"]:
                nested["done"] = True
                # la seconda richiesta (doppio tocco) arriva e finisce tutta qui dentro
                stripe_service.create_setup_intent(Client.objects.get(pk=fresh.pk))
            return {"id": cid}

        intents = []
        with patch("stripe.Customer.create", side_effect=customer_create), patch(
            "stripe.SetupIntent.create",
            side_effect=lambda **kw: intents.append(kw["customer"]) or {"id": f"seti_{len(intents)}", "client_secret": "x"},
        ):
            stripe_service.create_setup_intent(Client.objects.get(pk=fresh.pk))
        fresh.refresh_from_db()
        print("\n[ST] SetupIntent creati per:", intents, "cliente a db:", fresh.stripe_customer_id)


class StaleItemIdProbe(ProbeBase):
    def test_put_with_ids_recreated_by_a_colleague_reprices(self):
        with self._windows():
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc.id, "operator_id": self.op.id}],
                _aware(self.day, 10), via="dashboard", actor=self.user,
            )
            stale_items = [
                {"id": it.id, "service_id": it.service_id, "operator_id": it.operator_id,
                 "duration_min": it.duration_min}
                for it in appt.items.all()
            ]
            # il listino aumenta dopo la prenotazione: la cliente ha concordato 50
            self.svc.price = Decimal("70.00")
            self.svc.soak_min = 20
            self.svc.save(update_fields=["price", "soak_min"])
            # collega A allunga il servizio (righe ricreate con id nuovi)
            res = self.client.put(
                f"/api/agenda/appointments/{appt.id}",
                data=json.dumps({"items": [{**stale_items[0], "duration_min": 70}]}),
                content_type="application/json", **self.auth,
            )
            self.assertEqual(res.status_code, 200, res.content)
            print("\n[ID] dopo A: prezzo", res.json()["items"][0]["price"], "id", res.json()["items"][0]["id"],
                  "(prima", stale_items[0]["id"], ")")
            # collega B, con la vista di prima, trascina il bordo: id vecchi
            res = self.client.put(
                f"/api/agenda/appointments/{appt.id}",
                data=json.dumps({"items": [{**stale_items[0], "duration_min": 80}]}),
                content_type="application/json", **self.auth,
            )
        print("[ID] dopo B:", res.status_code, "prezzo", res.json()["items"][0]["price"],
              "posa", res.json()["items"][0]["soak_min"])


class DoubleMoveProbe(ProbeBase):
    def test_two_moves_in_a_row(self):
        with self._windows():
            appt = create_appointment(
                self.salon, self.client_obj,
                [{"service_id": self.svc.id, "operator_id": self.op.id}],
                _aware(self.day, 10), via="dashboard", actor=self.user,
            )
            OutboxEvent.objects.update(status=OutboxEvent.Status.SENT, sent_at=timezone.now())
            move_appointment(appt, _aware(self.day, 11), actor=self.user)
            move_appointment(appt, _aware(self.day, 12), actor=self.user)
        for e in OutboxEvent.objects.filter(status=OutboxEvent.Status.PENDING).order_by("id"):
            print("\n[MM]", e.event_type, "start", e.payload.get("start"), "old_start", e.payload.get("old_start"))
