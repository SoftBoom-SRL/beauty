// Carico merce: ogni riga va al prodotto scelto. Caccia ai bug del 22/09/2026:
// 15-04, 09-02, 17-16 (contratto C7).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchRestockKey, restockRowsBody } from '../src/sections/magazzino/lib.js';

const davines = { id: 11, name: 'Shampoo idratante', sku: '', brand: 'Davines', active: true };
const kerastase = { id: 12, name: 'Shampoo idratante', sku: '', brand: 'Kerastase', active: true };
const lacca = { id: 13, name: 'Lacca forte', sku: 'LF-01', brand: 'OPI', active: true };
const nuovoSh = { id: 14, name: 'Shampoo SH', sku: 'SH-01', brand: 'Kerastase', active: true };

test('C7: la riga scelta dall’elenco porta product_id, nome e SKU', () => {
  const rows = restockRowsBody([
    { key: 'a', product: kerastase, name: kerastase.name, sku: '', qty: 12 },
    { key: 'b', product: lacca, name: lacca.name, sku: 'LF-01', qty: '3' },
  ]);
  assert.deepEqual(rows, [
    { product_id: 12, name: 'Shampoo idratante', sku: '', qty: 12 },
    { product_id: 13, name: 'Lacca forte', sku: 'LF-01', qty: 3 },
  ]);
});

test('17-16: il nome parte sempre, anche quando c’è lo SKU (e per le righe nuove)', () => {
  const rows = restockRowsBody([{ key: 'n', product: null, name: '  Maschera ristrutturante ', sku: '', qty: 5, isNew: true }]);
  assert.deepEqual(rows, [{ name: 'Maschera ristrutturante', sku: '', qty: 5 }]);
  assert.ok(!('product_id' in rows[0]));
});

test('15-04: una riga CSV per SKU trova il prodotto attivo, lo SKU vince sul nome', () => {
  const r = matchRestockKey('sh-01', [davines, nuovoSh, lacca]);
  assert.equal(r.product, nuovoSh);
});

test('09-02: due prodotti con lo stesso nome non si indovinano, si chiede quale', () => {
  const r = matchRestockKey('Shampoo idratante', [davines, kerastase, lacca]);
  assert.equal(r.product, null);
  assert.deepEqual(r.candidates.map((p) => p.id), [11, 12]);
});

test('una chiave sconosciuta è un prodotto nuovo', () => {
  const r = matchRestockKey('Balsamo', [davines, lacca]);
  assert.equal(r.product, null);
  assert.equal(r.candidates.length, 0);
});
