// Aggiuntivi in agenda (15/10): servizi che si fanno durante un altro — la
// nail art durante la manicure. La loro voce dura 0 minuti: niente blocco in
// griglia ma un'etichetta «+ Nail art» dentro il blocco del servizio, nessuna
// spina, fascia o segmento in settimana, niente «occupata» negli slot; nel
// dettaglio e nella nuova prenotazione stanno sotto il servizio col prezzo, e
// non cambiano la durata. Prima le voci senza tempo sarebbero state blocchi
// alti zero, contati come servizi veri da trascinamento, stacco e slot.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { isoAtMin, parseISO, toDateStr, todayStr } from '@youty/shared';
import {
  addonGroups, bookingRows, explainSlot, insertAddonRow, isAddonItem, isAddonRow, itemBlocks, nextTimedIndex, opSegments,
  prevTimedIndex, removeRowWithAddons, serviceBands, setRowOperator, visitSpines,
} from '../src/sections/agenda/lib.js';
import { dayDragContext, skillVerdict } from '../src/sections/agenda/lib/drag.js';
import { weekGhostSpans } from '../src/sections/agenda/lib/week.js';
import { find, findAll, installDom, loadComponent, mount, spy, textOf } from './grid-harness.mjs';

const { default: ItemBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/ItemBlock.jsx');
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');
const { default: ApptHoverCard } = await loadComponent('apps/dashboard/src/sections/agenda/grid/ApptHoverCard.jsx');
const { default: SvcEditModal } = await loadComponent('apps/dashboard/src/sections/servizi/SvcEditModal.jsx');
const { default: ServiziSub } = await loadComponent('apps/dashboard/src/sections/servizi/ServiziSub.jsx');
const { default: NewApptModal } = await loadComponent('apps/dashboard/src/sections/agenda/modals/NewApptModal.jsx', {
  stubs: ['ClientPicker.jsx'],
  expand: ['BookingFoot', 'DateBar', 'ServiceStep', 'TimeStep', 'ManualTime'],
});
const { default: ApptDetailModal } = await loadComponent('apps/dashboard/src/sections/agenda/modals/ApptDetailModal.jsx', {
  expand: [
    'DetailFooter', 'ClientMetaBar', 'WhoWhenCard', 'DepositCard', 'NoteEditor', 'MarginSection', 'ServicesReadOnly', 'ServicesEditor',
    'ReasonPicker', 'WhoCancels',
  ],
});

const t = (it) => it;
const TODAY = todayStr();
const plus = (n) => { const d = parseISO(TODAY); d.setDate(d.getDate() + n); return toDateStr(d); };
const DAY = plus(3);
const at = (min) => isoAtMin(DAY, min);
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); });

/* Una visita alle 10:00: manicure con Anna (60'), la sua nail art (0'), poi un
 * taglio con Bea (30'). */
const row = (id, sid, name, op, dur, soak, price, order) => ({
  id, service_id: sid, service_name: name, operator_id: op, operator_name: op === 1 ? 'Anna' : 'Bea',
  duration_min: dur, soak_min: soak, price, order,
});
const visit = (items) => ({
  id: 77, status: 'confirmed', operator_id: 1, start: at(600), client: { id: 7, full_name: 'Maria Russo' },
  items: items || [
    row(1, 10, 'Manicure', 1, 60, 0, '40.00', 0),
    row(2, 20, 'Nail art', 1, 0, 0, '10.00', 1),
    row(3, 30, 'Taglio', 4, 30, 0, '30.00', 2),
  ],
});

/* ---- regole pure -------------------------------------------------------- */

test('una voce senza tempo è un aggiuntivo; il campo svuotato mentre si scrive no', () => {
  assert.equal(isAddonItem({ duration_min: 0, soak_min: 0 }), true);
  assert.equal(isAddonItem({ duration_min: 0 }), true);
  assert.equal(isAddonItem({ duration_min: 0, soak_min: 20 }), false, 'un\'attesa è tempo');
  assert.equal(isAddonItem({ duration_min: '', soak_min: 0 }), false);
  assert.equal(isAddonItem({ duration_min: 30 }), false);
  // nelle bozze conta il segno messo alla nascita della riga
  assert.equal(isAddonRow({ duration_min: 0, addon: false }), false);
  assert.equal(isAddonRow({ duration_min: 45, addon: true }), true);
});

test('i blocchi sono i servizi con tempo: la nail art sta dentro la manicure', () => {
  const blocks = itemBlocks(visit());
  assert.deepEqual(blocks.map((b) => b.item.service_name), ['Manicure', 'Taglio']);
  assert.deepEqual(blocks[0].addons.map((x) => x.service_name), ['Nail art']);
  assert.deepEqual(blocks.map((b) => [b.startMin, b.dur, b.total, b.index]), [[600, 60, 2, 0], [660, 30, 2, 1]]);
  // un aggiuntivo in testa (visita di prima delle regole) non sparisce
  const odd = itemBlocks(visit([row(2, 20, 'Nail art', 1, 0, 0, '10.00', 0), row(1, 10, 'Manicure', 1, 60, 0, '40.00', 1)]));
  assert.deepEqual(odd.map((b) => [b.item.service_name, b.addons.map((x) => x.service_name)]), [['Manicure', ['Nail art']]]);
});

test('la nail art di una collega non la rende occupata in quel momento', () => {
  // Bea fa la nail art alla fine della manicure di Anna (11:00): dalle 10:30 alle 11:30 è libera
  const v = visit([row(1, 10, 'Manicure', 1, 60, 0, '40.00', 0), row(2, 20, 'Nail art', 4, 0, 0, '10.00', 1)]);
  const anna = { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [v], pauses: [] };
  const bea = { operator: { id: 4, name: 'Bea Rossi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] };
  const verdict = explainSlot(bea, 630, 60, { rows: [anna, bea], t });
  assert.equal(verdict.code, 'ok', verdict.label);
});

test('manicure + nail art è una visita da un servizio: niente spina, fasce né segmenti in più', () => {
  const v = visit([row(1, 10, 'Manicure', 1, 60, 0, '40.00', 0), row(2, 20, 'Nail art', 4, 0, 0, '10.00', 1)]);
  const placed = itemBlocks(v).map((b) => ({ b, pos: { startMin: b.startMin, activeMin: b.activeMin, soakMin: b.soakMin } }));
  assert.deepEqual(visitSpines(placed), []);
  assert.deepEqual(serviceBands(v), []);
  assert.deepEqual(opSegments(v), [{ opId: 1, w: 60 }]);
  // con un servizio vero in più le fasce sono due, senza la nail art
  assert.deepEqual(serviceBands(visit()).map((b) => [b.name, b.minutes]), [['Manicure', 60], ['Taglio', 30]]);
  // e in settimana l'ombra della visita aperta non ha un pezzo per lei
  assert.deepEqual(weekGhostSpans(visit()).map((s) => [s.startMin, s.dur]), [[600, 60], [660, 30]]);
});

test('passare la manicure a chi non fa la nail art si dice prima del rilascio', () => {
  const ctx = dayDragContext({
    rows: [{ operator: { id: 1, name: 'Anna Neri' }, windows: [], appointments: [visit()], pauses: [] },
      { operator: { id: 4, name: 'Bea Rossi' }, windows: [], appointments: [], pauses: [] }],
    operators: [{ id: 1, service_ids: [10, 20, 30] }, { id: 4, service_ids: [10, 30] }],
    step: 15, nowMin: null, t,
  });
  const manicure = itemBlocks(visit())[0];
  const verdict = skillVerdict(ctx, 4, [manicure]);
  assert.equal(verdict.code, 'skill');
  assert.equal(verdict.label, 'Bea non fa Nail art');
  assert.equal(skillVerdict(ctx, 1, [manicure]), null);
});

test('righe di una bozza: l\'aggiuntivo va dopo il suo servizio, lo segue e se ne va con lui', () => {
  const rows = [
    { key: 'a', service_id: 10, operator_id: 1 },
    { key: 'b', service_id: 20, operator_id: 1, addon: true },
    { key: 'c', service_id: 30, operator_id: 4 },
  ];
  const added = insertAddonRow(rows, 'a', { key: 'd', service_id: 21, operator_id: 1 });
  assert.deepEqual(added.map((r) => [r.key, !!r.addon]), [['a', false], ['b', true], ['d', true], ['c', false]]);
  assert.equal(insertAddonRow(rows, 'zz', { key: 'd' }), rows, 'senza servizio niente');
  // cambia mano la manicure: la seguono gli aggiuntivi che faceva Anna e che Bea sa fare
  const moved = setRowOperator(added, 'a', 4, (sid) => sid === 20);
  assert.deepEqual(moved.map((r) => [r.key, r.operator_id]), [['a', 4], ['b', 4], ['d', 1], ['c', 4]]);
  // l'attesa si scrive sul servizio prima, non sulla nail art che sta in mezzo
  assert.equal(prevTimedIndex(added, 3), 0);
  assert.equal(nextTimedIndex(added, 0), 3);
  assert.equal(nextTimedIndex(added, 3), -1);
  // togliendo la manicure se ne va anche la nail art; togliendo la nail art solo lei
  assert.deepEqual(removeRowWithAddons(added, 'a').map((r) => r.key), ['c']);
  assert.deepEqual(removeRowWithAddons(added, 'b').map((r) => r.key), ['a', 'd', 'c']);
  // «Rifai la visita»: l'aggiuntivo in testa non ha a chi appoggiarsi
  const mk = (id) => ({ key: 'k' + id, service_id: id });
  assert.deepEqual(bookingRows([20, 10, 20, 30], (id) => id === 20, mk).map((r) => [r.service_id, !!r.addon]), [[10, false], [20, true], [30, false]]);
  assert.deepEqual(addonGroups(added, isAddonRow).map((g) => [g.item.key, g.addons.map((x) => x.key)]), [['a', ['b', 'd']], ['c', []]]);
});

/* ---- come si vedono ----------------------------------------------------- */

test('in giornata la nail art è un\'etichetta nel blocco della manicure', () => {
  installDom();
  const block = itemBlocks(visit())[0];
  const tree = ItemBlock({
    block, startMin: block.startMin, activeMin: block.activeMin, soakMin: block.soakMin, color: '#FFD1DC',
    soakLabel: 'POSA', t, lang: 'it', canWrite: true, onDown: () => {}, onResizeDown: () => {},
  });
  const label = find(tree, (el) => el.props?.['data-addon'] === 2);
  assert.equal(textOf(label), '+ Nail art');
  // due blocchi in tutto: la manicure è il servizio 1 di 2, non di 3
  assert.ok(textOf(tree).includes('1/2'));
});

test('in settimana: «×2» conta i servizi, e la nail art si legge dove c\'è posto', () => {
  const a = { ...visit(), client_name: 'Maria Russo', startMin: 600, endMin: 690 };
  const tree = WeekBlock({ a, colorOf: () => '#AACCEE', t, canWrite: true, pxm: 2 });
  const text = textOf(tree);
  assert.ok(text.includes('×2'));
  assert.ok(text.includes('+ Nail art'));
});

test('nella scheda al passaggio del mouse la nail art è accanto alla manicure', () => {
  installDom();
  const tree = ApptHoverCard({ hover: { a: visit(), x: 0, y: 0, side: 'right' }, t, lang: 'it', operators: [], colorOf: () => '#ccc' });
  const text = textOf(tree);
  assert.ok(text.includes('Manicure+ Nail art + Taglio'), text);
});

/* ---- listino ------------------------------------------------------------ */

test('scheda del servizio: «Aggiuntivo» si accende e parte col salvataggio, senza la posa', async () => {
  installDom();
  const onSave = spy(() => Promise.resolve());
  const m = mount(SvcEditModal, {
    service: { id: 5, name_it: 'Nail art', category_id: 1, duration_min: 15, soak_min: 0, price: '10.00', active: true, order: 0 },
    categories: [{ id: 1, name_it: 'Unghie', color: '#FDE2E4', order: 0 }], operators: [], canTeam: false, canPricing: true,
    onSave, onClose: spy(), onCatColor: spy(), t, lang: 'it',
  });
  const toggle = () => find(m.tree, (el) => typeof el.type === 'function' && el.type.name === 'FRow' && el.props.label === 'Aggiuntivo');
  assert.ok(toggle(), 'c\'è l\'interruttore');
  assert.equal(toggle().props.hint, 'Si fa durante un altro servizio: aggiunge il prezzo, non il tempo');
  const sw = find(toggle(), (el) => typeof el.type === 'function' && 'on' in el.props);
  assert.equal(sw.props.on, false);
  sw.props.onChange(true);
  m.render();
  assert.ok(find(m.tree, (el) => el.props?.label === 'Durata indicativa'));
  assert.equal(find(m.tree, (el) => el.props?.label === 'Tempo di posa'), null, 'niente posa per un aggiuntivo');
  const foot = find(m.tree, (el) => el.props?.foot).props.foot;
  find(foot, (el) => el.type === 'button' && textOf(el).includes('Salva')).props.onClick();
  await Promise.resolve();
  assert.equal(onSave.calls.at(-1)[0].is_addon, true);
});

test('nell\'elenco dei servizi l\'aggiuntivo ha il suo segno', () => {
  installDom();
  const services = [
    { id: 5, name_it: 'Nail art', category_id: 1, duration_min: 15, soak_min: 0, price: '10.00', active: true, order: 1, is_addon: true },
    { id: 6, name_it: 'Manicure', category_id: 1, duration_min: 60, soak_min: 0, price: '40.00', active: true, order: 0 },
  ];
  const m = mount(ServiziSub, {
    services, loading: false, categories: [{ id: 1, name_it: 'Unghie', color: '#FDE2E4', order: 0 }], operators: [],
    canEdit: true, onCats: spy(), onEdit: spy(), onNew: spy(), onToggleActive: spy(), t, lang: 'it',
  });
  const marks = findAll(m.tree, (el) => el.type === 'span' && textOf(el) === '+ aggiuntivo');
  assert.equal(marks.length, 1);
});

/* ---- nuova prenotazione --------------------------------------------------- */

const OPS = [
  { id: 1, first_name: 'Anna', last_name: 'Neri', initials: 'AN', service_ids: [3, 4, 9] },
  { id: 4, first_name: 'Bea', last_name: 'Rossi', initials: 'BR', service_ids: [3, 4] },
];
const SERVICES = [
  { id: 3, name_it: 'Taglio', duration_min: 30, soak_min: 0, price: '35.00', category_id: 1 },
  { id: 4, name_it: 'Colore', duration_min: 60, soak_min: 30, price: '60.00', category_id: 1 },
  { id: 9, name_it: 'Nail art', duration_min: 15, soak_min: 0, price: '10.00', category_id: 1, is_addon: true },
];

function newBooking(prefill) {
  installDom();
  const calls = { get: [], post: [] };
  globalThis.__api = {
    get: (url, opts) => {
      calls.get.push({ url, opts });
      if (url === '/api/clients/7') return Promise.resolve({ id: 7, full_name: 'Maria Russo' });
      if (url === '/api/marketing/gift-cards') return Promise.resolve({ items: [] });
      if (url === '/api/agenda/availability') return Promise.resolve([{ start: at(600), assignment: [] }]);
      return Promise.resolve([]);
    },
    post: (url, body) => { calls.post.push({ url, body }); return Promise.resolve({ id: 99, start: body.start, deposit_status: 'none' }); },
    put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t, lang: 'it', services: SERVICES, serviceCategories: [], operators: OPS, fireToast: spy(),
    hasScope: () => true, settings: { slot_interval_min: 15 }, agendaPick: null, setAgendaPick: spy(), setTab: spy(), locationId: null,
  };
  const m = mount(NewApptModal, { prefill, onClose: spy(), onCreated: spy() });
  mounted.push(m);
  return { m, calls, button: (text) => find(m.tree, (el) => el.type === 'button' && textOf(el).includes(text)) };
}
const settle = async (g) => { await flush(); g.m.render(); await flush(); g.m.render(); };

test('nuova prenotazione: la nail art non è fra i servizi, si aggiunge col «+» sotto il taglio', async () => {
  const g = newBooking({ clientId: 7, clientName: 'Maria Russo', serviceIds: [3], date: DAY, start: at(600), operatorId: 1 });
  await settle(g);
  // fra le pillole dei servizi non c'è: da sola non si prenota
  const pills = findAll(g.m.tree, (el) => el.type === 'button' && el.props.className === 'dk-pill' && el.props.title?.includes('€'));
  assert.deepEqual(pills.map((p) => textOf(p)), ['Taglio', 'Colore']);
  g.button('Aggiuntivo').props.onClick();
  g.m.render();
  g.button('+ Nail art').props.onClick();
  await settle(g);
  // la ricerca degli orari la porta dietro al taglio, con chi fa il taglio
  const avail = g.calls.get.filter((x) => x.url === '/api/agenda/availability');
  assert.deepEqual(avail.at(-1).opts.params.items, [{ service_id: 3, operator_id: 1 }, { service_id: 9, operator_id: 1 }]);
  // la durata resta quella del taglio, il prezzo cresce
  assert.ok(textOf(g.m.tree).includes('1 servizio + 1 aggiuntivo · 30m'));
  assert.ok(textOf(g.m.tree).includes('Crea prenotazione · €45,00'));
  g.button('Crea prenotazione').props.onClick();
  await settle(g);
  const create = g.calls.post.find((p) => p.url === '/api/agenda/appointments');
  assert.deepEqual(create.body.items, [{ service_id: 3, operator_id: 1 }, { service_id: 9, operator_id: 1 }]);
});

test('nuova prenotazione: togliendo il taglio se ne va anche la sua nail art; rifatta da una visita, la nail art in testa resta fuori', async () => {
  const g = newBooking({ clientId: 7, clientName: 'Maria Russo', serviceIds: [9, 3, 9], date: DAY, start: at(600), operatorId: 1 });
  await settle(g);
  let avail = g.calls.get.filter((x) => x.url === '/api/agenda/availability');
  assert.deepEqual(avail.at(-1).opts.params.items.map((i) => i.service_id), [3, 9]);
  const remove = find(g.m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Rimuovi');
  remove.props.onClick();
  await settle(g);
  assert.ok(textOf(g.m.tree).includes('Manca servizio'), 'nessun aggiuntivo rimasto da solo');
  avail = g.calls.get.filter((x) => x.url === '/api/agenda/availability');
  assert.deepEqual(avail.at(-1).opts.params.items.map((i) => i.service_id), [3, 9], 'nessuna ricerca con la sola nail art');
});

/* ---- dettaglio ------------------------------------------------------------ */

function detail(appt) {
  installDom();
  const calls = { get: [], put: [] };
  globalThis.__api = {
    get: (url, opts) => {
      calls.get.push({ url, opts });
      if (url === '/api/agenda/appointments/41') return Promise.resolve(appt);
      if (url === '/api/clients/7') return Promise.resolve({ id: 7, visits: 0 });
      return Promise.resolve([]);
    },
    post: () => Promise.resolve({ ...appt }),
    put: (url, body) => { calls.put.push({ url, body }); return Promise.resolve({ ...appt }); },
    patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t, lang: 'it', operators: OPS, opColors: {}, services: SERVICES.concat([{ id: 8, name_it: 'Scrub', duration_min: 10, soak_min: 0, price: '8.00', category_id: 1, is_addon: true }]),
    serviceCategories: [], settings: { slot_interval_min: 15, cancel_min_hours: 24 }, session: { is_owner: true },
    fireToast: spy(), openModal: spy(), setTab: spy(), setDeepLink: spy(), setSelClient: spy(), hasScope: () => true,
  };
  const m = mount(ApptDetailModal, { appointment: appt, onMutate: spy(), onClose: spy(), onShowDate: spy() });
  mounted.push(m);
  return {
    m, calls,
    panelFoot: () => find(m.tree, (el) => el.type?.name === 'DkPanel').props.foot,
    button: (text) => find(m.tree, (el) => el.type === 'button' && textOf(el).includes(text)),
  };
}

test('dettaglio: la nail art sta sotto il taglio, senza orari, e se ne aggiunge un\'altra col «+»', async () => {
  const appt = {
    id: 41, status: 'confirmed', operator_id: 1, start: at(600), total_duration_min: 30, total_price: '45.00',
    client: { id: 7, full_name: 'Maria Russo' }, note: '', deposit_status: 'none', deposit_amount: '0.00',
    items: [
      { id: 411, service_id: 3, service_name: 'Taglio', operator_id: 1, operator_name: 'Anna', duration_min: 30, soak_min: 0, price: '35.00', order: 0 },
      { id: 412, service_id: 9, service_name: 'Nail art', operator_id: 1, operator_name: 'Anna', duration_min: 0, soak_min: 0, price: '10.00', order: 1 },
    ],
    updated_at: '2026-09-20T08:00:00.000000+00:00',
  };
  const g = detail(appt);
  await flush(); g.m.render();
  const addonRows = findAll(g.m.tree, (el) => el.props?.['data-addon-row'] != null);
  assert.deepEqual(addonRows.map((el) => textOf(el)), ['+ Nail art€10,00']);
  // una sola durata da scrivere: quella del taglio
  assert.equal(findAll(g.m.tree, (el) => el.props?.['aria-label'] === 'Durata in minuti').length, 1);
  // «Aggiungi servizio» offre solo i servizi veri
  g.button('Aggiungi servizio').props.onClick();
  g.m.render();
  assert.equal(g.button('Nail art'), null);
  // il «+» sotto il taglio: lo scrub va dopo la nail art, con chi fa il taglio se lo sa fare
  g.button('Aggiuntivo').props.onClick();
  g.m.render();
  g.button('+ Scrub').props.onClick();
  g.m.render();
  find(g.panelFoot(), (el) => el.type === 'button' && textOf(el).includes('Salva')).props.onClick();
  await flush(); g.m.render();
  assert.deepEqual(g.calls.put.at(-1).body.items, [
    { id: 411, service_id: 3, operator_id: 1, duration_min: 30, soak_min: 0 },
    { id: 412, service_id: 9, operator_id: 1, duration_min: 0, soak_min: 0 },
    { service_id: 8, operator_id: null, duration_min: 0, soak_min: 0 },
  ]);
});
