// Riepilogo di cassa a destra dell'agenda (GET /api/sales/today-summary, C23).
// Caccia ai bug del 22/09/2026: 05-16 («Incassato oggi» solo con gift card).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cashUpLines } from '../src/sections/agenda/modals/rules.js';

const summary = (extra = {}) => ({
  total: '150.00', count: 3, checkout_total: '120.00', pos_total: '30.00',
  gift_card_sold: '0.00', gift_card_redeemed: '0.00', deposit_used: '0.00',
  deposit_cashed: '0.00', deposit_refunded: '0.00', cash_in: '150.00',
  ...extra,
});

test('senza differenze fra venduto e incassato non si aggiunge niente', () => {
  assert.equal(cashUpLines(summary()).show, false);
});

test('una caparra detratta oggi (versata prima) fa comparire «Incassato oggi»', () => {
  const r = cashUpLines(summary({ deposit_used: '30.00', cash_in: '120.00' }));
  assert.equal(r.show, true);
  assert.equal(r.cashIn, 120);
  assert.deepEqual(r.parts, [{ key: 'deposit_used', amount: 30 }]);
});

test('con il solo incasso di una caparra (venduto zero) si vede lo stesso', () => {
  const r = cashUpLines(summary({ total: '0.00', checkout_total: '0.00', pos_total: '0.00', count: 0, deposit_cashed: '30.00', cash_in: '30.00' }));
  assert.equal(r.show, true);
  assert.deepEqual(r.parts, [{ key: 'deposit_cashed', amount: 30 }]);
});

test('cash_in è già al netto delle caparre restituite: non si sottrae di nuovo', () => {
  const r = cashUpLines(summary({ deposit_refunded: '20.00', cash_in: '130.00', gift_card_redeemed: '0' }));
  assert.equal(r.cashIn, 130);
  assert.deepEqual(r.parts.map((p) => p.key), ['deposit_refunded']);
});

test('gift card usate come prima, e server senza deposit_refunded', () => {
  const s = summary({ gift_card_redeemed: '45.00', cash_in: '105.00' });
  delete s.deposit_refunded;
  const r = cashUpLines(s);
  assert.equal(r.show, true);
  assert.deepEqual(r.parts, [{ key: 'gift_card_redeemed', amount: 45 }]);
  assert.equal(cashUpLines(null), null);
});

test('confronto in centesimi: stringhe decimali diverse ma uguali non contano', () => {
  assert.equal(cashUpLines(summary({ total: '0.30', cash_in: '0.3' })).show, false);
});
