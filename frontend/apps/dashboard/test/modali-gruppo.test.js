// La prenotazione di gruppo (GroupBookingDrawer.jsx vero, montato con
// test/grid-harness.mjs; il selettore della cliente è muto). 15/10: le due
// prenotazioni mostravano le stesse cose in due modi diversi; ora ogni riga
// del gruppo è fatta con i pezzi di «Nuova prenotazione» (newappt/).
// Le righe hanno degli hook: si montano a parte, con le props che il pannello
// dà loro, e si ridisegnano dopo ogni cambio del pannello.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { isoAtMin, parseISO, toDateStr, todayStr } from '@youty/shared';
import { find, findAll, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { BOOKING_PANEL_W } = await loadComponent('apps/dashboard/src/sections/agenda/modals/newappt/BookingShell.jsx');
const { default: GroupBookingDrawer } = await loadComponent('apps/dashboard/src/sections/agenda/modals/GroupBookingDrawer.jsx', {
  stubs: ['ClientPicker.jsx'],
  expand: ['BookingShell', 'DateBar', 'StepLabel', 'ServiceStep', 'TimeStep'],
});

const plus = (n) => { const d = parseISO(todayStr()); d.setDate(d.getDate() + n); return toDateStr(d); };
const DAY = plus(3);
const at = (min) => isoAtMin(DAY, min);
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const OPS = [{ id: 1, first_name: 'Anna', last_name: 'Neri', initials: 'AN', color: '#1A237E', service_ids: [3, 4] }];
const SERVICES = [
  { id: 3, name_it: 'Taglio', duration_min: 30, soak_min: 0, price: '35.00', category_id: 1, color: '' },
  { id: 4, name_it: 'Colore', duration_min: 60, soak_min: 30, price: '60.00', category_id: 1, color: '' },
];
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); });

function setup() {
  installDom();
  const calls = { get: [], post: [] };
  globalThis.__api = {
    get: (url, opts) => {
      calls.get.push({ url, opts });
      if (url === '/api/agenda/availability') return Promise.resolve([{ start: at(600), assignment: [{ service_id: 3, operator_id: 1 }] }, { start: at(630), assignment: [{ service_id: 3, operator_id: 1 }] }]);
      if (url === '/api/marketing/gift-cards') return Promise.resolve({ items: [] });
      return Promise.resolve([]);
    },
    post: (url, body) => { calls.post.push({ url, body }); return Promise.resolve({ id: 99, start: body.start, items: [] }); },
    put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t: (it) => it, lang: 'it', services: SERVICES, serviceCategories: [{ id: 1, name_it: 'Capelli', color: '#FDE2E4' }], operators: OPS,
    fireToast: spy(), hasScope: () => true, locationId: null, setTab: spy(),
  };
  const props = { date: DAY, onClose: spy(), onCreated: spy() };
  const m = mount(GroupBookingDrawer, props);
  mounted.push(m);
  // la prima riga, montata a parte (ha degli hook)
  const rowEl = () => find(m.tree, (el) => el.type?.name === 'GroupRow');
  const row = mount(rowEl().type, rowEl().props);
  mounted.push(row);
  const g = {
    m, row, calls, props,
    /** dopo un cambio: il pannello si ridisegna e la riga riceve le props nuove */
    render: () => { m.render(); row.render(rowEl().props); },
    pill: (name) => find(row.tree, (el) => el.type === 'button' && el.props.className === 'dk-pill' && textOf(el).startsWith(name)),
    items: () => rowEl().props.row.items,
    createBtn: () => find(m.tree, (el) => el.type === 'button' && /^(Crea|Manca)/.test(textOf(el))),
  };
  return g;
}

test('il pannello del gruppo è quello di «Nuova prenotazione»: guscio, passi, servizi, giorno', () => {
  const g = setup();
  const dialog = find(g.m.tree, (el) => el.props?.role === 'dialog');
  assert.equal(dialog.props.style.width, BOOKING_PANEL_W, 'la stessa larghezza');
  assert.equal(dialog.props['aria-label'], 'Prenotazione di gruppo');
  const names = new Set(findAll(g.row.tree, (el) => typeof el.type === 'function').map((el) => el.type.name));
  for (const part of ['DateBar', 'StepLabel', 'ServiceStep', 'ClientPicker']) assert.ok(names.has(part), part);
  // i passi numerati come in «Nuova prenotazione»
  const steps = findAll(g.row.tree, (el) => el.type?.name === 'StepLabel').map((el) => el.props.n);
  assert.deepEqual(steps, [1, 2]);
  // le pillole dei servizi nel colore del servizio, non più grigie col pallino
  assert.ok(g.pill('Taglio').props.style.background.includes('#FDE2E4'));
});

test('un servizio si sceglie e si toglie, come in «Nuova prenotazione»: niente copie', () => {
  const g = setup();
  g.pill('Taglio').props.onClick();
  g.render();
  assert.deepEqual(g.items().map((i) => i.service_id), [3]);
  // prima un secondo clic aggiungeva un altro Taglio alla stessa cliente
  g.pill('Taglio').props.onClick();
  g.render();
  assert.deepEqual(g.items(), []);
});

test('orari come in «Nuova prenotazione», scelto resta la riga con «Cambia orario»; il piede crea con il totale', async () => {
  const g = setup();
  assert.equal(textOf(g.createBtn()), 'Manca cliente, servizio o orario');
  // attenuato ma premibile, come in «Nuova prenotazione»: dice che cosa manca
  assert.equal(g.createBtn().props['aria-disabled'], true);
  g.createBtn().props.onClick();
  assert.deepEqual(globalThis.__dash.fireToast.calls.at(-1)[0], { msg: 'Cliente 1 · manca: cliente · servizio', icon: 'alert' });
  assert.equal(g.calls.post.length, 0);
  find(g.row.tree, (el) => el.type?.name === 'ClientPicker').props.onChange({ id: 7, full_name: 'Maria Russo' });
  g.render();
  g.pill('Taglio').props.onClick();
  g.render();
  await flush();
  g.render();
  const steps = findAll(g.row.tree, (el) => el.type?.name === 'StepLabel').map((el) => el.props.n);
  assert.deepEqual(steps, [1, 2, 3], 'con un servizio compare il passo dell\'orario');
  const chips = findAll(g.row.tree, (el) => el.type?.name === 'SlotChip');
  assert.deepEqual(chips.map((c) => c.props.s.start), [at(600), at(630)]);
  chips[1].type(chips[1].props).props.onClick();
  g.render();
  assert.ok(textOf(g.row.tree).includes('Cambia orario'), 'gli altri orari si chiudono');
  assert.equal(findAll(g.row.tree, (el) => el.type?.name === 'SlotChip').length, 0);
  // il piede: chi è pronta (con l'ora) e il pulsante col totale
  assert.ok(textOf(g.m.tree).includes('Maria · 10:30'));
  assert.match(textOf(g.createBtn()), /^Crea 1 prenotazione · /);
  g.createBtn().props.onClick();
  await flush();
  assert.deepEqual(g.calls.post.map((p) => p.body), [{ client_id: 7, items: [{ service_id: 3, operator_id: null }], start: at(630), location_id: null }]);
});
