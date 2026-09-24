// Righe del conto della cassa (pos/lines.js): come nascono nel check-out e al
// banco e il corpo che parte verso POST /api/sales/checkout/{id} e
// /api/sales/pos. Le attese sono quelle che SellModal e CartTab scrivevano a
// mano prima di passare da qui (refactoring del 24/09).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apptItemLine, checkoutDiscountPct, checkoutGiftLine, checkoutProductLine, checkoutServiceLine,
  counterDiscountPct, counterGiftLine, counterProductLine, giftLineName, toApiLine,
} from '../src/sections/pos/lines.js';

const item = { id: 41, operator_id: 7, service_id: 3, service_name: 'Taglio', price: '35.00' };
const shampoo = { id: 12, name: 'Shampoo', sale_price: '18.50' };
const piega = { id: 5, name_it: 'Piega', name_en: 'Blow-dry', price: '20' };

test('check-out: le righe dell’appuntamento, una per servizio, non si tolgono', () => {
  assert.deepEqual(apptItemLine(item, 0), {
    key: 'ai41_0', operator_id: 7, line_type: 'service', service_id: 3, name: 'Taglio',
    unit_price: 35, qty: 1, discount_pct: 0, is_gift: false, extra: false,
  });
  // senza id la chiave usa la posizione (due volte)
  assert.equal(apptItemLine({ ...item, id: undefined }, 2).key, 'ai2_2');
});

test('check-out: prodotto, servizio extra e gift card aggiunti al banco', () => {
  assert.deepEqual(checkoutProductLine('pl1', 7, shampoo), {
    key: 'pl1', operator_id: 7, line_type: 'product', product_id: 12, name: 'Shampoo',
    unit_price: 18.5, qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.equal(checkoutServiceLine('sl1', 7, piega, 'en').name, 'Blow-dry');
  assert.deepEqual(checkoutServiceLine('sl1', 7, piega, 'it'), {
    key: 'sl1', operator_id: 7, line_type: 'service', service_id: 5, name: 'Piega',
    unit_price: 20, qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.deepEqual(checkoutGiftLine('gl1', 7, 50, '  Anna ', 'it'), {
    key: 'gl1', operator_id: 7, line_type: 'gift_card', name: 'Gift card · €50,00', value: 50,
    recipient_name: 'Anna', qty: 1, discount_pct: 0, is_gift: false, extra: true,
  });
  assert.equal(checkoutGiftLine('gl2', 7, 50, undefined, 'it').recipient_name, '');
});

test('banco: il prodotto porta la giacenza, la gift card il destinatario', () => {
  assert.deepEqual(counterProductLine('p12_1', shampoo, 4), {
    key: 'p12_1', line_type: 'product', product_id: 12, name: 'Shampoo', unit_price: 18.5,
    qty: 1, is_gift: false, disc: 0, stock: 4,
  });
  assert.deepEqual(counterGiftLine('g1', 25, ' Bea ', 'it'), {
    key: 'g1', line_type: 'gift_card', name: 'Gift card · €25,00', value: 25, recipient_name: 'Bea',
    qty: 1, is_gift: false, disc: 0,
  });
});

test('il nome della gift card scrive l’importo come ogni prezzo, nella lingua dell’interfaccia (voce 41)', () => {
  // era il numero così com'è: «€12.5», «€1000»; ora come fmtEur scrive ogni
  // prezzo (in italiano le migliaia si separano da 10.000 in su)
  assert.equal(giftLineName(12.5, 'it'), 'Gift card · €12,50');
  assert.equal(giftLineName(1000, 'it'), 'Gift card · €1000,00');
  assert.equal(giftLineName(12.5, 'en'), 'Gift card · €12.50');
  assert.equal(giftLineName(1000, 'en'), 'Gift card · €1,000.00');
  assert.equal(checkoutGiftLine('gl3', 7, 12.5, '', 'en').name, 'Gift card · €12.50');
  assert.equal(counterGiftLine('g3', 1000, '', 'it').name, 'Gift card · €1000,00');
});

test('sconti: omaggi a zero; al banco vale quello della riga, altrimenti quello sulla vendita', () => {
  assert.equal(checkoutDiscountPct({ discount_pct: 15, is_gift: false }), 15);
  assert.equal(checkoutDiscountPct({ discount_pct: 15, is_gift: true }), 0);
  assert.equal(checkoutDiscountPct({ is_gift: false }), 0);
  const p = { line_type: 'product', is_gift: false };
  assert.equal(counterDiscountPct({ ...p, disc: 5 }, 20), 5);
  assert.equal(counterDiscountPct({ ...p, disc: 0 }, 20), 20);
  assert.equal(counterDiscountPct({ ...p, disc: 0 }, 0), 0);
  assert.equal(counterDiscountPct({ ...p, disc: 5, is_gift: true }, 20), 0);
  assert.equal(counterDiscountPct({ line_type: 'gift_card', disc: 0 }, 20), 0);
});

test('verso l’API: servizio, prodotto e gift card, con il prezzo in centesimi esatti', () => {
  assert.deepEqual(toApiLine({ line_type: 'service', service_id: 3, qty: 1, unit_price: 35, is_gift: false }, 0),
    { line_type: 'service', service_id: 3, qty: 1, unit_price: '35.00', discount_pct: 0, is_gift: false });
  assert.deepEqual(toApiLine({ line_type: 'product', product_id: 12, qty: 2, unit_price: 18.5, is_gift: 1 }, 10),
    { line_type: 'product', product_id: 12, qty: 2, unit_price: '18.50', discount_pct: 10, is_gift: true });
  assert.deepEqual(toApiLine({ line_type: 'gift_card', value: 50, recipient_name: 'Anna', qty: 1 }, 30),
    { line_type: 'gift_card', value: '50.00', recipient_name: 'Anna' });
  assert.deepEqual(toApiLine({ line_type: 'gift_card', value: 50, recipient_name: '' }, 0),
    { line_type: 'gift_card', value: '50.00' });
  // stesso ordine dei campi che scrivevano SellModal e CartTab
  assert.deepEqual(Object.keys(toApiLine({ line_type: 'product', product_id: 1, qty: 1, unit_price: 1 }, 0)),
    ['line_type', 'product_id', 'qty', 'unit_price', 'discount_pct', 'is_gift']);
});
