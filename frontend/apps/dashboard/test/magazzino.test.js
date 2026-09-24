// Carico merce: ogni riga va al prodotto scelto. Caccia ai bug del 22/09/2026:
// 15-04, 09-02, 17-16 (contratto C7). In fondo la sezione (index.jsx vero,
// montato con test/grid-harness.mjs, sottosezioni mute): i dati comuni.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchRestockKey, restockRowsBody } from '../src/sections/magazzino/lib.js';
import { findAll, installDom, loadComponent, mount, spy, tick } from './grid-harness.mjs';

const { default: MagazzinoSection } = await loadComponent('apps/dashboard/src/sections/magazzino/index.jsx', {
  stubs: ['ProdottiSub.jsx', 'OrdiniSub.jsx', 'FornitoriSub.jsx', 'StoricoSub.jsx'],
});

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

test('dati comuni che non arrivano all\'apertura: un avviso; dal feed live si riprova in silenzio (voce 39)', async () => {
  installDom();
  const fireToast = spy();
  globalThis.__dash = { t: (it) => it, subTab: null, setSubTab: () => {}, fireToast, hasScope: () => true };
  const urls = [];
  let fail = true;
  globalThis.__api = {
    get: (url) => {
      urls.push(url);
      if (fail) return Promise.reject(new TypeError('Failed to fetch'));
      if (url === '/api/inventory/products') return Promise.resolve({ items: [{ id: 1, name: 'Shampoo', active: true, stock_state: 'low' }], count: 1 });
      return Promise.resolve([]);
    },
  };
  const m = mount(MagazzinoSection);
  try {
    await tick();
    m.render();
    // senza avviso categorie, fornitori e catalogo restavano vuoti senza spiegazione
    assert.deepEqual(fireToast.calls, [[{ msg: 'Errore di rete', icon: 'alert' }]]);
    assert.deepEqual([...new Set(urls)].sort(), ['/api/inventory/categories', '/api/inventory/products', '/api/inventory/suppliers']);
    // la sezione si apre lo stesso, col catalogo vuoto
    assert.equal(findAll(m.tree, (el) => el.type?.name === 'ProdottiSub').length, 1);
    // le riletture dal feed live restano silenziose, anche quando falliscono
    urls.length = 0;
    globalThis.__useLive([{ type: 'product.updated' }]);
    await tick();
    m.render();
    assert.ok(urls.length > 0);
    assert.equal(fireToast.calls.length, 1);
    fail = false;
    globalThis.__useLive([{ type: 'stock.sold' }]);
    await tick();
    m.render();
    assert.equal(fireToast.calls.length, 1);
    assert.deepEqual(findAll(m.tree, (el) => el.type?.name === 'ProdottiSub')[0].props.allProds.map((p) => p.id), [1]);
  } finally { m.unmount(); }
});
