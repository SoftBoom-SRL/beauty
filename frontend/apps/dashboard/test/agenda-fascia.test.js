// Fascia oraria delle griglie e posizione di scorrimento (caccia ai bug del
// 22/09/2026, reperti 12-04 e 12-22). La griglia era fissa 08:00–20:00: la
// sposa forzata alle 07:00 non si vedeva e con i turni fino alle 21 la fascia
// 20–21 non si poteva usare. Sfogliando i giorni la griglia tornava in cima e
// l'ombra dell'appuntamento aperto finiva fuori schermo.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayGridRange, gridMarks, gridRange, openingFor, weekGridRange } from '../src/sections/agenda/lib.js';
import { find, findAll, installDom, loadComponent, mount, ptr, rect, spy, textOf, tick } from './grid-harness.mjs';

// i pezzi senza hook delle griglie, che per i test fanno parte di DayGrid e WeekView
const DAY_PARTS = ['OperatorHeaderCell', 'OpColorPicker', 'HourGutter', 'GridLines', 'NowLine', 'ClosedHours', 'GhostBlocks', 'VisitBlocks', 'DayDragBadge'];
const { default: DayGrid } = await loadComponent('apps/dashboard/src/sections/agenda/DayGrid.jsx', { expand: DAY_PARTS });
const WEEK_PARTS = ['WeekDayHeader', 'HourGutter', 'WeekDayColumn', 'GridLines', 'NowLine', 'WeekDragBadge'];
const { default: WeekView } = await loadComponent('apps/dashboard/src/sections/agenda/WeekView.jsx', { expand: WEEK_PARTS });

const PXM = 1.35;
const DATE = '2026-10-03';   // sabato
const at = (hm, d = DATE) => `${d}T${hm}:00+02:00`;
const one = (id, op, hm, dur, d = DATE) => ({
  id, status: 'confirmed', operator_id: op, start: at(hm, d), client: { id: id + 100, full_name: 'Cliente ' + id },
  total_duration_min: dur, total_price: '50.00',
  items: [{ id: id * 10, service_id: 1, service_name: 'Acconciatura', operator_id: op, duration_min: dur, soak_min: 0, order: 0 }],
});
const WEEK_HOURS = { 0: [['09:00', '19:00']], 1: [['09:00', '19:00']], 2: [['09:00', '19:00']], 3: [['09:00', '19:00']], 4: [['09:00', '19:00']], 5: [['09:00', '19:00']], 6: [] };

test('senza orari né turni la fascia resta 08–20, e si allarga per quello che c\'è', () => {
  assert.deepEqual(gridRange([], []), { start: 8 * 60, end: 20 * 60 });
  assert.deepEqual(gridRange([], [[7 * 60, 9 * 60]]), { start: 7 * 60, end: 20 * 60 });
  // a ore piene
  assert.deepEqual(gridRange([[9 * 60 + 30, 18 * 60 + 15]]), { start: 9 * 60, end: 19 * 60 });
  // mai oltre la mezzanotte
  assert.deepEqual(gridRange([[22 * 60, 23 * 60]], [[23 * 60, 25 * 60]]), { start: 22 * 60, end: 24 * 60 });
});

test('la fascia del giorno segue orari del centro, turni, appuntamenti e pause', () => {
  const rows = [
    { operator: { id: 1 }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
    { operator: { id: 2 }, windows: [['10:00', '21:00']], appointments: [], pauses: [] },
  ];
  assert.deepEqual(dayGridRange(rows, [['09:00', '19:00']]), { start: 9 * 60, end: 21 * 60 });
  // la sposa forzata alle 07:00
  const withBride = [{ ...rows[0], appointments: [one(1, 1, '07:00', 90)] }, rows[1]];
  assert.deepEqual(dayGridRange(withBride, [['09:00', '19:00']]), { start: 7 * 60, end: 21 * 60 });
  // una pausa dopo la chiusura e l'ombra dell'appuntamento aperto
  const withPause = [{ ...rows[0], pauses: [{ id: 1, operator_id: 1, start: at('21:15'), duration_min: 30 }] }, rows[1]];
  assert.deepEqual(dayGridRange(withPause, []), { start: 9 * 60, end: 22 * 60 });
  assert.deepEqual(dayGridRange(rows, [], one(9, 1, '06:30', 30, '2026-10-06')), { start: 6 * 60, end: 21 * 60 });
  // gli annullati non allargano niente
  const cancelled = [{ ...rows[0], appointments: [{ ...one(2, 1, '06:00', 30), status: 'cancelled' }] }, rows[1]];
  assert.deepEqual(dayGridRange(cancelled, []), { start: 9 * 60, end: 21 * 60 });
});

test('la fascia della settimana e i segni orari coprono tutta la fascia', () => {
  const days = [{ date: DATE, appointments: [{ id: 1, start: at('07:00'), duration_min: 60 }] }];
  assert.deepEqual(weekGridRange(days, WEEK_HOURS), { start: 7 * 60, end: 19 * 60 });
  assert.deepEqual(weekGridRange([], {}), { start: 8 * 60, end: 20 * 60 });
  const marks = gridMarks(15, 7 * 60, 21 * 60);
  assert.equal(marks[0].m, 7 * 60);
  assert.equal(marks.at(-1).m, 21 * 60);
  assert.deepEqual(openingFor({ opening_hours_week: WEEK_HOURS }, DATE), [['09:00', '19:00']]);
  assert.deepEqual(openingFor({ opening_hours_week: WEEK_HOURS }, '2026-10-04'), [], 'domenica chiuso');
  assert.deepEqual(openingFor({}, DATE), []);
});

/* ---- vista giorno ---- */
function day(rows, extra = {}, settings = {}) {
  installDom();
  globalThis.__dash = {
    t: (it) => it, lang: 'it', settings: { slot_interval_min: 15, ...settings }, modal: null, services: [],
    operators: [{ id: 1, first_name: 'Anna', service_ids: [] }, { id: 2, first_name: 'Giulia', service_ids: [] }],
  };
  const scrollEl = {
    scrollTop: 0, clientHeight: 600,
    getBoundingClientRect: () => rect(0, 100, 1000, 600),
    querySelector: (sel) => (sel === '.dk-tl-cols' ? colsEl : null),
    querySelectorAll: () => [], setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
  };
  const colsEl = { getBoundingClientRect: () => rect(64, 160 - scrollEl.scrollTop, 936, 16 * 60 * PXM), parentElement: { offsetTop: 60 } };
  const headEl = { offsetHeight: 60, getBoundingClientRect: () => rect(0, 100, 1000, 60) };
  const cb = {};
  for (const k of ['onOpenAppt', 'onSlotMenu', 'onInvalidDrop', 'onDropOnDate', 'onDragChange', 'onSplitItem', 'onMoveAppt',
    'onResizeItem', 'onMovePause', 'onResizePause', 'onDeletePause', 'onHover', 'onLeave', 'setPicker', 'setOpColor']) cb[k] = spy();
  const m = mount(DayGrid, {
    rows, allRows: rows, date: DATE, nowMin: null, colorOf: () => '#C9B8F2', itemColor: null, pending: null, canWrite: true,
    showRevenue: false, picker: null, opPalette: [], pickMode: false, ghost: null, zoom: 1, onZoom: null, ...cb, ...extra,
  }, {
    attach: (tree) => {
      tree.props.ref.current = scrollEl;
      const head = find(tree, (el) => el !== tree && el.props?.ref);
      if (head) head.props.ref.current = headEl;
    },
  });
  return { m, cb, scrollEl };
}
const hourLabels = (tree) => findAll(tree, (el) => el.type === 'div' && el.props?.className === 'tabnum' && /^\d\d:00$/.test(textOf(el))).map((el) => textOf(el));

test('vista giorno: la sposa delle 07:00 è in griglia, non sotto l\'intestazione', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [one(1, 1, '07:00', 90)], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  const { m } = day(rows);
  assert.equal(hourLabels(m.tree)[0], '07:00');
  const blk = find(m.tree, (el) => typeof el.type === 'function' && el.props.block?.item?.id === 10);
  const out = blk.type(blk.props);
  assert.ok(out.props.style.top >= 0, `il blocco comincia dentro la griglia (top ${out.props.style.top})`);
});

test('vista giorno: con i turni fino alle 21 la fascia 20–21 si clicca e ci si trascina', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '21:00']], appointments: [one(3, 1, '18:00', 30)], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  const { m, cb } = day(rows);
  assert.equal(hourLabels(m.tree).at(-1), '21:00');
  // clic alle 20:30 nella colonna di Anna
  const col = find(m.tree, (el) => el.key === 1 && typeof el.props?.onClick === 'function' && el.props.style?.position === 'relative');
  const labels = hourLabels(m.tree);
  const g0 = Number(labels[0].slice(0, 2)) * 60;
  const target = { getBoundingClientRect: () => rect(64, 160, 468, 13 * 60 * PXM) };
  col.props.onClick({ target, currentTarget: target, clientX: 300, clientY: 160 + (20 * 60 + 30 - g0) * PXM + 1 });
  assert.equal(cb.onSlotMenu.calls[0]?.[1], 20 * 60 + 30);
  // trascinamento dalle 18:00 alle 20:15: non si ferma alle 19:45
  const blk = find(m.tree, (el) => typeof el.type === 'function' && el.props.block?.item?.id === 30);
  blk.props.onDown(ptr(300, 400));
  m.tree.props.onPointerMove(ptr(300, 400 + 135 * PXM));
  m.render();
  m.tree.props.onPointerUp(ptr(300, 400 + 135 * PXM));
  const moved = cb.onMoveAppt.calls[0] || cb.onInvalidDrop.calls[0];
  assert.ok(moved, 'lo spostamento parte');
  const start = cb.onMoveAppt.calls[0] ? cb.onMoveAppt.calls[0][1] : cb.onInvalidDrop.calls[0][2].newApptStart;
  assert.equal(start, 20 * 60 + 15);
});

test('vista giorno: sul giorno dopo la griglia resta alla stessa ora', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  // il giorno prima si guardava dalle 14:00 in giù
  const scrollMemo = { current: 14 * 60 };
  const { scrollEl } = day(rows, { scrollMemo });
  assert.equal(scrollEl.scrollTop, (14 * 60 - 9 * 60) * PXM);
});

test('vista giorno: l\'ombra fuori vista viene portata in vista', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  // appuntamento aperto nel pannello: martedì alle 17:30 con Anna; a video sabato, griglia in cima
  const ghost = one(7, 1, '17:30', 60, '2026-09-29');
  const { scrollEl } = day(rows, { ghost });
  const top = (17 * 60 + 30 - 9 * 60) * PXM;
  assert.ok(scrollEl.scrollTop <= top && top < scrollEl.scrollTop + 600 - 60, `l'ombra (y ${top}) è nell'area visibile (scrollTop ${scrollEl.scrollTop})`);
});

/* ---- vista settimana ---- */
test('vista settimana: l\'appuntamento delle 07:00 è in griglia', async () => {
  installDom();
  let resolveWeek = null;
  globalThis.__api = {
    get: () => new Promise((r) => { resolveWeek = r; }),
    post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t: (it) => it, lang: 'it', showRevenue: false, fireToast: spy(), openModal: spy(), hasScope: () => true,
    settings: { slot_interval_min: 15, opening_hours_week: WEEK_HOURS }, locationId: null, modal: null,
    live: { subscribe: () => () => {} },
  };
  const scrollEl = {
    scrollTop: 0, clientHeight: 600, getBoundingClientRect: () => rect(0, 100, 1000, 600),
    querySelector: () => null, querySelectorAll: () => [], setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
  };
  const m = mount(WeekView, {
    weekStart: '2026-09-28', operators: [{ id: 1, first_name: 'Anna', last_name: 'Neri' }], colorOf: () => '#C9B8F2',
    itemColor: null, nowMin: null, onOpenDay: spy(), onNewAppt: spy(), onOpenAppt: spy(), onShowDate: spy(),
    pickMode: false, ghost: null, ghostDate: '2026-09-28', zoom: 1, onZoom: null,
  }, { attach: (tree) => { if (tree?.props?.ref) tree.props.ref.current = scrollEl; } });
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  resolveWeek(dates.map((date) => ({
    date, count: date === DATE ? 1 : 0, by_status: {},
    appointments: date === DATE ? [{ id: 1, start: at('07:00'), client_name: 'Sposa', operator_id: 1, status: 'confirmed', duration_min: 90, total_price: '50.00', items: [] }] : [],
  })));
  await tick();
  m.render();
  const labels = hourLabels(m.tree);
  assert.equal(labels[0], '07:00');
  assert.equal(labels.at(-1), '19:00', 'fino alla chiusura del centro');
  const blk = find(m.tree, (el) => typeof el.type === 'function' && el.props.a?.id === 1);
  const out = blk.type(blk.props);
  assert.ok(out.props.style.top >= 0, `il blocco comincia dentro la griglia (top ${out.props.style.top})`);
  assert.ok(textOf(out).includes('Sposa'));
});
