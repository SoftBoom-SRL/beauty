// Il drawer «Nuova prenotazione» (NewApptModal.jsx vero, montato con
// test/grid-harness.mjs; il picker della cliente è muto): che cosa manda al
// server e che cosa dice. Sono i comportamenti da tenere fermi mentre il
// drawer si divide in pezzi: l'orario libero, l'orario cliccato in agenda che
// non è libero (si forza, deciso), quello libero preso nel frattempo (ci si
// ferma), l'orario a mano, la caparra da versare, ciò che manca. Bug sospetti
// del 24/09/2026: n. 52 (i pulsanti degli orari si rimontavano).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { isoAtMin, parseISO, toDateStr, todayStr } from '@youty/shared';
import { find, findAll, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: NewApptModal } = await loadComponent('apps/dashboard/src/sections/agenda/modals/NewApptModal.jsx', {
  stubs: ['ClientPicker.jsx'],
  // i pezzi senza hook del drawer, che per i test fanno parte del drawer
  expand: ['BookingFoot', 'DateBar', 'ServiceStep', 'TimeStep', 'ManualTime'],
});

const TODAY = todayStr();
const plus = (n) => { const d = parseISO(TODAY); d.setDate(d.getDate() + n); return toDateStr(d); };
const DAY = plus(3);
const at = (min) => isoAtMin(DAY, min);
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const OPS = [
  { id: 1, first_name: 'Anna', last_name: 'Neri', initials: 'AN', service_ids: [3, 4] },
  { id: 4, first_name: 'Bea', last_name: 'Rossi', initials: 'BR', service_ids: [3, 4] },
];
const SERVICES = [
  { id: 3, name_it: 'Taglio', duration_min: 30, soak_min: 0, price: '35.00', category_id: 1 },
  { id: 4, name_it: 'Colore', duration_min: 60, soak_min: 30, price: '60.00', category_id: 1 },
];
const PREFILL = { clientId: 7, clientName: 'Maria Russo', serviceIds: [3], date: DAY, start: at(600), operatorId: 1 };
const slot = (min) => ({ start: at(min), assignment: [{ service_id: 3, operator_id: 1 }] });
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); });

function setup({ prefill = PREFILL, slots = [slot(600), slot(630)] } = {}) {
  installDom();
  const ApiError = globalThis.__ApiError;
  const calls = { get: [], post: [] };
  const state = { slots, onPost: null };
  globalThis.__api = {
    get: (url, opts) => {
      calls.get.push({ url, opts });
      if (url === '/api/clients/7') return Promise.resolve({ id: 7, full_name: 'Maria Russo' });
      if (url === '/api/marketing/gift-cards') return Promise.resolve({ items: [] });
      if (url === '/api/agenda/availability') return Promise.resolve(state.slots);
      if (url === '/api/agenda/day') return Promise.resolve([]);
      return Promise.resolve([]);
    },
    post: (url, body) => {
      calls.post.push({ url, body });
      return state.onPost ? state.onPost(body, calls.post.length) : Promise.resolve({ id: 99, start: body.start, deposit_status: 'none' });
    },
    put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t: (it) => it, lang: 'it', services: SERVICES, serviceCategories: [], operators: OPS, fireToast: spy(),
    hasScope: () => true, settings: { slot_interval_min: 15 }, agendaPick: null, setAgendaPick: spy(), setTab: spy(), locationId: null,
  };
  const props = { prefill, onClose: spy(), onCreated: spy() };
  const m = mount(NewApptModal, props);
  mounted.push(m);
  const g = {
    m, calls, state, props, ApiError, dash: globalThis.__dash,
    render: () => m.render(),
    button: (text) => find(m.tree, (el) => el.type === 'button' && textOf(el).includes(text)),
    creates: () => calls.post.filter((p) => p.url === '/api/agenda/appointments'),
    lastToast: () => g.dash.fireToast.calls.at(-1)?.[0],
  };
  return g;
}
async function settle(g) { await flush(); g.render(); await flush(); g.render(); }
const conflict = (g) => new g.ApiError(409, 'Orario non più disponibile', { detail: 'Orario non più disponibile' });
const body = (start, force) => ({
  client_id: 7, items: [{ service_id: 3, operator_id: 1 }], start, note: '', flexible: false, location_id: null, force,
});

test('l\'orario cliccato in agenda è libero: si crea senza forzare e il drawer si chiude', async () => {
  const g = setup();
  await settle(g);
  const avail = g.calls.get.filter((x) => x.url === '/api/agenda/availability');
  assert.deepEqual(avail.at(-1).opts.params, { date: DAY, location_id: null, items: [{ service_id: 3, operator_id: 1 }] });
  g.button('Crea prenotazione').props.onClick();
  await settle(g);
  assert.deepEqual(g.creates().map((p) => p.body), [body(at(600), false)]);
  assert.deepEqual(g.lastToast(), { msg: '10:00 · appuntamento creato per Maria', icon: 'check', undo: undefined, undoFn: undefined });
  assert.equal(g.props.onCreated.calls.length, 1);
  assert.equal(g.props.onClose.calls.length, 1);
});

test('l\'orario cliccato in agenda non è libero: lo si è scelto apposta, al 409 si forza', async () => {
  const g = setup({ slots: [slot(630)] });
  g.state.onPost = (b, n) => (n === 1 ? Promise.reject(conflict(g)) : Promise.resolve({ id: 99, start: b.start, deposit_status: 'none' }));
  await settle(g);
  g.button('Crea prenotazione').props.onClick();
  await settle(g);
  assert.deepEqual(g.creates().map((p) => p.body), [body(at(600), false), body(at(600), true)]);
  assert.equal(g.lastToast().msg, '10:00 · appuntamento creato per Maria');
});

test('l\'orario era libero e intanto lo ha preso un\'altra: ci si ferma, si ricarica e lo si dice', async () => {
  const g = setup();
  g.state.onPost = () => Promise.reject(conflict(g));
  await settle(g);
  const before = g.calls.get.filter((x) => x.url === '/api/agenda/availability').length;
  g.button('Crea prenotazione').props.onClick();
  await settle(g);
  assert.equal(g.creates().length, 1, 'nessuna seconda richiesta forzata');
  assert.equal(g.lastToast().msg, 'Le 10:00 sono appena state occupate: scegli un altro orario, o scrivilo in «Orario a mano» per inserirla comunque');
  assert.ok(g.calls.get.filter((x) => x.url === '/api/agenda/availability').length > before, 'orari ricaricati');
  assert.equal(g.props.onClose.calls.length, 0);
});

test('orario a mano fuori dagli orari liberi: al 409 si forza', async () => {
  const g = setup();
  g.state.onPost = (b, n) => (n === 1 ? Promise.reject(conflict(g)) : Promise.resolve({ id: 99, start: b.start, deposit_status: 'none' }));
  await settle(g);
  find(g.m.tree, (el) => el.type === 'input' && el.props['aria-label'] === 'Orario manuale').props.onChange({ target: { value: '18:00' } });
  g.render();
  g.button('Usa').props.onClick();
  g.render();
  g.button('Crea prenotazione').props.onClick();
  await settle(g);
  assert.deepEqual(g.creates().map((p) => p.body), [body(at(18 * 60), false), body(at(18 * 60), true)]);
});

test('caparra da versare: l\'avviso lo dice e offre di copiare il link', async () => {
  const g = setup();
  g.state.onPost = (b) => Promise.resolve({ id: 99, start: b.start, deposit_status: 'required', deposit_payment_link: 'https://pay.example/x' });
  await settle(g);
  g.button('Crea prenotazione').props.onClick();
  await settle(g);
  const toast = g.lastToast();
  assert.equal(toast.msg, '10:00 · appuntamento creato per Maria · caparra da versare');
  assert.equal(toast.undo, 'Copia link caparra');
  assert.equal(typeof toast.undoFn, 'function');
});

test('senza cliente il pulsante dice che cosa manca, e non parte niente', async () => {
  const g = setup({ prefill: { serviceIds: [3], date: DAY, start: at(600), operatorId: 1 } });
  await settle(g);
  const btn = g.button('Manca');
  assert.match(textOf(btn), /Manca cliente/);
  btn.props.onClick();
  await settle(g);
  assert.equal(g.creates().length, 0);
  assert.deepEqual(g.lastToast(), { msg: 'Manca: cliente', icon: 'alert' });
});

test('scegliendo un\'alternativa i pulsanti degli orari non si rimontano: il fuoco resta', async () => {
  // le 10:00 cliccate in agenda non sono libere: il pannello propone le alternative
  const g = setup({ slots: [slot(570), slot(630), slot(660)] });
  await settle(g);
  const chips = () => findAll(g.m.tree, (el) => typeof el.type === 'function' && el.props?.s?.start);
  const before = chips();
  assert.deepEqual(before.map((el) => el.props.s.start), [at(570), at(630), at(660)]);
  // Invio (o clic) sul bottone delle 10:30: il drawer si ridisegna
  before[1].type(before[1].props).props.onClick();
  g.render();
  const after = chips();
  assert.deepEqual(after.map((el) => el.props.s.start), [at(570), at(630), at(660)]);
  // lo stesso componente da un disegno all'altro: React aggiorna i bottoni
  // invece di rimontarli, e il fuoco resta su quello scelto
  after.forEach((el, i) => assert.equal(el.type, before[i].type, `il bottone delle ${el.props.s.start} si rimonta`));
  assert.deepEqual(after.map((el) => el.type(el.props).props.className), ['dk-slot', 'dk-slot dk-slot--on', 'dk-slot']);
});
