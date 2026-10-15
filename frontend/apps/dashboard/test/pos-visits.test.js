// Conto unico nel check-out (pos/visits.js): mani con Giulia e piedi con
// Marta sono due appuntamenti, il conto è uno. Spuntando l'altra visita le sue
// righe entrano nel blocco della sua operatrice, la sua caparra si detrae e le
// carte della cliente si ricalcolano su tutto il conto; togliendola se ne va
// tutto, tranne quello che si è aggiunto al banco.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockOperatorIds, checkoutState, depositCentsOf, visitGifts } from '../src/sections/pos/visits.js';
import { saleTotals } from '../src/sections/pos/money.js';

const mani = {
  id: 1, deposit_credit: '10.00', gifts: [],
  items: [{ id: 11, operator_id: 7, service_id: 3, service_name: 'Manicure', price: '30.00' }],
};
const piedi = {
  id: 2, deposit_credit: '20.00',
  gifts: [{ gift_card_id: 90, service_id: 4, code: 'PKG', balance: '120.00', kind: 'package', sessions_total: 5, sessions_left: 4, session_value: '30.00' }],
  items: [{ id: 21, operator_id: 8, service_id: 4, service_name: 'Pedicure', price: '40.00' }],
};

test('la sola visita principale: le sue righe e la sua caparra', () => {
  const { lines, pay, depositCents } = checkoutState([], [mani]);
  assert.deepEqual(lines.map((l) => [l.key, l.operator_id, l.unit_price]), [['v1_11_0', 7, 30]]);
  assert.equal(depositCents, 1000);
  assert.equal(pay.split, false);
  assert.deepEqual(blockOperatorIds(lines), [7]);
});

test('spuntata la seconda visita: righe, caparre e pacchetto su tutto il conto', () => {
  const extra = { key: 'pl1', operator_id: 7, line_type: 'product', product_id: 5, unit_price: 12, qty: 1, extra: true };
  const first = checkoutState([], [mani]);
  const { lines, pay, depositCents } = checkoutState([...first.lines, extra], [mani, piedi]);
  // il prodotto aggiunto al banco resta, la pedicure arriva nel blocco di Marta
  assert.deepEqual(lines.map((l) => l.key), ['v1_11_0', 'pl1', 'v2_21_0']);
  assert.deepEqual(blockOperatorIds(lines), [7, 8]);
  // la pedicure è coperta dal pacchetto: vale una seduta (30), non il listino (40)
  assert.equal(lines[2].unit_price, 30);
  assert.equal(depositCents, 3000);
  // il pagamento riparte dal dovuto nuovo: 30 + 12 + 30 − 30 di caparre = 42
  const totals = saleTotals(lines, null, depositCents);
  assert.equal(totals.dueCents, 4200);
  assert.deepEqual(pay.rows, [
    { method: 'gift_card', amt: 30, code: 'PKG', sessions: 1 },
    { method: 'cash', amt: 12, code: '' },
  ]);
});

test('tolta la seconda visita se ne vanno le sue righe; il resto torna com’era', () => {
  const both = checkoutState([], [mani, piedi]);
  const marked = both.lines.map((l) => (l.visit_id === 1 ? { ...l, is_gift: true } : l));
  const { lines, depositCents, pay } = checkoutState(marked, [mani]);
  assert.deepEqual(lines.map((l) => l.key), ['v1_11_0']);
  assert.equal(lines[0].is_gift, true);   // l'omaggio sulla principale resta
  assert.equal(depositCents, 1000);
  assert.equal(pay.split, false);
});

test('le carte delle visite del conto una volta sola, e la caparra detraibile', () => {
  assert.deepEqual(visitGifts([piedi, { ...mani, gifts: piedi.gifts }]).map((g) => g.gift_card_id), [90]);
  assert.equal(depositCentsOf({ deposit_credit: '12.50' }), 1250);
  // server di prima, senza deposit_credit: la caparra pagata
  assert.equal(depositCentsOf({ deposit_status: 'paid', deposit_amount: '30.00' }), 3000);
  assert.equal(depositCentsOf({ deposit_status: 'required', deposit_amount: '30.00' }), 0);
});
