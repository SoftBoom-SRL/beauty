// Vista giorno (DayGrid.jsx vero, montato con test/grid-harness.mjs):
// trascinamenti, ridimensionamenti, ombra e colore. Reperti della caccia ai
// bug del 22/09/2026: 12-02, 12-03, 12-05, 12-06, 12-08, 12-14, 12-15, 12-16,
// 12-18, 12-23. Bug sospetti del 24/09/2026: n. 51 (rilascio su window).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EDGE_DELAY_FRAMES } from '../src/sections/agenda/lib/drag.js';
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
  // le colonne coprono le 24 ore (GRID_DAY)
  const colsEl = { getBoundingClientRect: () => rect(64, 160 - scrollEl.scrollTop, 936, 24 * 60 * PXM), parentElement: { offsetTop: 60 } };
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
  g.scrollEl.scrollTop += 81;
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

test('smontata a metà trascinamento la griglia spegne la striscia dei giorni e i segni del gesto', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 500));
  moveAll(g, 300, 560);                              // oltre la soglia: il blocco si muove
  assert.ok(document.body.classList.contains('dk-dragging'));
  assert.deepEqual(g.cb.onDragChange.calls.at(-1), [true]);
  g.m.unmount();                                     // un altro giorno da tastiera, un rimontaggio
  assert.deepEqual(g.cb.onDragChange.calls.at(-1), [false], 'la striscia non resta un bersaglio');
  assert.equal(document.body.classList.contains('dk-dragging'), false);
  assert.equal(document.body.classList.contains('dk-gesture'), false);
});

test('anche il ridimensionamento è un gesto in corso: i tasti dell\'agenda lo vedono', () => {
  const g = setup();
  g.block(421).props.onResizeDown(ptr(300, 520));
  assert.ok(document.body.classList.contains('dk-gesture'), 'acceso alla pressione');
  assert.equal(document.body.classList.contains('dk-dragging'), false, 'il ridimensionamento non muove il blocco');
  g.root().props.onPointerUp(ptr(300, 540));
  assert.equal(document.body.classList.contains('dk-gesture'), false, 'spento al rilascio');
});

/* ---- 25/09: difetti visti trascinando nell'app vera ---- */

test('trascinando in un\'altra colonna i blocchi che ci sono non cambiano corsia', () => {
  const g = setup();
  const lanes = (id) => { const b = g.block(id); return [b.props.lane, b.props.laneCount]; };
  assert.deepEqual(lanes(441), [0, 1]);
  // Sara (15:00, Anna) portata sopra Luca (19:45, Giulia)
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 800, 400 + (19 * 60 + 45 - 15 * 60) * PXM);
  // prima Luca si dimezzava (e tornava intero) a ogni passaggio del blocco
  assert.deepEqual(lanes(441), [0, 1], 'Luca resta a tutta larghezza');
  const sara = findAll(g.root(), (el) => typeof el.type === 'function' && el.props.block?.item?.id === 421);
  assert.equal(sara.length, 1, 'un solo blocco di Sara: quello che viaggia');
  assert.equal(sara[0].props.dragging, true);
  assert.equal(sara[0].props.startMin, 19 * 60 + 45);
  assert.ok(find(g.root(), (el) => el.key === 'g421' && el.props.className === 'dk-drag-ghost'), 'la traccia resta nella colonna di Anna');
  // nel blocco basso trascinato il nome della cliente resta leggibile: solo
  // l'inizio accanto (l'orario intero lo dice il badge)
  const out = sara[0].type(sara[0].props);
  assert.match(textOf(out), /Sara Bianchi/);
  const time = find(out, (el) => el.type === 'span' && el.props?.className === 'tabnum');
  assert.equal(textOf(time), '19:45');
});

test('staccando un servizio la spina resta sulla visita e i vicini non si stringono', () => {
  // Sofia: ricostruzione 09:30–11:15 + nail art 11:15–11:45, poi Noor alle 12:00, tutte con Anna
  const sofia = appt(46, 1, '09:30', 'Sofia Ricci', [item(461, 'Ricostruzione', 1, 105, 0), item(462, 'Nail art', 1, 30, 1)]);
  const noor = appt(47, 1, '12:00', 'Noor Haddad', [item(471, 'Semipermanente', 1, 60)]);
  const rows = [{ ...ROWS[0], appointments: [sofia, noor], pauses: [] }, { ...ROWS[1], appointments: [] }];
  const g = setup({ rows, allRows: rows });
  const lanes = (id) => { const b = g.block(id); return [b.props.lane, b.props.laneCount]; };
  // il corpo della ricostruzione stacca QUEL servizio, giù fino alle 14:00
  g.block(461).props.onDown(ptr(300, 300));
  moveAll(g, 300, 300 + (14 * 60 - (9 * 60 + 30)) * PXM);
  assert.equal(g.block(461).props.dragging, true);
  // prima la visita si allungava fino al puntatore: Noor e la nail art a metà colonna
  assert.deepEqual(lanes(471), [0, 1]);
  assert.deepEqual(lanes(462), [0, 1]);
  // la spina copre la nail art che resta, non mezza giornata
  const spine = find(g.root(), (el) => el.key === 'sp46');
  assert.equal(spine.props.style.top, (11 * 60 + 15) * PXM + 1.5);
  assert.equal(spine.props.style.height, 30 * PXM - 3);
  assert.equal(find(g.root(), (el) => el.key === 'fs46'), null, 'il servizio staccato esce dalla visita: niente spina con lui');
});

test('trascinando la spina la visita viaggia con la sua spina', () => {
  const sofia = appt(46, 1, '09:30', 'Sofia Ricci', [item(461, 'Ricostruzione', 1, 105, 0), item(462, 'Nail art', 1, 30, 1)]);
  const rows = [{ ...ROWS[0], appointments: [sofia], pauses: [] }, { ...ROWS[1], appointments: [] }];
  const g = setup({ rows, allRows: rows });
  find(g.root(), (el) => el.key === 'sp46').props.onPointerDown(ptr(70, 300));
  moveAll(g, 800, 381);                                // Giulia, +60'
  const fly = find(g.root(), (el) => el.key === 'fs46');
  assert.ok(fly, 'la spina segue la visita');
  assert.equal(fly.props.style.top, (10 * 60 + 30) * PXM + 1.5);
  assert.equal(fly.props.style.height, 135 * PXM - 3);
  assert.equal(fly.props.style.pointerEvents, 'none');
  assert.equal(find(g.root(), (el) => el.key === 'sp46'), null, 'nella colonna di partenza restano le tracce');
});

test('allungando un blocco i vicini restano nella loro corsia e lui passa sopra', () => {
  const g = setup();
  const elena = () => { const b = g.block(431); return [b.props.lane, b.props.laneCount]; };
  // Sara 15:00 (30') allungata fino alle 19:35, sopra Elena (19:00)
  g.block(421).props.onResizeDown(ptr(300, 440));
  assert.equal(g.cb.onLeave.calls.length, 1, 'la scheda di anteprima si chiude alla pressione');
  moveAll(g, 300, 440 + 245 * PXM);
  assert.deepEqual(elena(), [0, 1]);
  const sara = g.block(421);
  assert.equal(sara.props.activeMin, 275);
  assert.equal(sara.props.resizing, true);
  // sopra i vicini (2), sotto la spina (4) e la riga dell'ora (8): a 20 le copriva
  assert.equal(sara.type(sara.props).props.style.zIndex, 3);
  g.root().props.onPointerUp(ptr(300, 440 + 245 * PXM));
  assert.deepEqual(g.cb.onResizeItem.calls.map(([a, it, dur]) => [a.id, it.id, dur]), [[42, 421, 275]]);
});

test('dopo il rilascio la scheda dell\'appuntamento non compare da sola', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  moveAll(g, 300, 481);
  g.root().props.onPointerUp(ptr(300, 481));
  g.m.render();
  // il browser fa «entrare» il puntatore fermo nel blocco che gli arriva sotto
  const enter = () => { const b = g.block(421); b.type(b.props).props.onMouseEnter({ currentTarget: {} }); };
  enter();
  assert.deepEqual(g.cb.onHover.calls, [], 'prima compariva, con l\'orario di prima dello spostamento');
  // i movimenti «finti» del browser (stesse coordinate) e i tremolii non contano
  g.root().props.onPointerMove(ptr(300, 481));
  g.root().props.onPointerMove(ptr(302, 483));
  enter();
  assert.equal(g.cb.onHover.calls.length, 0);
  // un movimento vero e la scheda torna
  g.root().props.onPointerMove(ptr(310, 490));
  enter();
  assert.equal(g.cb.onHover.calls.length, 1);
});

test('un clic (senza trascinare) non spegne la scheda', () => {
  const g = setup();
  g.block(421).props.onDown(ptr(300, 400));
  g.root().props.onPointerUp(ptr(300, 400));
  g.m.render();
  const b = g.block(421);
  b.type(b.props).props.onMouseEnter({ currentTarget: {} });
  assert.equal(g.cb.onHover.calls.length, 1);
});

test('trascinando verso il bordo la griglia scorre da sola, e il rilascio la ferma', () => {
  const g = setup();
  const top0 = g.scrollEl.scrollTop;
  g.block(421).props.onDown(ptr(300, 500));
  moveAll(g, 300, 560);
  assert.equal(g.win.pendingFrames(), 0, 'lontano dai bordi non scorre');
  // 5 px sopra il fondo del contenitore (900): prima un attimo di attesa
  moveAll(g, 300, 895);
  assert.equal(g.win.pendingFrames(), 1);
  g.win.frames(EDGE_DELAY_FRAMES);
  assert.equal(g.scrollEl.scrollTop, top0, 'non ancora');
  g.win.frames(10);
  const scrolled = g.scrollEl.scrollTop - top0;
  assert.ok(scrolled >= 100, `scorsa di ${scrolled} px`);
  // lo scroll vero fa scattare onScroll: il blocco scende con la griglia
  g.root().props.onScroll();
  g.root().props.onPointerUp(ptr(300, 895));
  const start = g.cb.onMoveAppt.calls[0]?.[1] ?? g.cb.onInvalidDrop.calls[0]?.[2].newApptStart;
  const still = 15 * 60 + (895 - 500) / PXM;
  assert.ok(start >= still + 60, `arrivo ${start}: oltre dove arrivava senza scorrere (${still})`);
  // finito il gesto non scorre più niente
  const after = g.scrollEl.scrollTop;
  g.win.frames(5);
  assert.equal(g.scrollEl.scrollTop, after);
  assert.equal(g.win.pendingFrames(), 0);
});

test('lo scorrimento automatico sale sotto l\'intestazione, non sopra', () => {
  const g = setup();
  const top0 = g.scrollEl.scrollTop;
  g.block(421).props.onDown(ptr(300, 500));
  moveAll(g, 300, 450);
  // sopra l'intestazione (fino a y 160) il puntatore indica la striscia dei giorni
  moveAll(g, 300, 150);
  assert.equal(g.win.pendingFrames(), 0);
  // appena sotto: sale
  moveAll(g, 300, 165);
  g.win.frames(EDGE_DELAY_FRAMES + 3);
  assert.ok(g.scrollEl.scrollTop < top0, 'la griglia sale');
  // Esc ferma anche lo scorrimento
  g.win.fire('keydown', { key: 'Escape', preventDefault() {} });
  const after = g.scrollEl.scrollTop;
  g.win.frames(3);
  assert.equal(g.scrollEl.scrollTop, after);
});

test('il ridimensionamento scorre solo in verticale', () => {
  const g = setup();
  g.scrollEl.scrollLeft = 0;
  const top0 = g.scrollEl.scrollTop;
  g.block(421).props.onResizeDown(ptr(300, 440));
  moveAll(g, 995, 895);                                // angolo in basso a destra
  g.win.frames(EDGE_DELAY_FRAMES + 3);
  assert.ok(g.scrollEl.scrollTop > top0, 'in giù sì');
  assert.equal(g.scrollEl.scrollLeft, 0, 'di lato no: la durata non cambia colonna');
  g.root().props.onPointerUp(ptr(995, 895));
});

test('attraversando di corsa la fascia del bordo la griglia non scorre', () => {
  // il blocco preso vicino all'intestazione e portato sulla striscia dei giorni
  const g = setup();
  const top0 = g.scrollEl.scrollTop;
  g.block(421).props.onDown(ptr(300, 200));
  moveAll(g, 300, 190);                                // nella fascia (160–208)
  g.win.frames(3);
  moveAll(g, 300, 175);
  g.win.frames(3);
  moveAll(g, 300, 120);                                // sopra la griglia
  g.win.frames(EDGE_DELAY_FRAMES);
  assert.equal(g.scrollEl.scrollTop, top0, 'la giornata resta dov\'era');
  g.root().props.onPointerUp(ptr(300, 120));
});

test('portato fino in fondo alla giornata il blocco si rilascia, non si annulla', () => {
  const g = setup();
  // in fondo alle 24 ore: sotto le 24:00 restano 8 px dell'area che scorre
  g.scrollEl.scrollTop = 24 * 60 * PXM + 60 + 8 - 800;
  g.root().props.onScroll();
  const bodyBottom = 160 - g.scrollEl.scrollTop + 24 * 60 * PXM;
  g.block(431).props.onDown(ptr(300, 600));
  moveAll(g, 300, 640);
  moveAll(g, 300, Math.ceil(bodyBottom) + 3);          // sotto il corpo, dentro il contenitore
  const badge = find(g.root(), (el) => String(el.props?.className || '').includes('dk-drag-badge'));
  assert.doesNotMatch(textOf(badge), /Fuori dalla griglia/);
  g.root().props.onPointerUp(ptr(300, Math.ceil(bodyBottom) + 3));
  assert.equal(g.cb.onMoveAppt.calls.length + g.cb.onInvalidDrop.calls.length, 1, 'il rilascio sposta');
});

test('trascinata in fondo alla giornata, la visita finisce entro la mezzanotte', () => {
  const g = setup();
  // Elena (19:00, 90'): in fondo, all'ultima riga della griglia
  g.scrollEl.scrollTop = 24 * 60 * PXM + 60 + 8 - 800;
  g.root().props.onScroll();
  g.block(431).props.onDown(ptr(300, 500));
  moveAll(g, 300, 890);
  assert.equal(g.block(431).props.startMin, 22 * 60 + 30, 'si ferma quando la fine tocca le 24:00');
  // in fondo alla finestra (900) il badge sale sopra il puntatore: si legge
  const badge = find(g.root(), (el) => String(el.props?.className || '').includes('dk-drag-badge'));
  assert.equal(badge.props.style.bottom, 900 - 890 + 14);
  assert.equal(badge.props.style.top, undefined);
  g.root().props.onPointerUp(ptr(300, 890));
  const start = g.cb.onMoveAppt.calls[0]?.[1] ?? g.cb.onInvalidDrop.calls[0]?.[2].newApptStart;
  assert.equal(start, 22 * 60 + 30);
});

test('lo scorrimento automatico vuole il puntatore dentro la griglia su tutti e due gli assi', () => {
  const g = setup();
  g.scrollEl.scrollLeft = 0;
  const top0 = g.scrollEl.scrollTop;
  g.block(421).props.onDown(ptr(300, 500));
  moveAll(g, 300, 560);
  // sull'intestazione, vicino al bordo destro: le colonne non scorrono di lato
  moveAll(g, 995, 150);
  g.win.frames(EDGE_DELAY_FRAMES + 3);
  assert.equal(g.scrollEl.scrollLeft, 0);
  // sulla colonna delle ore vicino al fondo: il blocco è «fuori», la griglia non scende
  moveAll(g, 30, 895);
  g.win.frames(EDGE_DELAY_FRAMES + 3);
  assert.equal(g.scrollEl.scrollTop, top0);
  // dentro la griglia, vicino al bordo destro: sì
  moveAll(g, 995, 500);
  g.win.frames(EDGE_DELAY_FRAMES + 3);
  assert.ok(g.scrollEl.scrollLeft > 0);
  g.root().props.onPointerUp(ptr(995, 500));
});
