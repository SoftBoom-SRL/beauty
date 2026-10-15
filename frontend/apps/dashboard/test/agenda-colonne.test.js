// Le colonne della vista giorno e i loro colori: il filtro «Team» (chi si
// disegna, «Solo chi lavora oggi») e il testo leggibile sopra i colori del
// salone. Riordino dell'agenda del 24/09/2026: la riga delle chip «Calendari»
// è diventata un filtro nella barra, e le colonne di chi è a riposo si
// possono nascondere senza perdere un blocco. 15/10: lo sfondo delle colonne
// col colore dell'operatrice, in giorno e in settimana (DayGrid e WeekView
// veri, montati con test/grid-harness.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OP_COLUMN_TINT, hiddenIdsOf, inkOn, locationOperators, opColumnTint, parseHiddenIds, restingIds, visibleDayRows,
  wantsLightText, workingOperatorIds,
} from '../src/sections/agenda/lib.js';
import { findAll, installDom, loadComponent, mount, rect, spy, tick } from './grid-harness.mjs';

const DAY_PARTS = ['OperatorHeaderCell', 'OpColorPicker', 'HourGutter', 'GridLines', 'NowLine', 'ClosedHours', 'GhostBlocks', 'VisitBlocks', 'DayDragBadge'];
const { default: DayGrid } = await loadComponent('apps/dashboard/src/sections/agenda/DayGrid.jsx', { expand: DAY_PARTS });
const WEEK_PARTS = ['WeekDayHeader', 'HourGutter', 'WeekDayColumn', 'GridLines', 'NowLine', 'WeekDragBadge'];
const { default: WeekView } = await loadComponent('apps/dashboard/src/sections/agenda/WeekView.jsx', { expand: WEEK_PARTS });

const it = (id, op) => ({ id, service_id: id, operator_id: op, duration_min: 30, soak_min: 0 });
/* Anna lavora; Bea è a riposo ma fa la piega dentro la visita di Anna; Carla
 * è a riposo e ha solo una pausa; Dora è a riposo e non ha niente. */
const ROWS = [
  { operator: { id: 1, name: 'Anna' }, windows: [['09:00', '18:00']], pauses: [],
    appointments: [{ id: 10, operator_id: 1, status: 'confirmed', items: [it(101, 1), it(102, 2)] }] },
  { operator: { id: 2, name: 'Bea' }, windows: [], pauses: [], appointments: [] },
  { operator: { id: 3, name: 'Carla' }, windows: [], pauses: [{ id: 5, operator_id: 3 }], appointments: [] },
  { operator: { id: 4, name: 'Dora' }, windows: [], pauses: [], appointments: [] },
];
const ids = (rows) => rows.map((r) => r.operator.id);

test('chi lavora: turno, pausa, o un servizio dentro la visita di una collega', () => {
  assert.deepEqual([...workingOperatorIds(ROWS)].sort(), [1, 2, 3]);
});

test('un appuntamento annullato non tiene visibile la colonna', () => {
  const rows = [{ operator: { id: 4, name: 'Dora' }, windows: [], pauses: [],
    appointments: [{ id: 11, operator_id: 4, status: 'cancelled', items: [it(111, 4)] }] }];
  assert.deepEqual([...workingOperatorIds(rows)], []);
});

test('«Solo chi lavora oggi» nasconde solo chi non ha niente, mai il blocco di una collega', () => {
  assert.deepEqual(ids(visibleDayRows(ROWS, {}, { onlyWorking: true })), [1, 2, 3]);
  assert.deepEqual(ids(visibleDayRows(ROWS, {}, { onlyWorking: false })), [1, 2, 3, 4]);
});

test('il filtro spegne le colonne scelte, e «Solo chi lavora» si somma', () => {
  assert.deepEqual(ids(visibleDayRows(ROWS, { 1: false })), [2, 3, 4]);
  assert.deepEqual(ids(visibleDayRows(ROWS, { 1: false }, { onlyWorking: true })), [2, 3]);
  // tutto spento: la griglia resta vuota, non si riaccende niente da sola
  assert.deepEqual(ids(visibleDayRows(ROWS, { 1: false, 2: false, 3: false, 4: false })), []);
});

test('la colonna dell\'ombra dell\'appuntamento aperto resta anche a riposo', () => {
  assert.deepEqual(ids(visibleDayRows(ROWS, {}, { onlyWorking: true, keep: [4] })), [1, 2, 3, 4]);
});

test('chi è a riposo e il filtro sta nascondendo (fra le accese)', () => {
  assert.deepEqual(restingIds(ROWS, {}), [4]);
  assert.deepEqual(restingIds(ROWS, { 4: false }), [], 'Dora spenta a mano non conta');
  assert.deepEqual(restingIds(ROWS, {}, [4]), [], 'Dora tenuta per l\'ombra non conta');
});

test('testo bianco sui colori scuri, scuro sui chiari: vince il contrasto più alto', () => {
  assert.equal(wantsLightText('#6366F1'), true, 'indaco pieno (seed_demo)');
  assert.equal(wantsLightText('#1E3A8A'), true, 'blu notte');
  assert.equal(wantsLightText('#EC4899'), false, 'il rosa pieno regge meglio il testo scuro');
  assert.equal(wantsLightText('#FDE2E4'), false, 'categoria Unghie');
  assert.equal(wantsLightText('#F59E0B'), false, 'l\'ambra è chiara: testo scuro');
  assert.equal(wantsLightText('#6366F1', 0.2), false, 'lo stesso indaco schiarito all\'80%');
  assert.equal(wantsLightText('#FFF'), false, 'anche a tre cifre');
});

test('un colore che non si sa leggere resta col testo scuro di sempre', () => {
  assert.equal(wantsLightText('var(--clay)'), false);
  assert.equal(wantsLightText(null), false);
  assert.equal(inkOn('var(--clay)').ink, 'var(--ink)');
  assert.equal(inkOn('#1A1A2E', 0.82).ink, '#FFFFFF');
});

test('nessuno ha turni quel giorno: «Solo chi lavora oggi» non ha niente su cui decidere', () => {
  const noShifts = ROWS.map((r) => ({ ...r, windows: [] }));
  assert.deepEqual(ids(visibleDayRows(noShifts, {}, { onlyWorking: true })), [1, 2, 3, 4], 'le colonne libere restano');
  assert.deepEqual(restingIds(noShifts, {}), []);
});

test('spente valgono solo fra le operatrici elencate: un id rimasto salvato non nasconde niente', () => {
  const ops = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(hiddenIdsOf({ 1: false, 2: true, 9: false }, ops), [1], 'la 9 non c\'è più');
  assert.deepEqual(hiddenIdsOf({}, ops), []);
});

test('le spente salvate si leggono con pazienza', () => {
  assert.deepEqual(parseHiddenIds('[2, "3", 4.5, null]'), [2, 3]);
  assert.deepEqual(parseHiddenIds('rotto'), []);
  assert.deepEqual(parseHiddenIds('{"a":1}'), []);
  assert.deepEqual(parseHiddenIds(null), []);
});

test('le operatrici della sede: chi non ha sede vale per tutte', () => {
  const ops = [{ id: 1, location_id: 1 }, { id: 2, location_id: null }, { id: 3, location_id: 2 }];
  assert.deepEqual(locationOperators(ops, 1).map((o) => o.id), [1, 2]);
  assert.deepEqual(locationOperators(ops, null).map((o) => o.id), [1, 2, 3], 'senza sede scelta, tutte');
});

/* ---- lo sfondo col colore dell'operatrice ---- */
const RED = '#E53935', BLUE = '#039BE5';
const opColor = (id) => (id === 1 ? RED : BLUE);
const scrollBox = () => ({
  scrollTop: 0, scrollLeft: 0, clientHeight: 800, clientWidth: 1000, scrollWidth: 1000,
  getBoundingClientRect: () => rect(0, 100, 1000, 800),
  querySelector: () => null, querySelectorAll: () => [], setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
});

test('il colore dell\'operatrice nello sfondo della colonna: abbastanza da vedersi', () => {
  assert.equal(opColumnTint(RED), `color-mix(in srgb, ${RED} ${OP_COLUMN_TINT}%, #FFFFFF)`);
  assert.equal(opColumnTint(RED, 'transparent'), `color-mix(in srgb, ${RED} ${OP_COLUMN_TINT}%, transparent)`);
  // al 6% di prima le colonne sembravano tutte bianche
  assert.ok(OP_COLUMN_TINT >= 12 && OP_COLUMN_TINT <= 20, 'si vede, ma i blocchi restano sopra');
});

test('vista giorno: colonna e testata di ognuna col suo colore', () => {
  installDom();
  globalThis.__dash = { t: (it) => it, lang: 'it', settings: { slot_interval_min: 15 }, modal: null, services: [], operators: [] };
  const rows = [1, 2].map((id) => ({ operator: { id, name: `Op${id} Rossi` }, windows: [['09:00', '19:00']], appointments: [], pauses: [] }));
  const cb = {};
  for (const k of ['onOpenAppt', 'onSlotMenu', 'onInvalidDrop', 'onDropOnDate', 'onDragChange', 'onSplitItem', 'onMoveAppt',
    'onResizeItem', 'onMovePause', 'onResizePause', 'onDeletePause', 'onHover', 'onLeave', 'setPicker', 'setOpColor', 'onZoom', 'onWidthZoom']) cb[k] = spy();
  const scrollEl = scrollBox();
  const m = mount(DayGrid, {
    rows, allRows: rows, date: '2026-10-01', nowMin: null, colorOf: opColor, itemColor: null, pending: null, canWrite: true,
    showRevenue: false, picker: null, opPalette: [], pickMode: false, ghost: null, zoom: 1, widthZoom: 1, widthApi: { current: null }, ...cb,
  }, { attach: (tree) => { tree.props.ref.current = scrollEl; } });
  const cols = findAll(m.tree, (el) => el.props?.style?.borderRadius === '0 0 10px 10px');
  assert.deepEqual(cols.map((c) => c.props.style.background), [opColumnTint(RED), opColumnTint(BLUE)]);
  const heads = findAll(m.tree, (el) => el.props?.className === 'dk-ophead');
  assert.deepEqual(heads.map((h) => h.props.style.background), [opColumnTint(RED, 'var(--surface)'), opColumnTint(BLUE, 'var(--surface)')]);
});

test('vista settimana: ogni sotto-colonna col colore della sua operatrice, anche nella testata', async () => {
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
  const scrollEl = scrollBox();
  const m = mount(WeekView, {
    weekStart: '2026-09-28', operators: [1, 2].map((id) => ({ id, first_name: 'Op' + id, last_name: 'X' })), colorOf: opColor,
    itemColor: null, nowMin: null, onOpenDay: spy(), onNewAppt: spy(), onOpenAppt: spy(), pickMode: false, ghost: null,
    ghostDate: '2026-09-28', zoom: 1, onZoom: null, widthZoom: 1, onWidthZoom: spy(), widthApi: { current: null },
  }, { attach: (tree) => { if (tree?.props?.ref) tree.props.ref.current = scrollEl; } });
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  resolve(dates.map((date) => ({ date, count: 0, by_status: {}, appointments: [] })));
  await tick();
  m.render();
  const subs = findAll(m.tree, (el) => el.props?.['data-subcol'] === '');
  assert.equal(subs.length, 14, 'due sotto-colonne per sette giorni');
  // prima non avevano sfondo: il colore si vedeva solo nella testata
  for (const s of subs) assert.equal(s.props.style.background, opColumnTint(opColor(s.props['data-op']), 'transparent'));
  const subHeads = findAll(m.tree, (el) => el.props?.style?.borderTop?.startsWith?.('3px solid #'));
  assert.equal(subHeads.length, 14);
  for (const h of subHeads) assert.equal(h.props.style.background, opColumnTint(h.props.style.borderTop.slice(10), 'var(--paper)'));
});
