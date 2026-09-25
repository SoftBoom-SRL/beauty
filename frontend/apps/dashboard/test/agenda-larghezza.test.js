// La larghezza delle colonne (lo zoom di lato) in vista giorno e settimana:
// DayGrid e WeekView veri, montati con test/grid-harness.mjs, più i conti
// puri (lib/grid.js), la preferenza salvata (useAgendaZoom) e il pannellino
// della barra (WidthControl). Chiesto il 25/09: poter allargare lo spazio
// anche di lato, come si allunga quello delle ore.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLW, WIDTH_MAX, WIDTH_MIN, clampWidth, fitColumns, widthStep } from '../src/sections/agenda/lib.js';
import { find, findAll, installDom, loadComponent, mount, ptr, rect, spy, tick } from './grid-harness.mjs';

const DAY_PARTS = ['OperatorHeaderCell', 'OpColorPicker', 'HourGutter', 'GridLines', 'NowLine', 'ClosedHours', 'GhostBlocks', 'VisitBlocks', 'DayDragBadge'];
const { default: DayGrid } = await loadComponent('apps/dashboard/src/sections/agenda/DayGrid.jsx', { expand: DAY_PARTS });
const WEEK_PARTS = ['WeekDayHeader', 'HourGutter', 'WeekDayColumn', 'GridLines', 'NowLine', 'WeekDragBadge'];
const { default: WeekView } = await loadComponent('apps/dashboard/src/sections/agenda/WeekView.jsx', { expand: WEEK_PARTS });
const { useAgendaZoom } = await loadComponent('apps/dashboard/src/sections/agenda/hooks/useAgendaZoom.js');
const { default: WidthControl } = await loadComponent('apps/dashboard/src/sections/agenda/parts/WidthControl.jsx');

const DATE = '2026-10-01';
const OPS = [1, 2, 3, 4].map((id) => ({ id, first_name: 'Op' + id, service_ids: [] }));
const ROWS = OPS.map((o) => ({ operator: { id: o.id, name: `Op${o.id} Rossi` }, windows: [['09:00', '19:00']], appointments: [], pauses: [] }));

/** Il contenitore finto: largo 1000 (colonna delle ore 64), `scrollWidth`
 *  lo decide il test; i listener della rotella si raccolgono in `wheel`. */
function day(extra = {}) {
  installDom();
  globalThis.__dash = {
    t: (it) => it, lang: 'it', settings: { slot_interval_min: 15 }, modal: null, services: [], operators: OPS,
  };
  const wheel = [];
  const scrollEl = {
    scrollTop: 0, scrollLeft: 0, clientHeight: 800, clientWidth: 1000, scrollWidth: 1000,
    getBoundingClientRect: () => rect(0, 100, 1000, 800),
    querySelector: () => null, querySelectorAll: () => [], setPointerCapture() {},
    addEventListener: (type, fn) => { if (type === 'wheel') wheel.push(fn); },
    removeEventListener: (type, fn) => { const i = wheel.indexOf(fn); if (i >= 0) wheel.splice(i, 1); },
  };
  const cb = {};
  for (const k of ['onOpenAppt', 'onSlotMenu', 'onInvalidDrop', 'onDropOnDate', 'onDragChange', 'onSplitItem', 'onMoveAppt',
    'onResizeItem', 'onMovePause', 'onResizePause', 'onDeletePause', 'onHover', 'onLeave', 'setPicker', 'setOpColor', 'onZoom', 'onWidthZoom']) cb[k] = spy();
  const widthApi = { current: null };
  const props = {
    rows: ROWS, allRows: ROWS, date: DATE, nowMin: null, colorOf: () => '#C9B8F2', itemColor: null, pending: null, canWrite: true,
    showRevenue: false, picker: null, opPalette: [], pickMode: false, ghost: null, zoom: 1, widthZoom: 1, widthApi, ...cb, ...extra,
  };
  const m = mount(DayGrid, props, { attach: (tree) => { tree.props.ref.current = scrollEl; } });
  const heads = () => findAll(m.tree, (el) => el.props?.className === 'dk-ophead');
  const cols = () => findAll(m.tree, (el) => el.props?.style?.borderRadius === '0 0 10px 10px');
  const grips = () => findAll(m.tree, (el) => el.props?.className === 'dk-colgrip');
  return { m, cb, scrollEl, wheel, widthApi, heads, cols, grips, props };
}

test('i conti: passi, limiti e «tutte in vista»', () => {
  assert.equal(clampWidth(10), WIDTH_MAX);
  assert.equal(clampWidth(0.01), WIDTH_MIN);
  assert.equal(clampWidth('storto'), 1);
  assert.equal(widthStep(1, 1), 1.25);
  assert.equal(widthStep(1, -1), 0.8);
  assert.equal(widthStep(0.9, -1), 0.8, 'da un valore libero al passo sotto');
  assert.equal(widthStep(WIDTH_MAX, 1), WIDTH_MAX);
  // nove colonne da 158 in 1068 px con 6 px fra l'una e l'altra
  assert.equal(fitColumns(1068, 9, 158, 6), (1068 - 48) / (9 * 158));
  // se ci stanno già si torna a 1: si allargano da sole a riempire
  assert.equal(fitColumns(2000, 3, 158, 6), 1);
  // mai sotto il minimo, e niente conti senza colonne
  assert.equal(fitColumns(100, 50, 158), WIDTH_MIN);
  assert.equal(fitColumns(1000, 0, 158), 1);
});

test('vista giorno: la larghezza allarga testate e colonne insieme', () => {
  const g = day({ widthZoom: 0.5 });
  assert.equal(g.heads().length, 4);
  for (const h of g.heads()) assert.equal(h.props.style.flex, '1 0 ' + COLW * 0.5 + 'px');
  assert.equal(g.cols().length, 4);
  for (const c of g.cols()) assert.equal(c.props.style.flex, '1 0 ' + COLW * 0.5 + 'px', 'il corpo resta allineato alla testata');
});

test('vista giorno: «Tutte in vista» fa stare tutte le colonne nello schermo', () => {
  const g = day({ rows: [...ROWS, ...ROWS.map((r) => ({ ...r, operator: { ...r.operator, id: r.operator.id + 10 } }))] });
  g.widthApi.current.fit();
  // otto colonne in 1000 − 64 (ore) − 4 (margine), 6 px fra l'una e l'altra
  assert.deepEqual(g.cb.onWidthZoom.calls, [[fitColumns(1000 - 64 - 4, 8, COLW, 6)]]);
});

test('vista giorno: il bordo di una testata si trascina e il doppio clic fa stare tutto', () => {
  const g = day({ widthZoom: 1.25 });
  const grip = g.grips()[1];                      // bordo destro della seconda colonna
  assert.ok(grip, 'c\'è la maniglia');
  // la seconda testata: larga 198 (158 × 1,25), finisce a 64 + 2 × 198 + 6 = 466
  const cell = { getBoundingClientRect: () => rect(64 + 198 + 6, 100, 198, 44) };
  const down = { ...ptr(466, 120), currentTarget: { parentElement: cell, setPointerCapture() {} } };
  grip.props.onPointerDown(down);
  assert.ok(document.body.classList.contains('dk-gesture'), 'i tasti dell\'agenda tacciono');
  // 100 px a sinistra: due colonne davanti al bordo, ognuna 50 px più stretta
  grip.props.onPointerMove(ptr(366, 120));
  const w = g.cb.onWidthZoom.calls.at(-1)[0];
  assert.ok(Math.abs(w - (198 - 50) / COLW) < 1e-9, `larghezza ${w}`);
  grip.props.onPointerUp(ptr(366, 120));
  assert.equal(document.body.classList.contains('dk-gesture'), false);
  // dopo il rilascio il movimento non cambia più niente
  grip.props.onPointerMove(ptr(300, 120));
  assert.equal(g.cb.onWidthZoom.calls.length, 1);
  // doppio clic: tutte in vista
  grip.props.onDoubleClick({ stopPropagation() {} });
  assert.deepEqual(g.cb.onWidthZoom.calls.at(-1), [fitColumns(1000 - 64 - 4, 4, COLW, 6)]);
  // l'ultima maniglia sta dentro la testata: sporgendo faceva scorrere di lato
  assert.equal(g.grips().at(-1).props.style.right, 0);
  assert.equal(g.grips()[0].props.style.right, -7);
});

test('vista giorno: ⌘/ctrl + Maiusc + rotella cambia la larghezza, non l\'altezza', () => {
  const g = day();
  assert.equal(g.wheel.length, 2, 'la rotella dell\'altezza e quella della larghezza');
  const ev = { ctrlKey: true, shiftKey: true, deltaY: -10, deltaX: 0, clientX: 500, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  g.wheel.forEach((fn) => fn(ev));
  assert.equal(ev.defaultPrevented, true);
  assert.equal(g.cb.onZoom.calls.length, 0, 'l\'altezza resta com\'è');
  assert.equal(g.cb.onWidthZoom.calls.length, 1);
  assert.ok(g.cb.onWidthZoom.calls[0][0](1) > 1, 'rotella in su: più larghe');
  // il Mac con Maiusc manda lo scorrimento come orizzontale
  g.wheel.forEach((fn) => fn({ ...ev, deltaY: 0, deltaX: 10 }));
  assert.ok(g.cb.onWidthZoom.calls[1][0](1) < 1, 'in giù: più strette');
  // senza Maiusc è lo zoom delle ore, come prima
  g.wheel.forEach((fn) => fn({ ...ev, shiftKey: false }));
  assert.equal(g.cb.onZoom.calls.length, 1);
  assert.equal(g.cb.onWidthZoom.calls.length, 2);
});

test('vista giorno: cambiando larghezza resta fermo il punto al centro (o sotto il puntatore)', () => {
  const g = day();
  g.scrollEl.scrollLeft = 300;
  g.scrollEl.scrollWidth = 2000;
  g.m.render();                                  // si misura il contenuto largo 2000
  g.scrollEl.scrollWidth = 3936;                 // colonne larghe il doppio
  g.m.render({ ...g.m.props, widthZoom: 2 });
  // il centro della parte a destra delle ore (x 532) resta sullo stesso punto delle colonne
  const f = (300 + 532 - 64) / (2000 - 64);
  assert.ok(Math.abs(g.scrollEl.scrollLeft - (f * (3936 - 64) + 64 - 532)) < 1e-6, `scrollLeft ${g.scrollEl.scrollLeft}`);
  // con la rotella: il punto sotto il puntatore (x 900)
  const before = g.scrollEl.scrollLeft;
  g.wheel.forEach((fn) => fn({ ctrlKey: true, shiftKey: true, deltaY: -10, deltaX: 0, clientX: 900, preventDefault() {} }));
  g.scrollEl.scrollWidth = 7808;
  g.m.render({ ...g.m.props, widthZoom: 4 });
  const f2 = (before + 900 - 64) / (3936 - 64);
  assert.ok(Math.abs(g.scrollEl.scrollLeft - (f2 * (7808 - 64) + 64 - 900)) < 1e-6);
});

test('vista giorno: trascinando il bordo la griglia non scorre (il bordo segue il puntatore)', () => {
  const g = day({ widthZoom: 1.25 });
  g.scrollEl.scrollLeft = 120;
  g.scrollEl.scrollWidth = 1500;
  g.m.render();
  const grip = g.grips()[0];
  grip.props.onPointerDown({ ...ptr(262, 120), currentTarget: { parentElement: { getBoundingClientRect: () => rect(64 - 120, 100, 198, 44) }, setPointerCapture() {} } });
  grip.props.onPointerMove(ptr(300, 120));
  g.scrollEl.scrollWidth = 1700;
  g.m.render({ ...g.m.props, widthZoom: g.cb.onWidthZoom.calls.at(-1)[0] });
  assert.equal(g.scrollEl.scrollLeft, 120);
});

/* ---- vista settimana ---- */
async function week(extra = {}) {
  installDom();
  let resolve = null;
  globalThis.__api = {
    get: () => new Promise((r) => { resolve = r; }),
    post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t: (it) => it, lang: 'it', showRevenue: false, fireToast: spy(), openModal: spy(), hasScope: () => true,
    settings: { slot_interval_min: 15 }, locationId: null, modal: null, live: { subscribe: () => () => {} },
  };
  const scrollEl = {
    scrollTop: 0, scrollLeft: 0, clientHeight: 800, clientWidth: 1046, scrollWidth: 1046,
    getBoundingClientRect: () => rect(0, 100, 1046, 800),
    querySelector: () => null, querySelectorAll: () => [], setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
  };
  const onWidthZoom = spy();
  const widthApi = { current: null };
  const ops = [1, 2, 3, 4, 5].map((id) => ({ id, first_name: 'Op' + id, last_name: 'X' }));
  const m = mount(WeekView, {
    weekStart: '2026-09-28', operators: ops, colorOf: () => '#C9B8F2', itemColor: null, nowMin: null,
    onOpenDay: spy(), onNewAppt: spy(), onOpenAppt: spy(), pickMode: false, ghost: null, ghostDate: '2026-09-28',
    zoom: 1, onZoom: null, widthZoom: 1, onWidthZoom, widthApi, ...extra,
  }, { attach: (tree) => { if (tree?.props?.ref) tree.props.ref.current = scrollEl; } });
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  resolve(dates.map((date) => ({ date, count: 0, by_status: {}, appointments: [] })));
  await tick();
  m.render();
  return { m, scrollEl, onWidthZoom, widthApi };
}

test('vista settimana: giorni e sotto-colonne seguono la larghezza, e «Tutte in vista» fa stare la settimana', async () => {
  const g = await week({ widthZoom: 0.5 });
  // cinque operatrici: 5 × 44 = 220 px a larghezza 1, la metà a 0,5
  const dayCol = find(g.m.tree, (el) => el.props?.['data-daycol'] === 0);
  assert.equal(dayCol.props.style.flex, '1 0 110px');
  g.widthApi.current.fit();
  // sette giorni da 220 in 1046 − 46 (ore) = 1000 px
  assert.deepEqual(g.onWidthZoom.calls, [[fitColumns(1000, 7, 220)]]);
  // la maniglia del terzo giorno: tre giorni da 220 davanti al suo bordo
  const grips = findAll(g.m.tree, (el) => el.props?.className === 'dk-colgrip');
  assert.equal(grips.length, 7);
  const cell = { getBoundingClientRect: () => rect(46 + 2 * 110, 100, 110, 60) };
  grips[2].props.onPointerDown({ ...ptr(376, 110), currentTarget: { parentElement: cell, setPointerCapture() {} } });
  grips[2].props.onPointerMove(ptr(376 + 66, 110));
  // bordo da 376 a 442: (330 + 66) / 660 = 0,6
  assert.ok(Math.abs(g.onWidthZoom.calls.at(-1)[0] - 0.6) < 1e-9);
  grips[2].props.onPointerUp(ptr(442, 110));
  assert.equal(grips.at(-1).props.style.right, 0, 'l\'ultima maniglia dentro la testata');
});

/* ---- la preferenza e il pannellino della barra ---- */
test('la larghezza si ricorda sulla postazione, una per vista, ripulita', () => {
  const dom = installDom({ storage: { 'dk-agenda-width': JSON.stringify({ day: 0.6, week: 99 }) } });
  let api = null;
  const m = mount(() => { api = useAgendaZoom(); return null; }, {});
  assert.deepEqual(api.width, { day: 0.6, week: WIDTH_MAX }, 'un valore fuori scala si riporta nei limiti');
  api.setWidth('week', (w) => w / 2);
  m.render();
  assert.deepEqual(api.width, { day: 0.6, week: WIDTH_MAX / 2 });
  assert.deepEqual(JSON.parse(dom.storage['dk-agenda-width']), { day: 0.6, week: WIDTH_MAX / 2 });
  // memoria illeggibile: si parte da 1
  installDom({ storage: { 'dk-agenda-width': '{rotto' } });
  let api2 = null;
  mount(() => { api2 = useAgendaZoom(); return null; }, {});
  assert.deepEqual(api2.width, { day: 1, week: 1 });
});

test('il pannellino della larghezza: passi, cursore, «Tutte in vista» e «Normale»', () => {
  installDom();
  const setWidth = spy(), fitWidth = spy();
  const m = mount(WidthControl, { width: 0.8, setWidth, fitWidth, t: (it) => it });
  const btn = () => find(m.tree, (el) => el.type === 'button' && el.props['aria-haspopup'] === 'dialog');
  assert.match(btn().props['aria-label'], /Larghezza delle colonne 80%/);
  assert.equal(find(m.tree, (el) => el.props?.role === 'dialog'), null, 'chiuso di partenza');
  btn().props.onClick();
  m.render();
  const by = (label) => find(m.tree, (el) => el.type === 'button' && el.props['aria-label'] === label);
  by('Colonne più strette').props.onClick();
  by('Colonne più larghe').props.onClick();
  assert.equal(setWidth.calls[0][0](0.8), 0.6);
  assert.equal(setWidth.calls[1][0](0.8), 1);
  // il cursore: da un quarto (0) a tre volte (1000)
  const range = find(m.tree, (el) => el.type === 'input' && el.props.type === 'range');
  range.props.onChange({ target: { value: '1000' } });
  range.props.onChange({ target: { value: '0' } });
  assert.ok(Math.abs(setWidth.calls[2][0] - WIDTH_MAX) < 1e-9);
  assert.ok(Math.abs(setWidth.calls[3][0] - WIDTH_MIN) < 1e-9);
  find(m.tree, (el) => el.type === 'button' && String(el.props.children).includes('Normale')).props.onClick();
  assert.equal(setWidth.calls[4][0], 1);
  find(m.tree, (el) => el.type === 'button' && JSON.stringify(el.props.children).includes('Tutte in vista')).props.onClick();
  assert.equal(fitWidth.calls.length, 1);
});
