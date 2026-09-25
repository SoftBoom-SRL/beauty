// Fascia oraria delle griglie e posizione di scorrimento (caccia ai bug del
// 22/09/2026, reperti 12-04 e 12-22). La griglia era fissa 08:00–20:00: la
// sposa forzata alle 07:00 non si vedeva e con i turni fino alle 21 la fascia
// 20–21 non si poteva usare. Sfogliando i giorni la griglia tornava in cima e
// l'ombra dell'appuntamento aperto finiva fuori schermo.
// 25/09: stretta sulla giornata di lavoro, tolta la barra alta dell'agenda la
// griglia ci stava tutta nello schermo e non scorreva più (nei giorni senza
// appuntamenti per niente). Ora copre le 24 ore e si apre sulla giornata di
// lavoro; «Adatta» riempie lo schermo con quella.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { toDateStr, todayStr } from '@youty/shared';
import { GRID_DAY, dayGridRange, firstScrollMin, gridMarks, gridRange, mondayOf, openingFor, weekDaysOf, weekGridRange } from '../src/sections/agenda/lib.js';
import { find, findAll, installDom, loadComponent, mount, ptr, rect, spy, textOf, tick } from './grid-harness.mjs';

// i pezzi senza hook delle griglie, che per i test fanno parte di DayGrid e WeekView
const DAY_PARTS = ['OperatorHeaderCell', 'OpColorPicker', 'HourGutter', 'GridLines', 'NowLine', 'ClosedHours', 'GhostBlocks', 'VisitBlocks', 'DayDragBadge'];
const { default: DayGrid } = await loadComponent('apps/dashboard/src/sections/agenda/DayGrid.jsx', { expand: DAY_PARTS });
const WEEK_PARTS = ['WeekDayHeader', 'HourGutter', 'WeekDayColumn', 'GridLines', 'NowLine', 'WeekDragBadge'];
const { default: WeekView } = await loadComponent('apps/dashboard/src/sections/agenda/WeekView.jsx', { expand: WEEK_PARTS });
const { useAgendaZoom } = await loadComponent('apps/dashboard/src/sections/agenda/hooks/useAgendaZoom.js');

const PXM = 1.35;
const DATE = '2026-10-03';   // sabato
const at = (hm, d = DATE) => `${d}T${hm}:00+02:00`;
const one = (id, op, hm, dur, d = DATE) => ({
  id, status: 'confirmed', operator_id: op, start: at(hm, d), client: { id: id + 100, full_name: 'Cliente ' + id },
  total_duration_min: dur, total_price: '50.00',
  items: [{ id: id * 10, service_id: 1, service_name: 'Acconciatura', operator_id: op, duration_min: dur, soak_min: 0, order: 0 }],
});
const WEEK_HOURS = { 0: [['09:00', '19:00']], 1: [['09:00', '19:00']], 2: [['09:00', '19:00']], 3: [['09:00', '19:00']], 4: [['09:00', '19:00']], 5: [['09:00', '19:00']], 6: [] };

test('la giornata di lavoro: senza orari né turni 08–20, e si allarga per quello che c\'è', () => {
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

test('la griglia copre le 24 ore e si apre sulla giornata di lavoro', () => {
  assert.deepEqual(GRID_DAY, { start: 0, end: 24 * 60 });
  const work = { start: 9 * 60, end: 19 * 60 };
  // non oggi: mezz'ora prima che cominci (non la mezzanotte)
  assert.equal(firstScrollMin(work), 8 * 60 + 30);
  assert.equal(firstScrollMin(work, null), 8 * 60 + 30);
  // oggi, a giornata in corso: un'ora prima di adesso
  assert.equal(firstScrollMin(work, 15 * 60 + 20), 14 * 60 + 20);
  assert.equal(firstScrollMin(work, 9 * 60), 8 * 60);
  // oggi prima dell'apertura o dopo la chiusura: la giornata dall'inizio
  assert.equal(firstScrollMin(work, 7 * 60), 8 * 60 + 30);
  assert.equal(firstScrollMin(work, 22 * 60), 8 * 60 + 30);
  // la sposa delle 00:15 non manda sotto zero
  assert.equal(firstScrollMin({ start: 0, end: 60 }), 0);
  assert.equal(firstScrollMin({ start: 0, end: 60 }, 20), 0);
});

/* ---- vista giorno ---- */
/* `bodyTop`: dove comincia il corpo nel contenuto. Nel DOM vero è la testata
 * più 8 px di stacco (DayGrid); a filo della testata il controllo dell'ombra
 * dava lo stesso risultato con la formula vecchia e con quella giusta. */
function day(rows, extra = {}, settings = {}, bodyTop = 60) {
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
  const colsEl = { getBoundingClientRect: () => rect(64, 160 - scrollEl.scrollTop, 936, 16 * 60 * PXM), parentElement: { offsetTop: bodyTop } };
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
  const { m, scrollEl } = day(rows);
  assert.equal(hourLabels(m.tree)[0], '00:00');
  const blk = find(m.tree, (el) => typeof el.type === 'function' && el.props.block?.item?.id === 10);
  const out = blk.type(blk.props);
  assert.equal(out.props.style.top, 7 * 60 * PXM + 1.5, 'il blocco alle 07:00, dentro la griglia');
  // si apre mezz'ora prima della giornata di lavoro, che comincia con lei
  assert.equal(scrollEl.scrollTop, (6 * 60 + 30) * PXM);
});

test('vista giorno: senza appuntamenti la griglia copre le 24 ore e scorre', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [], appointments: [], pauses: [] },
  ];
  const { m, scrollEl } = day(rows);
  const body = find(m.tree, (el) => el.props?.['data-work-start'] != null);
  // alta 24 ore: in uno schermo da 600 px c'è sempre da scorrere
  assert.equal(body.props.style.height, 24 * 60 * PXM);
  assert.ok(body.props.style.height > scrollEl.clientHeight);
  assert.deepEqual([body.props['data-g0'], body.props['data-work-start'], body.props['data-work-end']], [0, 9 * 60, 19 * 60]);
  // il corpo è un livello a sé, sotto l'intestazione fissa: il blocco
  // trascinato non passa sopra i nomi delle operatrici
  assert.equal(body.props.style.zIndex, 0);
  assert.deepEqual([hourLabels(m.tree)[0], hourLabels(m.tree).at(-1)], ['00:00', '24:00']);
  // si apre alle 08:30, mezz'ora prima dei turni
  assert.equal(scrollEl.scrollTop, (8 * 60 + 30) * PXM);
  // fuori turno tratteggiato: la notte e la sera per Anna, tutto il giorno per Giulia
  const closed = findAll(m.tree, (el) => el.type === 'div' && typeof el.props?.style?.background === 'string' && el.props.style.background.startsWith('repeating-linear-gradient(135deg, rgba(17,24,39,0.07)'));
  const spans = closed.map((el) => [Math.round(el.props.style.top / PXM), Math.round((el.props.style.top + el.props.style.height) / PXM)]);
  assert.deepEqual(spans, [[0, 9 * 60], [19 * 60, 24 * 60], [0, 24 * 60]]);
  // la scritta sta vicino all'orario di lavoro (non alle 4 del mattino), al
  // centro per chi non è in turno
  const label = (el) => find(el, (x) => x.props?.className === 'dk-closed-label');
  assert.deepEqual(label(closed[0]).props.style, { bottom: 14 });
  assert.deepEqual(label(closed[1]).props.style, { top: 14 });
  assert.equal(label(closed[2]).props.style.top, '50%');
  assert.equal(textOf(label(closed[2])), 'Non in turno');
});

test('vista giorno: con i turni fino alle 21 la fascia 20–21 si clicca e ci si trascina', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '21:00']], appointments: [one(3, 1, '18:00', 30)], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  const { m, cb } = day(rows);
  assert.equal(hourLabels(m.tree).at(-1), '24:00');
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
  assert.equal(scrollEl.scrollTop, 14 * 60 * PXM);
});

test('vista giorno: oggi si apre un\'ora prima di adesso; a giornata finita dall\'inizio', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  const { scrollEl } = day(rows, { nowMin: 15 * 60 + 20, scrollMemo: { current: null } });
  assert.equal(scrollEl.scrollTop, (14 * 60 + 20) * PXM);
  // alle 22 la giornata è finita: si guarda dall'inizio (08:30), non dal fondo
  assert.equal(day(rows, { nowMin: 22 * 60, scrollMemo: { current: null } }).scrollEl.scrollTop, (8 * 60 + 30) * PXM);
  // un minuto già ricordato (sfogliando i giorni) vince su adesso
  assert.equal(day(rows, { nowMin: 15 * 60, scrollMemo: { current: 10 * 60 } }).scrollEl.scrollTop, 10 * 60 * PXM);
});

test('vista giorno: l\'ombra fuori vista viene portata in vista', () => {
  const rows = [
    { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
    { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '19:00']], appointments: [], pauses: [] },
  ];
  // appuntamento aperto nel pannello: martedì alle 17:30 con Anna; a video sabato, griglia in cima
  const ghost = one(7, 1, '17:30', 60, '2026-09-29');
  const { scrollEl } = day(rows, { ghost }, {}, 68);
  const top = 68 + (17 * 60 + 30) * PXM;                      // nel contenuto: corpo 8 px sotto la testata (60)
  assert.equal(scrollEl.scrollTop, top - 60 - 40, 'l\'ombra 40 px sotto la testata, contando lo stacco');
  assert.ok(top >= scrollEl.scrollTop + 60 && top + 24 <= scrollEl.scrollTop + 600, `l'ombra (y ${top}) è nell'area visibile (scrollTop ${scrollEl.scrollTop})`);
});

/* ---- vista settimana ---- */
/* La settimana montata: `dates` = i sette giorni (la sposa delle 07:00 il
 * sabato 03/10, se c'è), `scroll` e `querySelector` = quello che serve del
 * contenitore (scorrimento di lato, colonne dei giorni). */
async function week({ settings = { slot_interval_min: 15, opening_hours_week: WEEK_HOURS }, weekStart = '2026-09-28', dates = null, scroll = {}, querySelector = () => null, props = {} } = {}) {
  installDom();
  let resolveWeek = null;
  globalThis.__api = {
    get: () => new Promise((r) => { resolveWeek = r; }),
    post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t: (it) => it, lang: 'it', showRevenue: false, fireToast: spy(), openModal: spy(), hasScope: () => true,
    settings, locationId: null, modal: null,
    live: { subscribe: () => () => {} },
  };
  const scrollEl = {
    scrollTop: 0, clientHeight: 600, getBoundingClientRect: () => rect(0, 100, 1000, 600),
    querySelector, querySelectorAll: () => [], setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
    ...scroll,
  };
  const m = mount(WeekView, {
    weekStart, operators: [{ id: 1, first_name: 'Anna', last_name: 'Neri' }], colorOf: () => '#C9B8F2',
    itemColor: null, nowMin: null, onOpenDay: spy(), onNewAppt: spy(), onOpenAppt: spy(), onShowDate: spy(),
    pickMode: false, ghost: null, ghostDate: weekStart, zoom: 1, onZoom: null, ...props,
  }, { attach: (tree) => { if (tree?.props?.ref) tree.props.ref.current = scrollEl; } });
  const days = dates || ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  resolveWeek(days.map((date) => ({
    date, count: date === DATE ? 1 : 0, by_status: {},
    appointments: date === DATE ? [{ id: 1, start: at('07:00'), client_name: 'Sposa', operator_id: 1, status: 'confirmed', duration_min: 90, total_price: '50.00', items: [] }] : [],
  })));
  await tick();
  m.render();
  return { m, scrollEl };
}

test('vista settimana: l\'appuntamento delle 07:00 è in griglia', async () => {
  const { m, scrollEl } = await week();
  const labels = hourLabels(m.tree);
  assert.deepEqual([labels[0], labels.at(-1)], ['00:00', '24:00'], 'le 24 ore');
  const blk = find(m.tree, (el) => typeof el.type === 'function' && el.props.a?.id === 1);
  const out = blk.type(blk.props);
  assert.equal(out.props.style.top, 7 * 60 * PXM + 1, 'il blocco alle 07:00, dentro la griglia');
  assert.ok(textOf(out).includes('Sposa'));
  // si apre mezz'ora prima della giornata di lavoro della settimana (07:00)
  assert.equal(scrollEl.scrollTop, (6 * 60 + 30) * PXM);
  // fuori dagli orari del centro tratteggiato; la domenica chiusa tutta, con la scritta
  const closedOf = (i) => find(m.tree, (el) => el.props?.['data-daycol'] === i).props.children
    .flat(Infinity).find((el) => el?.props?.windows !== undefined && el.props.labels);
  assert.deepEqual(closedOf(0).props.windows, [['09:00', '19:00']]);
  assert.deepEqual(closedOf(6).props.windows, []);
  assert.deepEqual(closedOf(6).props.labels, { some: null, none: 'Chiuso' });
});

test('vista settimana: senza orari del centro impostati niente tratteggio', async () => {
  const { m } = await week({ settings: { slot_interval_min: 15 } });
  const col = find(m.tree, (el) => el.props?.['data-daycol'] === 0);
  assert.equal(col.props.children.flat(Infinity).find((el) => el?.props?.labels), undefined);
});

test('vista settimana: la settimana in corso si apre con oggi in vista', async () => {
  // una settimana più larga dello schermo (1000 px): sette giorni da 400 px
  // dopo la colonna delle ore (46); si parte da dove oggi NON si vede
  const today = todayStr();
  const days = weekDaysOf(mondayOf(today)).map((d) => toDateStr(d));
  const idx = days.indexOf(today);
  assert.ok(idx >= 0);
  const cols = days.map((_, i) => ({ offsetLeft: 46 + i * 400, offsetWidth: 400 }));
  const { scrollEl } = await week({
    weekStart: days[0], dates: days, scroll: { scrollLeft: idx >= 3 ? 0 : 2000, clientWidth: 1000 },
    querySelector: (sel) => { const mm = /data-daycol="(\d)"/.exec(sel); return mm ? cols[Number(mm[1])] : null; },
  });
  // oggi subito dopo la colonna delle ore
  assert.equal(scrollEl.scrollLeft, idx * 400);
  // con un appuntamento aperto nel pannello vince il giorno della sua ombra:
  // è lì che si cerca dove spostarlo (tre giorni più in là di oggi, o prima)
  const gIdx = (idx + 3) % 7;
  const withGhost = await week({
    weekStart: days[0], dates: days, scroll: { scrollLeft: gIdx >= 3 ? 0 : 2400, clientWidth: 1000 },
    querySelector: (sel) => { const mm = /data-daycol="(\d)"/.exec(sel); return mm ? cols[Number(mm[1])] : null; },
    props: { ghost: one(7, 1, '10:00', 60, '2026-09-29'), ghostDate: days[gIdx] },
  });
  assert.equal(withGhost.scrollEl.scrollLeft, gIdx * 400);
  // un'altra settimana (senza oggi) non si sposta di lato
  const other = await week({
    weekStart: '2020-01-06', dates: ['2020-01-06', '2020-01-07', '2020-01-08', '2020-01-09', '2020-01-10', '2020-01-11', '2020-01-12'],
    scroll: { scrollLeft: 0, clientWidth: 1000 },
    querySelector: (sel) => { const mm = /data-daycol="(\d)"/.exec(sel); return mm ? cols[Number(mm[1])] : null; },
  });
  assert.equal(other.scrollEl.scrollLeft, 0);
});

/* ---- «Adatta» ---- */
test('«Adatta» riempie lo schermo con la giornata di lavoro e la porta in cima', () => {
  const dom = installDom();
  // il corpo della griglia: 58 px sotto l'inizio (testata 50 + 8 d'aria), giornata 09–19
  const body = { offsetTop: 58, dataset: { g0: '0', workStart: String(9 * 60), workEnd: String(19 * 60) }, previousElementSibling: { offsetHeight: 50 } };
  const scrollEl = { clientHeight: 826, scrollTop: 0, querySelector: (sel) => (sel === '.dk-tl-cols' ? { parentElement: body } : null) };
  document.querySelector = (sel) => (sel === '.dk-tl-cols' ? { closest: () => scrollEl } : null);
  let api = null;
  const m = mount(() => { api = useAgendaZoom(); return null; }, {});
  api.fitZoom();
  m.render();
  // le dieci ore nei 760 px sotto la testata (8 d'aria sopra e sotto), non le 24
  const z = (826 - 50 - 16) / (10 * 60 * PXM);
  assert.ok(Math.abs(api.zoom - z) < 1e-9, `zoom ${api.zoom}`);
  // al fotogramma dopo, le 09:00 appena sotto la testata
  dom.frames(1);
  assert.ok(Math.abs(scrollEl.scrollTop - (58 + 9 * 60 * PXM * z - 50 - 8)) < 1e-6, `scrollTop ${scrollEl.scrollTop}`);
});
