// Vista giorno (DayGrid.jsx vero, montato con test/grid-harness.mjs):
// trascinamenti, ridimensionamenti, ombra e colore. Reperti della caccia ai
// bug del 22/09/2026: 12-02, 12-03, 12-05, 12-06, 12-08, 12-14, 12-15, 12-16,
// 12-18, 12-23. Bug sospetti del 24/09/2026: n. 51 (rilascio su window).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { find, findAll, installDom, loadComponent, mount, ptr, rect, spy, textOf } from './grid-harness.mjs';

// i pezzi senza hook della griglia, che per i test fanno parte di DayGrid
const DAY_PARTS = ['OperatorHeaderCell', 'OpColorPicker', 'HourGutter', 'GridLines', 'NowLine', 'ClosedHours', 'GhostBlocks', 'VisitBlocks', 'DayDragBadge'];
const { default: DayGrid } = await loadComponent('apps/dashboard/src/sections/agenda/DayGrid.jsx', { expand: DAY_PARTS });

const PXM = 1.35;   // px per minuto a zoom 1
const DATE = '2026-10-01';                       // giovedì
const at = (hm) => `${DATE}T${hm}:00+02:00`;     // ora del salone (Europe/Rome, ora legale)
const item = (id, name, op, dur, order = 0) => ({ id, service_id: id, service_name: name, operator_id: op, duration_min: dur, soak_min: 0, order });
const appt = (id, op, hm, client, items) => ({
  id, status: 'confirmed', operator_id: op, start: at(hm), client: { id: id + 100, full_name: client },
  total_duration_min: items.reduce((s, it) => s + it.duration_min, 0), total_price: '40.00', items,
});

// Maria: manicure 10:00 con Anna + piega 11:00 con Giulia (una visita su due colonne)
const maria = appt(41, 1, '10:00', 'Maria Russo', [item(411, 'Manicure', 1, 60, 0), item(412, 'Piega', 2, 30, 1)]);
const sara = appt(42, 1, '15:00', 'Sara Bianchi', [item(421, 'Manicure', 1, 30)]);
const elena = appt(43, 1, '19:00', 'Elena Galli', [item(431, 'Colore', 1, 90)]);
const tardi = appt(44, 2, '19:45', 'Luca Serra', [item(441, 'Taglio', 2, 30)]);
const pausa = { id: 5, operator_id: 1, start: at('13:00'), duration_min: 60, note: '' };
const ROWS = [
  { operator: { id: 1, name: 'Anna Neri' }, windows: [['09:00', '19:00']], appointments: [maria, sara, elena], pauses: [pausa] },
  { operator: { id: 2, name: 'Giulia Verdi' }, windows: [['09:00', '21:00']], appointments: [tardi], pauses: [] },
];

// striscia dei giorni sopra la griglia: lun 28/09 … dom 04/10, alta 40..80
const WEEK = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const PILLS = WEEK.map((iso, i) => ({ iso, rect: rect(100 + i * 64, 40, 60, 40) }));
const pillCenter = (iso) => { const r = PILLS.find((p) => p.iso === iso).rect; return [r.left + 30, 60]; };

/* Geometria: contenitore 0..1000 × 100..900, intestazione fissa alta 60
 * (fino a y 160), colonna delle ore larga 64, due colonne da 468 px:
 * Anna x 64..532, Giulia x 532..1000. */
function setup(extraProps = {}, dash = {}) {
  const win = installDom({ pills: PILLS });
  globalThis.__dash = {
    t: (it) => it, lang: 'it', settings: { slot_interval_min: 15 }, modal: null, services: [],
    operators: [{ id: 1, first_name: 'Anna', service_ids: [] }, { id: 2, first_name: 'Giulia', service_ids: [] }],
    ...dash,
  };
  const scrollEl = {
    scrollTop: 0, clientHeight: 800,
    getBoundingClientRect: () => rect(0, 100, 1000, 800),
    querySelector: (sel) => (sel === '.dk-tl-cols' ? colsEl : null),
    querySelectorAll: () => [],
    setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
  };
  const colsEl = { getBoundingClientRect: () => rect(64, 160 - scrollEl.scrollTop, 936, 16 * 60 * PXM), parentElement: { offsetTop: 60 } };
  const headEl = { getBoundingClientRect: () => rect(0, 100, 1000, 60) };
  const cb = {};
  for (const k of ['onOpenAppt', 'onSlotMenu', 'onInvalidDrop', 'onDropOnDate', 'onDragChange', 'onSplitItem', 'onMoveAppt',
    'onResizeItem', 'onMovePause', 'onResizePause', 'onDeletePause', 'onHover', 'onLeave', 'setPicker', 'setOpColor']) cb[k] = spy();
  const props = {
    rows: ROWS, allRows: ROWS, date: DATE, nowMin: null, colorOf: () => '#C9B8F2', itemColor: null, pending: null,
    canWrite: true, showRevenue: true, picker: null, opPalette: [], pickMode: false, ghost: null, zoom: 1, onZoom: null,
    ...cb, ...extraProps,
  };
  const m = mount(DayGrid, props, {
    attach: (tree) => {
      tree.props.ref.current = scrollEl;
      const head = find(tree, (el) => el !== tree && el.props?.ref);
      if (head) head.props.ref.current = headEl;
    },
  });
  const root = () => m.tree;
  const block = (itemId) => find(m.tree, (el) => typeof el.type === 'function' && el.props.block?.item?.id === itemId);
  const pause = (id) => find(m.tree, (el) => typeof el.type === 'function' && el.props.p?.id === id);
  return { m, cb, win, scrollEl, root, block, pause };
}
const moveAll = (g, x, y, id = 1) => { g.root().props.onPointerMove(ptr(x, y, { id })); g.m.render(); };
const moves = (cb) => cb.onMoveAppt.calls.length + cb.onInvalidDrop.calls.length + cb.onSplitItem.calls.length + cb.onDropOnDate.calls.length;

test('allungare una pausa la allunga (niente TypeError)', () => {
  const g = setup();
  g.pause(5).props.onResizeDown(ptr(300, 500));
  // +27 px = +20 minuti: la pausa pranzo passa da 60 a 80
  moveAll(g, 300, 527);
  g.root().props.onPointerUp(ptr(300, 527));
  assert.deepEqual(g.cb.onResizePause.calls.map(([p, dur]) => [p.id, dur]), [[5, 80]]);
});

test('ridimensionare un servizio che finisce dopo la griglia non lo accorcia', () => {
  const g = setup();
  // 19:45 + 30' di Giulia: la maniglia scende di 5 px, la durata sale a 35'
  // (prima veniva tagliata alle 20:00: 15')
  g.block(441).props.onResizeDown(ptr(800, 500));
  moveAll(g, 800, 505);
  g.root().props.onPointerUp(ptr(800, 505));
  assert.deepEqual(g.cb.onResizeItem.calls.map(([a, it, dur]) => [a.id, it.id, dur]), [[44, 441, 35]]);
});

test('un tocco sulla maniglia non cambia la durata', () => {
  const g = setup();
  // 19:00 + 90' toccato di 3 px: prima partiva un PUT con 60'
  g.block(431).props.onResizeDown(ptr(300, 600));
  moveAll(g, 300, 603);
  g.root().props.onPointerUp(ptr(300, 603));
  assert.deepEqual(g.cb.onResizeItem.calls, []);
});

test('rilasciato fra la striscia dei giorni e la griglia, il blocco non si sposta', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 300, 300);
  moveAll(g, 300, 90);   // sotto le pillole (finiscono a y 80) e sopra la griglia (da y 100)
  g.root().props.onPointerUp(ptr(300, 90));
  assert.equal(moves(g.cb), 0, 'nessuno spostamento, forzato o no');
});

test('sopra la pillola di un altro giorno il badge dice «stesso orario» e il rilascio sposta lì', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 300, 300);
  const [x, y] = pillCenter('2026-10-02');
  moveAll(g, x, y);
  const badge = find(g.root(), (el) => String(el.props?.className || '').includes('dk-drag-badge'));
  assert.ok(badge, 'c\'è il badge');
  const txt = textOf(badge);
  assert.match(txt, /stesso orario/);
  assert.match(txt, /15:00/);
  assert.doesNotMatch(txt, /Anna/, 'nessuna colonna: il puntatore è fuori dalla griglia');
  g.root().props.onPointerUp(ptr(x, y));
  assert.deepEqual(g.cb.onDropOnDate.calls.map(([a, iso, min]) => [a.id, iso, min]), [[42, '2026-10-02', 15 * 60]]);
  assert.equal(g.cb.onMoveAppt.calls.length + g.cb.onInvalidDrop.calls.length, 0);
});

test('le forbici lasciate sulla pillola del giorno a video non spezzano la visita', () => {
  const g = setup();
  // il corpo della manicure di Maria stacca QUEL servizio (la visita ne ha due)
  g.block(411).props.onDown(ptr(300, 300));
  moveAll(g, 300, 200);
  const [x, y] = pillCenter(DATE);
  moveAll(g, x, y);
  g.root().props.onPointerUp(ptr(x, y));
  assert.equal(moves(g.cb), 0);
});

test('un secondo dito non sposta né rilascia il trascinamento in corso', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400, { id: 1 }));
  moveAll(g, 300, 481, 1);                        // +60': Sara alle 16:00
  // il secondo dito tocca la colonna di Giulia e si solleva
  g.root().props.onPointerMove(ptr(800, 700, { id: 2, primary: false }));
  g.root().props.onPointerUp(ptr(800, 700, { id: 2, primary: false }));
  assert.equal(moves(g.cb), 0, 'il sollevamento del secondo dito non rilascia');
  g.root().props.onPointerUp(ptr(300, 481, { id: 1 }));
  assert.deepEqual(g.cb.onMoveAppt.calls.map(([a, start, op]) => [a.id, start, op]), [[42, 16 * 60, 1]]);
});

test('la rotella durante il trascinamento sposta l\'orario sotto il puntatore', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  // il puntatore resta fermo, la griglia scorre di 81 px = 60 minuti
  g.scrollEl.scrollTop = 81;
  g.root().props.onScroll?.();
  g.m.render();
  g.root().props.onPointerUp(ptr(300, 400));
  assert.deepEqual(g.cb.onMoveAppt.calls.map(([a, start, op]) => [a.id, start, op]), [[42, 16 * 60, 1]]);
  assert.deepEqual(g.cb.onOpenAppt.calls, [], 'non è un clic');
});

test('il rilascio arriva anche da window: il blocco non resta attaccato al puntatore', () => {
  // dove la cattura del puntatore non c'è o si perde, il pointerup fuori dal
  // contenitore lo sente solo window
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400, { id: 1 }));
  moveAll(g, 300, 481, 1);                        // +60': Sara alle 16:00
  g.win.fire('pointerup', ptr(800, 700, { id: 2, primary: false }));
  assert.equal(moves(g.cb), 0, 'il sollevamento di un secondo dito non rilascia');
  g.win.fire('pointerup', ptr(300, 481, { id: 1 }));
  assert.deepEqual(g.cb.onMoveAppt.calls.map(([a, start, op]) => [a.id, start, op]), [[42, 16 * 60, 1]]);
  assert.equal(g.cb.onDragChange.calls.at(-1)?.[0], false, 'la striscia dei giorni torna normale');
  // il rilascio sul contenitore sale fino a window: si sposta una volta sola
  g.m.render();
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 300, 481);
  g.root().props.onPointerUp(ptr(300, 481));
  g.win.fire('pointerup', ptr(300, 481));
  assert.equal(g.cb.onMoveAppt.calls.length, 2);
});

test('un pointercancel su window annulla il trascinamento', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 300, 481);
  g.win.fire('pointercancel', ptr(300, 481));
  assert.equal(g.cb.onDragChange.calls.at(-1)?.[0], false, 'la striscia dei giorni torna normale');
  g.root().props.onPointerUp(ptr(300, 481));
  assert.equal(moves(g.cb), 0, 'dopo l\'annullamento il rilascio non sposta niente');
});

test('Esc durante il trascinamento lo annulla e lo dichiara (preventDefault)', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 300, 481);
  const esc = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  g.win.fire('keydown', esc);
  assert.equal(esc.defaultPrevented, true, 'il pannello aperto sotto non deve chiudersi');
  g.root().props.onPointerUp(ptr(300, 481));
  assert.equal(moves(g.cb), 0);
});

test('una visita divisa fra due colonne ha la spina in ognuna e si sposta intera', () => {
  const g = setup();
  const spine = find(g.root(), (el) => el.key === 'sp41');
  assert.ok(spine, 'la manicure di Maria (sola nella colonna di Anna) ha la sua spina');
  spine.props.onPointerDown(ptr(70, 300));
  moveAll(g, 70, 381);                            // +60'
  g.root().props.onPointerUp(ptr(70, 381));
  assert.deepEqual(g.cb.onSplitItem.calls, [], 'dalla spina non si stacca niente');
  assert.deepEqual(g.cb.onMoveAppt.calls.map(([a, start, op]) => [a.id, start, op]), [[41, 11 * 60, 1]]);
});

test('il clic dentro l\'ombra della piega vale «stessa ora, stesse operatrici»', () => {
  // A video un altro giorno: Maria (aperta nel pannello) è martedì.
  const tue = { ...maria, start: '2026-09-29T10:00:00+02:00' };
  const rows = [{ ...ROWS[0], appointments: [sara], pauses: [] }, { ...ROWS[1], appointments: [] }];
  const g = setup({ rows, allRows: rows, ghost: tue });
  const colGiulia = find(g.root(), (el) => el.key === 2 && typeof el.props?.onClick === 'function' && el.props.style?.position === 'relative');
  assert.ok(colGiulia, 'colonna di Giulia');
  // 11:10, dentro l'ombra della piega (11:00–11:30): 10 minuti sotto il suo bordo alto
  const ombra = find(g.root(), (el) => el.key === 'ghost412');
  assert.ok(ombra, 'l\'ombra della piega è nella colonna di Giulia');
  const y = 160 + ombra.props.style.top - 1.5 + 10 * PXM;
  const target = { getBoundingClientRect: () => rect(532, 160, 468, 12 * 60 * PXM) };
  colGiulia.props.onClick({ target, currentTarget: target, clientX: 800, clientY: y });
  assert.equal(g.cb.onSlotMenu.calls.length, 1);
  const [opId, startMin, , , verdict, extra] = g.cb.onSlotMenu.calls[0];
  assert.equal(opId, 2);
  assert.equal(startMin, 11 * 60);
  assert.equal(extra?.ghostHit, true, 'il menu sa che il clic è sull\'ombra');
  assert.equal(verdict?.ok, true);
});

test('il blocco aperto nel pannello sta sopra i vicini (zIndex)', () => {
  const g = setup({}, { modal: { name: 'apptdetail', props: { appointment: { id: 42 } } } });
  const el = g.block(421);
  assert.equal(el.props.highlight, true);
  const out = el.type(el.props);
  assert.equal(out.props.style.zIndex, 3);
});

test('il colore scritto a mano non si salva a ogni tasto', async () => {
  const g = setup({ picker: 1 });
  const { mount: mountAgain } = await import('./grid-harness.mjs');
  // il campo esadecimale: un <input> nel selettore, o dentro HexInput
  let input = find(g.root(), (el) => el.type === 'input' && el.props.maxLength === 6);
  let hex = null;
  if (!input) {
    const el = find(g.root(), (x) => typeof x.type === 'function' && x.type.name === 'HexInput');
    assert.ok(el, 'campo esadecimale presente');
    hex = mountAgain(el.type, el.props);
    input = find(hex.tree, (x) => x.type === 'input');
  }
  input.props.onChange({ target: { value: 'C9' } });
  assert.deepEqual(g.cb.setOpColor.calls, [], 'due cifre non sono un colore');
  if (hex) { hex.render(); input = find(hex.tree, (x) => x.type === 'input'); }
  input.props.onChange({ target: { value: 'C9B8F2' } });
  assert.deepEqual(g.cb.setOpColor.calls, [[1, '#C9B8F2']]);
});

test('le testate non contano il no-show nell\'incasso', () => {
  const noShow = { ...sara, id: 45, status: 'no_show', total_price: '30.00', items: [item(451, 'Manicure', 1, 30)] };
  const rows = [{ ...ROWS[0], appointments: [maria, noShow] }, ROWS[1]];
  const g = setup({ rows, allRows: rows });
  const head = findAll(g.root(), (el) => typeof el.props?.title === 'string' && el.props.title.startsWith('Anna Neri'))[0];
  assert.ok(head, 'testata di Anna');
  const txt = textOf(head);
  assert.match(txt, /40,00/, 'la visita di Maria');
  assert.doesNotMatch(txt, /70,00/, 'il no-show non è incasso');
});
