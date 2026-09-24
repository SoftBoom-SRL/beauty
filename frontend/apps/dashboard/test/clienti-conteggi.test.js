// I conteggi delle card in cima alla sezione Clienti (index.jsx vero, montato
// con grid-harness.mjs; la scheda cliente è muta). Bug sospetti del 24/09,
// voce 43: a ogni evento del feed dal vivo (client.*, client_category.*) le
// card si ricontavano con una lista `limit=1` per «Attivi» e una per ogni
// etichetta, 1+N richieste oltre alla lista, su ogni postazione aperta sulla
// sezione. Ora i conteggi arrivano tutti con GET /api/clients/counts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { find, loadComponent, mount, textOf, tick } from './grid-harness.mjs';

const { default: ClientiSection } = await loadComponent('apps/dashboard/src/sections/clienti/index.jsx', {
  stubs: ['ClientProfile.jsx'],
});

const LABELS = [
  { id: 3, name: 'VIP', color: '#F5C2C7', order: 0 },
  { id: 5, name: 'Da form', color: '#8B5CF6', order: 1 },
  { id: 8, name: 'Expat', color: '#C2E8CB', order: 2 },
];
const COUNTS = { active: 42, categories: [{ id: 3, count: 7 }, { id: 5, count: 0 }, { id: 8, count: 12 }] };
const flush = async () => { for (let i = 0; i < 8; i++) await tick(); };

function setup({ counts = () => Promise.resolve(COUNTS) } = {}) {
  const gets = [];
  globalThis.__api = {
    get: (url, opts) => {
      gets.push({ url, params: opts?.params });
      if (url === '/api/clients/counts') return counts();
      if (url === '/api/clients/') return Promise.resolve({ items: [], count: 9 });
      return Promise.reject(new Error(`GET inatteso: ${url}`));
    },
  };
  globalThis.__dash = {
    t: (it) => it, search: '', setSearch: () => {}, selClient: null, setSelClient: () => {},
    clientCategories: LABELS, openModal: () => {}, modal: null, fireToast: () => {}, live: { events: [] },
  };
  const m = mount(ClientiSection, {});
  return { m, gets };
}

/* Le richieste della lista (con la sua pagina) e tutte le altre. */
const listCalls = (gets) => gets.filter((g) => g.url === '/api/clients/' && g.params?.limit !== 1);
const countCalls = (gets) => gets.filter((g) => !listCalls(gets).includes(g));
const card = (m, label) => find(m.tree, (el) => el.type === 'button' && textOf(el).startsWith(label));

test('«Attivi» e tutte le etichette si contano con una richiesta sola', async () => {
  const { m, gets } = setup();
  await flush();
  m.render();
  assert.deepEqual(countCalls(gets).map((g) => g.url), ['/api/clients/counts']);
  assert.equal(listCalls(gets).length, 1);
  assert.equal(textOf(card(m, 'Attivi')), 'Attivi42');
  assert.equal(textOf(card(m, 'VIP')), 'VIP7');
  assert.equal(textOf(card(m, 'Da form')), 'Da form0');
  assert.equal(textOf(card(m, 'Expat')), 'Expat12');
});

test('un evento dal vivo rifà la lista e i conteggi, con una richiesta per i conteggi', async () => {
  const { m, gets } = setup();
  await flush();
  m.render();
  gets.length = 0;
  globalThis.__useLive([{ id: 9, type: 'client.updated', payload: { client_id: 4, fields: ['categories'] } }]);
  m.render();
  await flush();
  m.render();
  assert.deepEqual(countCalls(gets).map((g) => g.url), ['/api/clients/counts']);
  assert.equal(listCalls(gets).length, 1);
});

test('conteggi non arrivati: le card restano in caricamento, come prima', async () => {
  const { m } = setup({ counts: () => Promise.reject(new Error('rete')) });
  await flush();
  m.render();
  for (const label of ['Attivi', 'VIP', 'Da form', 'Expat']) {
    assert.equal(textOf(card(m, label)), label, label);
    assert.ok(find(card(m, label), (el) => el.props?.className === 'skel'), label);
  }
});
