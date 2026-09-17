"""Audit probes: assertions describe observed defects, not desired behaviour.
Run with Django test runner; exclusively synthetic data and mocked Stripe.

STORICO — 17/09/2026. Tutti e quattordici i difetti sono stati corretti, quindi
queste prove ORA FALLISCONO: è la conferma che il comportamento è cambiato. Il
file resta come documentazione di quello che è stato trovato e di come è stato
riprodotto. I test di regressione, che asseriscono il comportamento CORRETTO,
vivono nelle suite delle app:

  B01, B02  apps/accounts/tests.py  InvitationPasswordTests, StaffLoginThrottleTests
  B03       apps/core/tests.py      RateLimitCounterTests
  B04       apps/agenda/tests.py    ConcurrentTransitionTests
  B05       apps/inventory/tests.py ReceiveOrderConcurrencyTests
  B06-B08   apps/sales/tests.py     DepositRefundStateTests, DuplicateDepositPaymentTests
  B09,B10,B13 apps/agenda/tests.py  AvailabilityMatchesBookingTests
  B11       apps/marketing/tests.py LoyaltyRewardIssueTests
  B12       apps/sales/tests.py     NoShowAmountTests
  B14       frontend/packages/shared/test/format.test.js  (npm test)
  perf      apps/insights/tests.py  ShiftCapacityQueryBudgetTests
"""
import datetime as dt
import json
from decimal import Decimal
from unittest.mock import Mock, patch

from django.core.cache import caches
from django.db import connection
from django.test import TestCase, override_settings
from django.utils import timezone
from ninja.errors import HttpError

from apps.accounts.models import Invitation, Membership, Role, User
from apps.agenda.models import Appointment, AppointmentService
from apps.agenda.services import cancel_appointment, create_appointment, get_free_slots, move_appointment
from apps.catalog.models import Service, ServiceCategory
from apps.clients.models import Client
from apps.core.models import Location, Salon, SalonSettings
from apps.inventory.models import Product, PurchaseOrder, PurchaseOrderLine, Supplier
from apps.inventory.services import receive_order
from apps.marketing.models import Coupon, GiftCard, LoyaltyProgram
from apps.sales.api import _charge_refunded, _payment_intent_succeeded
from apps.sales.services import finalize_sale
from common.auth import create_client_tokens, create_staff_tokens
from common import ratelimit


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class AuditProbes(TestCase):
    def setUp(self):
        self.salon = Salon.objects.create(name='Audit', slug='audit')
        self.settings = SalonSettings.objects.create(salon=self.salon, agenda_fill='free')
        self.customer = Client.objects.create(salon=self.salon, first_name='Synthetic', last_name='Audit', phone='+393330000001')
        self.user = User.objects.create_user(email='audit@example.test', password='Audit-Password-123')
        Membership.objects.create(salon=self.salon, user=self.user, is_owner=True)
        self.headers = {'HTTP_AUTHORIZATION': 'Bearer ' + create_staff_tokens(self.user, self.salon)['access']}
        self.client_headers = {'HTTP_AUTHORIZATION': 'Bearer ' + create_client_tokens(self.customer)['access']}
        self.category = ServiceCategory.objects.create(salon=self.salon, name_it='Audit')
        self.service = Service.objects.create(salon=self.salon, category=self.category, name_it='Audit Service', duration_min=30, price=100)
        from apps.staff.models import Operator
        self.operator = Operator.objects.create(salon=self.salon, first_name='Audit', last_name='Operator')
        self.service.operators.add(self.operator)
        self.day = timezone.localdate() + dt.timedelta(days=7)
        self.start = timezone.make_aware(dt.datetime.combine(self.day, dt.time(10)))

    def post(self, path, body, headers=None):
        return self.client.post(path, json.dumps(body), content_type='application/json', **(headers or {}))

    def appt(self, **fields):
        app = Appointment.objects.create(salon=self.salon, client=self.customer, operator=self.operator, start=self.start, **fields)
        AppointmentService.objects.create(appointment=app, service=self.service, operator=self.operator, duration_min=60, price=100, order=0)
        return app

    def test_01_empty_invitation_password_is_accepted(self):
        role = Role.objects.create(salon=self.salon, name='Front Desk', scopes=['agenda'])
        invite = Invitation.objects.create(salon=self.salon, email='invited@example.test', role=role)
        response = self.post('/api/auth/invitations/accept', {'token': str(invite.token), 'password': '', 'first_name': 'Audit', 'last_name': 'Invite'})
        self.assertEqual(response.status_code, 200, response.content)
        response = self.post('/api/auth/staff/login', {'email': invite.email, 'password': ''})
        self.assertEqual(response.status_code, 200, response.content)
        print('PROBE 01: empty password accepted; login with empty password returns 200')

    def test_02_login_has_no_application_rate_limit(self):
        statuses = [self.post('/api/auth/staff/login', {'email': self.user.email, 'password': 'wrong'}).status_code for _ in range(30)]
        self.assertEqual(set(statuses), {401})
        self.assertEqual(self.post('/api/auth/staff/login', {'email': self.user.email, 'password': 'Audit-Password-123'}).status_code, 200)
        print('PROBE 02: 30 wrong passwords all return 401, next valid login returns 200; no throttle')

    def test_03_database_rate_limit_loses_window_and_increment(self):
        backend = caches['default']
        self.assertEqual(type(backend).__name__, 'DatabaseCache')
        key = 'audit-rate-window'
        before = timezone.now()
        ratelimit.hit(key, 5, 3600)
        with connection.cursor() as cursor:
            cursor.execute('SELECT expires FROM django_cache WHERE cache_key = %s', [backend.make_key(key)])
            expires = cursor.fetchone()[0]
        if isinstance(expires, str): expires = dt.datetime.fromisoformat(expires)
        if timezone.is_naive(expires): expires = timezone.make_aware(expires, dt.timezone.utc)
        ttl = (expires - before).total_seconds()
        self.assertLess(ttl, 310)
        key = 'audit-rate-race'
        backend.set(key, 0, 3600)
        original_get = backend.get
        nested = []
        fired = False
        def interleaved_get(*args, **kwargs):
            nonlocal fired
            value = original_get(*args, **kwargs)
            if args[0] == key and not fired:
                fired = True
                nested.append(ratelimit.hit(key, 1, 3600))
            return value
        with patch.object(backend, 'get', side_effect=interleaved_get):
            outer = ratelimit.hit(key, 1, 3600)
        self.assertEqual(nested, [True])
        self.assertTrue(outer)
        self.assertEqual(backend.get(key), 1)
        print(f'PROBE 03: requested TTL 3600s becomes {ttl:.0f}s; interleaved hits both pass limit=1, stored count=1')

    def test_04_stale_move_reopens_cancelled_appointment(self):
        appt = self.appt()
        stale = Appointment.objects.get(pk=appt.pk)
        cancel_appointment(appt)
        with patch('apps.staff.services.shift_windows', return_value=[(0, 1440)]):
            move_appointment(stale, self.start + dt.timedelta(hours=2))
        appt.refresh_from_db()
        self.assertEqual(appt.status, 'confirmed')
        print('PROBE 04: request snapshot loaded before cancellation can move and resurrect cancelled appointment')

    def test_05_stale_receive_doubles_stock(self):
        supplier = Supplier.objects.create(salon=self.salon, name='Audit Supplier')
        product = Product.objects.create(salon=self.salon, supplier=supplier, name='Audit Product', stock_qty=0)
        order = PurchaseOrder.objects.create(salon=self.salon, supplier=supplier, status='sent')
        line = PurchaseOrderLine.objects.create(order=order, product=product, qty_ordered=10)
        stale = PurchaseOrder.objects.get(pk=order.pk)
        receive_order(order, [{'id': line.pk, 'qty_received': 10}])
        receive_order(stale, [{'id': line.pk, 'qty_received': 10}])
        product.refresh_from_db(); line.refresh_from_db()
        self.assertEqual(product.stock_qty, 20)
        self.assertEqual(line.qty_received, 10)
        print('PROBE 05: same order received from two prior snapshots: stock=20, receipt line=10')

    def test_06_partial_refund_marks_entire_deposit_refunded(self):
        appt = self.appt(deposit_status='paid', deposit_amount=30, deposit_payment_intent_id='pi_audit_partial')
        _charge_refunded({'payment_intent': 'pi_audit_partial', 'amount': 3000, 'amount_refunded': 1000, 'refunded': False})
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_status, 'refunded')
        print('PROBE 06: refund EUR10 of EUR30 marks entire deposit refunded; remaining EUR20 no longer deducted')

    def test_07_pending_refund_marks_deposit_refunded(self):
        appt = self.appt(deposit_status='paid', deposit_amount=30, deposit_payment_intent_id='pi_audit_pending')
        event = {'type': 'refund.created', 'data': {'object': {'payment_intent': 'pi_audit_pending', 'amount': 3000, 'status': 'pending'}}}
        with patch('apps.sales.stripe_service.verify_webhook', return_value=event):
            result = self.post('/api/sales/stripe/webhook', {})
        self.assertEqual(result.status_code, 200)
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_status, 'refunded')
        print('PROBE 07: refund.created status=pending already marks deposit refunded')

    def test_08_second_paid_intent_is_silently_discarded(self):
        appt = self.appt(deposit_status='required', deposit_amount=30)
        from apps.sales.stripe_service import ensure_deposit_link
        stripe = Mock()
        stripe.checkout.Session.create.side_effect = [{'id': 'cs_audit_first', 'url': 'https://checkout.example.test/first'}, {'id': 'cs_audit_second', 'url': 'https://checkout.example.test/second'}]
        with patch('apps.sales.stripe_service._client', return_value=stripe), patch('apps.sales.stripe_service.payments_enabled', return_value=True):
            ensure_deposit_link(appt)
            Appointment.objects.filter(pk=appt.pk).update(updated_at=appt.updated_at + dt.timedelta(seconds=2))
            appt.refresh_from_db()
            ensure_deposit_link(appt, resend=True)
        self.assertEqual(stripe.checkout.Session.create.call_count, 2)
        stripe.checkout.Session.expire.assert_not_called()
        metadata = {'appointment_id': str(appt.id), 'salon_id': str(self.salon.id), 'kind': 'deposit'}
        _payment_intent_succeeded({'id': 'pi_audit_first', 'amount_received': 3000}, metadata)
        with patch('apps.agenda.services.settle_deposit_refund') as refund:
            _payment_intent_succeeded({'id': 'pi_audit_second', 'amount_received': 3000}, metadata)
            refund.assert_not_called()
        appt.refresh_from_db()
        self.assertEqual(appt.deposit_payment_intent_id, 'pi_audit_first')
        print('PROBE 08: second distinct successful deposit payment ignored without refund/reconciliation')

    def test_09_public_slots_ignore_default_location(self):
        main = Location.objects.create(salon=self.salon, name='Main', is_default=True)
        other = Location.objects.create(salon=self.salon, name='Other')
        self.operator.location = other; self.operator.save()
        items = [{'service_id': self.service.id, 'operator_id': None}]
        with patch('apps.staff.services.shift_windows', return_value=[(540, 1080)]):
            response = self.client.get('/api/agenda/public/availability', {'salon': self.salon.slug, 'date': self.day.isoformat(), 'items': json.dumps(items)})
            self.assertEqual(response.status_code, 200, response.content)
            slots = response.json(); self.assertTrue(slots)
            result = self.post('/api/agenda/client/appointments', {'items': items, 'start': slots[0]['start']}, self.client_headers)
        self.assertEqual(result.status_code, 409, result.content)
        print('PROBE 09: public availability offers secondary-location operator; booking same slot at default location returns 409')

    def test_10_move_slots_ignore_snapshot_duration(self):
        appt = self.appt()  # booked for 60m; live catalog says 30m
        with patch('apps.staff.services.shift_windows', return_value=[(540, 1080)]):
            result = self.client.get('/api/agenda/client/availability', {'date': self.day.isoformat(), 'items': json.dumps([{'service_id': self.service.id}]), 'exclude_appointment_id': appt.id}, **self.client_headers)
            self.assertEqual(result.status_code, 200)
            slot = next(x for x in result.json() if timezone.localtime(dt.datetime.fromisoformat(x['start'])).time() == dt.time(17, 30))
            moved = self.post(f'/api/agenda/client/appointments/{appt.id}/move', {'start': slot['start']}, self.client_headers)
        self.assertEqual(moved.status_code, 409, moved.content)
        print('PROBE 10: 60m existing booking offered 17:30 with 18:00 closing because catalog now says 30m; move returns 409')

    def test_11_free_service_loyalty_issues_zero_value_coupon(self):
        LoyaltyProgram.objects.create(salon=self.salon, name='Free Service', threshold=1, earn_metric='per_visit', earn_ratio=1, reward_type='free_service', reward_service=self.service, reward_value=0)
        finalize_sale(self.salon, kind='pos', client=self.customer, blocks=[{'lines': [{'line_type': 'service', 'service_id': self.service.id, 'unit_price': 100, 'qty': 1}]}], payments=[{'method': 'cash', 'amount': 100}])
        coupon = Coupon.objects.get(client=self.customer)
        self.assertEqual(coupon.kind, 'amount'); self.assertEqual(coupon.value, 0)
        self.assertEqual(GiftCard.objects.count(), 0)
        print('PROBE 11: loyalty free service reward becomes EUR0 coupon, without service association')

    def test_12_no_show_response_amount_is_gross_not_charge(self):
        self.customer.consents = {'card_charge': True}
        self.customer.stripe_customer_id = 'cus_audit'
        self.customer.stripe_payment_method_id = 'pm_audit'
        self.customer.save()
        appt = self.appt(status='no_show', deposit_status='forfeited', deposit_amount=30)
        stripe = Mock(); stripe.PaymentIntent.create.return_value = {'id': 'pi_audit_no_show'}
        with patch('apps.sales.stripe_service._client', return_value=stripe):
            result = self.post(f'/api/sales/appointments/{appt.id}/charge-no-show', {}, self.headers)
        self.assertEqual(result.status_code, 200, result.content)
        self.assertEqual(stripe.PaymentIntent.create.call_args.kwargs['amount'], 7000)
        self.assertEqual(Decimal(result.json()['amount']), 100)
        print('PROBE 12: Stripe asked to charge EUR70, API and activity log declare EUR100')

    def test_13_soak_after_closing_is_offered_then_rejected(self):
        self.service.soak_min = 60; self.service.save()
        self.settings.opening_hours_week = {str(self.day.weekday()): [['09:00', '18:00']]}
        self.settings.save()
        items = [{'service_id': self.service.pk}]
        with patch('apps.staff.services.shift_windows', return_value=[(540, 1080)]):
            result = self.client.get('/api/agenda/public/availability', {'salon': self.salon.slug, 'date': self.day.isoformat(), 'items': json.dumps(items)})
            slot = next(x for x in result.json() if timezone.localtime(dt.datetime.fromisoformat(x['start'])).time() == dt.time(17, 30))
            booked = self.post('/api/agenda/client/appointments', {'start': slot['start'], 'items': items}, self.client_headers)
        self.assertEqual(booked.status_code, 409, booked.content)
        print('PROBE 13: 17:30 offered for 30m work + 60m soak despite 18:00 closing; booking returns 409')

    def test_14_insights_query_count(self):
        from django.test.utils import CaptureQueriesContext
        from apps.insights.services import _daily_shift_minutes
        days = [self.day + dt.timedelta(days=i) for i in range(30)]
        with CaptureQueriesContext(connection) as queries:
            _daily_shift_minutes(self.salon, days)
        self.assertGreaterEqual(len(queries), 60)
        print(f'PROBE 14: insights shift capacity for ONE operator and 30 days executes {len(queries)} SQL queries')
