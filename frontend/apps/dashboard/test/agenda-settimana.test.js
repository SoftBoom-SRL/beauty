// Vista settimana (WeekView.jsx vero, montato con test/grid-harness.mjs).
// Reperti della caccia ai bug del 22/09/2026: 12-10 (ricarico senza guardia),
// 12-14 / 12-15 / 12-18 (secondo dito, rotella, Esc durante il trascinamento),
// 12-21 (sotto-colonne di tutte le sedi), 13-08 (clic su un blocco con la
// prenotazione aperta). Bug sospetti del 24/09/2026: n. 48 (pinch e
// ⌘-rotella), n. 50 (clic per prenotare).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin } from '@youty/shared';
import { WEEK_DAY_BORDER, WHEEL_ZOOM_FACTOR, weekDayOps } from '../src/sections/agenda/lib.js';
import { EDGE_DELAY_FRAMES } from '../src/sections/agenda/lib/drag.js';
import { find, findAll, installDom, loadComponent, mount, ptr, rect, spy, textOf, tick } from './grid-harness.mjs';

// i pezzi senza hook della griglia, che per i test fanno parte di WeekView
const WEEK_PARTS = ['WeekDayHeader', 'HourGutter', 'WeekDayColumn', 'GridLines', 'NowLine', 'WeekDragBadge'];
const { default: WeekView } = await loadComponent('apps/dashboard/src/sections/agenda/WeekView.jsx', { expand: WEEK_PARTS });

const PXM = 1.35;
const W1 = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const W2 = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
const OPS = [
  { id: 1, first_name: 'Anna', last_name: 'Neri', location_id: 1 },
  { id: 2, first_name: 'Giulia', last_name: 'Verdi', location_id: null },   // senza sede: vale per tutte
  { id: 3, first_name: 'Bea', last_name: 'Blu', location_id: 2 },           // lavora nell'altra sede
];
const sara = (date) => ({
  id: 42, start: `${date}T15:00:00+02:00`, client_name: 'Sara Bianchi', client_phone: '', operator_id: 1,
  status: 'confirmed', duration_min: 30, total_price: '30.00', deposit_status: 'none', note: '', gifts: [],
  items: [{ service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Manicure' }],
});
const weekPayload = (days) => days.map((date, i) => ({
  date, count: i === 3 ? 1 : 0, by_status: {}, appointments: i === 3 ? [sara(date)] : [],
}));

/* api finta: ogni GET resta in sospeso finché il test non la risolve. */
function fakeApi() {
  const gets = [];
  const posts = [];
  globalThis.__api = {
    get: (url, opts) => new Promise((resolve, reject) => { gets.push({ url, opts, resolve, reject }); }),
    post: (url, body) => { posts.push({ url, body }); return Promise.resolve({}); },
    put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  return { gets, posts, weekGets: () => gets.filter((g) => g.url === '/api/agenda/week') };
}

/* Geometria: colonna delle ore 46 px, poi sette giorni da 120 px, ognuno con
 * le sotto-colonne delle operatrici della sede (60 px l'una se sono due). */
function setup(extra = {}) {
  const win = installDom();
  const api = fakeApi();
  let liveFn = null;
  globalThis.__dash = {
    t: (it) => it, lang: 'it', showRevenue: false, fireToast: spy(), openModal: spy(), hasScope: () => true,
    settings: { slot_interval_min: 15 }, locationId: 1, modal: null,
    live: { subscribe: (fn) => { liveFn = fn; return () => {}; } },
  };
  // «torna indietro» come lo passa la sezione (index.jsx): la voce più recente
  // prima del gesto e l'«Annulla» del suo avviso
  const cb = { onOpenDay: spy(), onNewAppt: spy(), onOpenAppt: spy(), undoMark: spy(0), undoAfter: spy(() => () => {}) };
  const scrollEl = {
    scrollTop: 0, clientHeight: 800,
    getBoundingClientRect: () => rect(0, 100, 1000, 800),
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '[data-daycol]' ? dayEls() : []),
    setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
  };
  let m = null;
  const dayEls = () => {
    const subOps = [...new Set(findAll(m.tree, (el) => el.props?.['data-subcol'] === '').map((el) => el.props['data-op']))];
    return [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const left = 46 + i * 120, w = 120 / Math.max(1, subOps.length);
      return {
        dataset: { daycol: String(i) },
        getBoundingClientRect: () => rect(left, 160 - scrollEl.scrollTop, 120, 12 * 60 * PXM),
        querySelectorAll: () => subOps.map((op, k) => ({ dataset: { op: String(op) }, getBoundingClientRect: () => rect(left + k * w, 160 - scrollEl.scrollTop, w, 12 * 60 * PXM) })),
      };
    });
  };
  const props = {
    weekStart: W1[0], operators: OPS, colorOf: () => '#C9B8F2', itemColor: null, nowMin: null,
    pickMode: false, ghost: null, ghostDate: W1[0], zoom: 1, onZoom: null, ...cb, ...extra,
  };
  m = mount(WeekView, props, { attach: (tree) => { if (tree?.props?.ref) tree.props.ref.current = scrollEl; } });
  const block = () => find(m.tree, (el) => typeof el.type === 'function' && el.props.a?.id === 42 && !el.props.moving);
  const root = () => m.tree;
  return { m, cb, win, api, scrollEl, block, root, live: (events) => liveFn?.({ events }) };
}
async function loadWeek(g, days, idx = -1) {
  const req = idx < 0 ? g.api.weekGets().at(-1) : g.api.weekGets()[idx];
  req.resolve(weekPayload(days));
  await tick();
  g.m.render();
}

test('sotto-colonne solo per le operatrici della sede attiva', () => {
  const ops = weekDayOps(OPS, 1, [], 'Non più in team');
  assert.deepEqual(ops.map((o) => o.id), [1, 2]);
  // un appuntamento dell'altra sede resta visibile, col nome vero
  const withBea = weekDayOps(OPS, 1, [{ operator_id: 3 }, { operator_id: 99 }], 'Non più in team');
  assert.deepEqual(withBea.map((o) => [o.id, o.first_name]), [[1, 'Anna'], [2, 'Giulia'], [3, 'Bea'], [99, 'Non più in team']]);
  // senza sede scelta: tutte
  assert.deepEqual(weekDayOps(OPS, null, [], '').map((o) => o.id), [1, 2, 3]);
});

test('la griglia disegna le sotto-colonne della sede attiva', async () => {
  const g = setup();
  await loadWeek(g, W1);
  const ops = new Set(findAll(g.root(), (el) => el.props?.['data-subcol'] === '').map((el) => el.props['data-op']));
  assert.deepEqual([...ops].sort(), [1, 2]);
});

test('«Salva» dal pannello dopo aver sfogliato la settimana ricarica quella a video', async () => {
  const g = setup();
  await loadWeek(g, W1);
  // clic sul blocco di Sara: si apre il dettaglio
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerUp(ptr(430, 400));
  const detail = g.api.gets.find((x) => x.url === '/api/agenda/appointments/42');
  detail.resolve(sara(W1[3]));
  await tick();
  const onMutate = g.cb.onOpenAppt.calls[0]?.[1] ?? globalThis.__dash.openModal.calls[0]?.[1]?.onMutate;
  assert.equal(typeof onMutate, 'function', 'il pannello riceve un onMutate');
  // dal pannello si sfoglia la settimana dopo: la vista la segue
  g.m.render({ ...g.m.props, weekStart: W2[0], ghostDate: W2[0] });
  await loadWeek(g, W2);
  onMutate();   // «Salva» nel pannello
  const last = g.api.weekGets().at(-1);
  assert.equal(last.opts.params.start, W2[0], 'si ricarica la settimana a video, non quella dell\'apertura');
});

test('una risposta della settimana vecchia non sovrascrive quella a video', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.live([{ type: 'appointment.moved' }]);           // ricarico live della 28/09–04/10, in volo
  const stale = g.api.weekGets().length - 1;
  g.m.render({ ...g.m.props, weekStart: W2[0] });    // si passa alla settimana dopo
  await loadWeek(g, W2);
  await loadWeek(g, W1, stale);                      // arriva tardi la risposta vecchia
  const header = findAll(g.root(), (el) => el.type === 'span' && el.props?.className === 't-num').map((el) => el.props.children);
  assert.deepEqual(header, [5, 6, 7, 8, 9, 10, 11], 'restano i giorni della settimana a video');
});

test('la caparra pagata, l\'incasso e i turni cambiati altrove ricaricano la settimana', async () => {
  const g = setup();
  await loadWeek(g, W1);
  const before = g.api.weekGets().length;
  g.live([{ type: 'deposit.paid' }]);
  g.live([{ type: 'operator.absence_created' }]);
  g.live([{ type: 'sale.created' }]);
  assert.equal(g.api.weekGets().length, before + 3);
});

test('in settimana un secondo dito non sposta né rilascia il trascinamento', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.block().props.onDown(ptr(430, 400, { id: 1 }));
  g.root().props.onPointerMove(ptr(430, 481, { id: 1 }));   // +60': 16:00
  g.m.render();
  const two = ptr(800, 700, { id: 2, primary: false });
  g.root().props.onPointerMove(two);
  g.root().props.onPointerUp(two);
  g.win.fire('pointerup', two);
  assert.equal(g.api.posts.length, 0, 'il sollevamento del secondo dito non rilascia');
  g.root().props.onPointerUp(ptr(430, 481, { id: 1 }));
  assert.equal(g.api.posts.length, 1);
  assert.equal(g.api.posts[0].url, '/api/agenda/appointments/42/move');
  assert.equal(g.api.posts[0].body.start, isoAtMin(W1[3], 16 * 60));
  assert.equal(g.api.posts[0].body.operator_id, undefined, 'stessa operatrice');
});

test('in settimana la rotella durante il trascinamento sposta l\'orario', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.block().props.onDown(ptr(430, 400));
  g.scrollEl.scrollTop += 81;             // +60 minuti sotto un puntatore fermo
  g.root().props.onScroll?.();
  g.m.render();
  g.root().props.onPointerUp(ptr(430, 400));
  assert.equal(g.api.posts.length, 1);
  assert.equal(g.api.posts[0].body.start, isoAtMin(W1[3], 16 * 60));
});

test('in settimana Esc annulla il trascinamento senza chiudere il pannello', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));
  g.m.render();
  const esc = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  g.win.fire('keydown', esc);
  assert.equal(esc.defaultPrevented, true);
  g.root().props.onPointerUp(ptr(430, 481));
  assert.equal(g.api.posts.length, 0);
});

test('con la prenotazione aperta il clic su un blocco non apre il dettaglio', async () => {
  const g = setup({ pickMode: true });
  await loadWeek(g, W1);
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerUp(ptr(430, 400));
  await tick();
  assert.equal(globalThis.__dash.openModal.calls.length, 0, 'nessun modale al posto della prenotazione');
  assert.equal(g.api.gets.filter((x) => x.url.startsWith('/api/agenda/appointments/')).length, 0);
  // la sezione (index.jsx) riceve il blocco e decide: con la prenotazione aperta avvisa e basta
  assert.equal(g.cb.onOpenAppt.calls.length, 1);
});

test('in settimana pinch e ⌘/ctrl + rotella zoomano la griglia, anche dopo il cambio di settimana', async () => {
  const onZoom = spy();
  const g = setup({ onZoom });
  // i listener della rotella registrati sul contenitore
  const wheel = [];
  g.scrollEl.addEventListener = (type, fn, opts) => { if (type === 'wheel') wheel.push({ fn, opts }); };
  g.scrollEl.removeEventListener = (type, fn) => { const i = wheel.findIndex((w) => w.fn === fn); if (i >= 0) wheel.splice(i, 1); };
  const pinch = () => {
    const ev = { ctrlKey: true, metaKey: false, deltaY: -10, clientY: 500, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    [...wheel].forEach((w) => w.fn(ev));
    return ev;
  };
  // il primo disegno è lo scheletro, senza contenitore: la griglia arriva dopo
  await loadWeek(g, W1);
  assert.equal(wheel.length, 1, 'la griglia ascolta la rotella');
  assert.equal(wheel[0].opts?.passive, false, 'non passivo, altrimenti il browser ingrandisce la pagina');
  const ev = pinch();
  assert.equal(ev.defaultPrevented, true, 'la pagina non si ingrandisce');
  assert.equal(onZoom.calls.length, 1);
  assert.equal(onZoom.calls[0][0](1), WHEEL_ZOOM_FACTOR, 'la griglia si ingrandisce di un passo');
  // la settimana dopo passa dallo scheletro, poi arriva la griglia nuova
  g.m.render({ ...g.m.props, weekStart: W2[0] });
  g.m.render();
  assert.equal(wheel.length, 0, 'lo scheletro non ha niente da zoomare');
  await loadWeek(g, W2);
  assert.equal(wheel.length, 1, 'la griglia nuova ascolta la rotella');
  pinch();
  assert.equal(onZoom.calls.length, 2);
});

test('in settimana il clic per prenotare apre la fascia sotto il puntatore, come in vista giorno', async () => {
  const g = setup();
  globalThis.__dash.settings = { slot_interval_min: 30 };   // fasce da mezz'ora
  await loadWeek(g, W1);
  // giovedì alle 10:50: la griglia parte dalla mezzanotte, a 160 px dall'alto
  const y = 160 + (10 * 60 + 50) * PXM;
  const el = (left, width) => ({ getBoundingClientRect: () => rect(left, 160, width, 12 * 60 * PXM), closest: () => null });
  const thu = find(g.root(), (x) => x.props?.['data-daycol'] === 3);
  // clic sul fondo del giorno, dove cade la sotto-colonna di Giulia (x 466–526) …
  const day = el(406, 120);
  thu.props.onClick({ target: day, currentTarget: day, clientX: 500, clientY: y });
  // … e sulla sotto-colonna di Anna (x 406–466)
  const anna = find(thu, (x) => x.props?.['data-subcol'] === '' && x.props['data-op'] === 1);
  const sub = el(406, 60);
  anna.props.onClick({ target: sub, currentTarget: sub, clientX: 430, clientY: y });
  assert.deepEqual(g.cb.onNewAppt.calls.map(([p]) => [p.operatorId, p.start]), [
    [2, isoAtMin(W1[3], 10 * 60 + 30)],
    [1, isoAtMin(W1[3], 10 * 60 + 30)],
  ], 'le 10:30, la fascia cliccata (arrotondando si apriva alle 11:00)');
});

test('filtro «Team»: la visita di una principale spenta si disegna dalla collega e si sposta senza cambiare operatrice', async () => {
  const g = setup({ hiddenOps: [1] });               // Anna spenta
  // la visita delle 15:00: manicure con Anna (principale), poi piega con Giulia
  const visita = (date) => ({
    ...sara(date), duration_min: 60,
    items: [{ service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Manicure' },
      { service_id: 2, operator_id: 2, duration_min: 30, soak_min: 0, service_name: 'Piega' }],
  });
  g.api.weekGets().at(-1).resolve(W1.map((date, i) => ({ date, count: i === 3 ? 1 : 0, by_status: {}, appointments: i === 3 ? [visita(date)] : [] })));
  await tick();
  g.m.render();
  const giulia = findAll(g.root(), (el) => el.props?.['data-subcol'] === '' && el.props['data-day'] === 3 && el.props['data-op'] === 2)[0];
  assert.ok(giulia, 'la sotto-colonna di Giulia c\'è, quella di Anna no');
  assert.ok(find(giulia, (el) => el.props?.a?.id === 42), 'la visita è disegnata nella colonna di Giulia');
  // trascinata un'ora più giù nella stessa colonna (x 430: Giulia è l'unica sotto-colonna)
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));
  g.m.render();
  g.root().props.onPointerUp(ptr(430, 481));
  assert.equal(g.api.posts.length, 1);
  assert.equal(g.api.posts[0].body.start, isoAtMin(W1[3], 16 * 60));
  assert.equal(g.api.posts[0].body.operator_id, undefined, 'i servizi di Anna non passano a Giulia');
});

test('cambiando settimana la scheda di anteprima del blocco di prima sparisce', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.block().props.onHover(g.block().props.a, { getBoundingClientRect: () => rect(430, 400, 40, 40) });
  g.m.render();
  const card = () => find(g.root(), (el) => el.type?.name === 'ApptHoverCard');
  assert.ok(card(), 'la scheda è aperta');
  g.m.render({ ...g.m.props, weekStart: W2[0] });   // → (tastiera o frecce)
  await loadWeek(g, W2);                             // la settimana nuova arriva
  assert.equal(card(), null, 'il blocco è sparito senza mouseleave: la scheda non resta incollata');
});

/* ---- 25/09: difetti visti trascinando nell'app vera ---- */

test('in settimana trascinando un blocco i vicini non cambiano corsia', async () => {
  const g = setup();
  // Rita alle 15:00 con Anna, accanto a Sara: due corsie
  const rita = (date) => ({ ...sara(date), id: 43, client_name: 'Rita Blu', duration_min: 60,
    items: [{ service_id: 1, operator_id: 1, duration_min: 60, soak_min: 0, service_name: 'Colore' }] });
  g.api.weekGets().at(-1).resolve(W1.map((date, i) => ({ date, count: i === 3 ? 2 : 0, by_status: {}, appointments: i === 3 ? [sara(date), rita(date)] : [] })));
  await tick();
  g.m.render();
  const ritaEl = () => find(g.root(), (el) => typeof el.type === 'function' && el.props.a?.id === 43 && !el.props.moving);
  assert.equal(ritaEl().props.width, 'calc(50% - 2px)', 'metà sotto-colonna: accanto c\'è Sara');
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));
  g.m.render();
  // prima Sara usciva dal calcolo e Rita si allargava a tutta la sotto-colonna
  assert.equal(ritaEl().props.width, 'calc(50% - 2px)', 'Rita resta nella sua corsia');
  assert.ok(find(g.root(), (el) => el.key === 42 && el.props?.className === 'dk-drag-ghost'), 'la traccia di Sara nella sua corsia');
  assert.ok(find(g.root(), (el) => el.props?.moving && el.props.a?.id === 42), 'la copia che segue il puntatore');
});

test('in settimana dopo il rilascio la scheda non compare da sola', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));
  g.m.render();
  g.root().props.onPointerUp(ptr(430, 481));
  g.m.render();
  const card = () => find(g.root(), (el) => el.props?.hover && el.props.hints === 'week');
  const enter = () => { const b = g.block(); b.props.onHover(b.props.a, { getBoundingClientRect: () => rect(430, 481, 60, 40) }); g.m.render(); };
  enter();
  assert.equal(card(), null, 'il puntatore fermo sul blocco appena lasciato non apre la scheda');
  g.root().props.onPointerMove(ptr(445, 495));
  enter();
  assert.ok(card(), 'dopo un movimento vero sì');
});

test('in settimana trascinando verso i bordi la griglia scorre anche di lato', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.scrollEl.scrollLeft = 200;
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));
  // al bordo destro (1000): verso domenica
  g.root().props.onPointerMove(ptr(995, 481));
  g.win.frames(EDGE_DELAY_FRAMES + 4);
  assert.ok(g.scrollEl.scrollLeft > 200, `scrollLeft ${g.scrollEl.scrollLeft}`);
  // appena a destra della colonna delle ore (46): verso lunedì
  const right = g.scrollEl.scrollLeft;
  g.root().props.onPointerMove(ptr(52, 481));
  g.win.frames(EDGE_DELAY_FRAMES);
  assert.equal(g.scrollEl.scrollLeft, right, 'cambiando bordo si riparte dall\'attesa');
  g.win.frames(4);
  assert.ok(g.scrollEl.scrollLeft < right);
  // sopra la colonna delle ore non indica un giorno: fermo
  const still = g.scrollEl.scrollLeft;
  g.root().props.onPointerMove(ptr(30, 481));
  g.win.frames(EDGE_DELAY_FRAMES + 4);
  assert.equal(g.scrollEl.scrollLeft, still);
  g.root().props.onPointerUp(ptr(30, 481));
  assert.equal(g.win.pendingFrames(), 0);
});

test('in settimana l\'appuntamento trascinato in fondo finisce entro la mezzanotte', async () => {
  const g = setup();
  await loadWeek(g, W1);
  g.block().props.onDown(ptr(430, 400));
  // tanto più giù della mezzanotte (il puntatore resta sul giovedì)
  g.root().props.onPointerMove(ptr(430, 400 + 10 * 60 * PXM));
  g.root().props.onPointerUp(ptr(430, 400 + 10 * 60 * PXM));
  assert.equal(g.api.posts.length, 1);
  assert.equal(g.api.posts[0].body.start, isoAtMin(W1[3], 24 * 60 - 30), 'Sara (30\') alle 23:30');
});

/* Una visita con due colleghe: manicure con Anna alle 10:00, piega con Giulia
 * alle 10:30. In settimana è una parte per colonna (15/10). */
const mista = (date) => ({
  id: 50, start: `${date}T10:00:00+02:00`, client_name: 'Marta Rossi', client_phone: '', operator_id: 1,
  status: 'confirmed', duration_min: 90, total_price: '95.00', deposit_status: 'none', note: '', gifts: [],
  items: [
    { id: 501, service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Manicure' },
    { id: 502, service_id: 2, operator_id: 2, duration_min: 60, soak_min: 0, service_name: 'Piega' },
  ],
});
async function loadMista(g) {
  g.api.weekGets().at(-1).resolve(W1.map((date, i) => ({ date, count: i === 3 ? 1 : 0, by_status: {}, appointments: i === 3 ? [mista(date)] : [] })));
  await tick();
  g.m.render();
}
const partOf = (g, n) => find(g.m.tree, (el) => typeof el.type === 'function' && el.props.a?.id === 50 && el.props.a?.part === n && !el.props.moving);

test('in settimana la parte di una collega sta nella sua colonna e trascinata si stacca da sola', async () => {
  const g = setup();
  await loadMista(g);
  assert.equal(partOf(g, 1).props.a.colOp, undefined, 'la manicure da Anna');
  assert.equal(partOf(g, 2).props.a.colOp, 2, 'la piega da Giulia');
  partOf(g, 2).props.onDown(ptr(490, 300, { id: 1 }));
  g.root().props.onPointerMove(ptr(490, 381, { id: 1 }));   // +60'
  g.m.render();
  g.root().props.onPointerUp(ptr(490, 381, { id: 1 }));
  await tick();
  assert.equal(g.api.posts.length, 1);
  assert.equal(g.api.posts[0].url, '/api/agenda/appointments/50/split');
  assert.deepEqual(g.api.posts[0].body, { item_id: 502, item_ids: [502], start: isoAtMin(W1[3], 11 * 60 + 30) });
});

test('in settimana la barra di una parte sposta tutta la visita', async () => {
  const g = setup();
  await loadMista(g);
  partOf(g, 2).props.onDown(ptr(490, 300, { id: 1 }), { whole: true });
  g.root().props.onPointerMove(ptr(490, 381, { id: 1 }));   // +60'
  g.m.render();
  g.root().props.onPointerUp(ptr(490, 381, { id: 1 }));
  await tick();
  assert.equal(g.api.posts.length, 1);
  assert.equal(g.api.posts[0].url, '/api/agenda/appointments/50/move');
  assert.deepEqual(g.api.posts[0].body, { start: isoAtMin(W1[3], 11 * 60) });
});

/* 16/10: una visita accorpata della STESSA operatrice (colore e piega con
 * Anna) era un blocco solo e si spostava sempre tutta. Ora ogni servizio è
 * una parte, attaccata alla precedente: il corpo sposta quel servizio, la
 * barra scura tutta la visita. */
const accorpata = (date) => ({
  id: 60, start: `${date}T10:00:00+02:00`, client_name: 'Sarah Mac', client_phone: '', operator_id: 1, client_id: 9,
  status: 'closed', duration_min: 90, total_price: '80.00', deposit_status: 'none', note: '', gifts: [],
  items: [
    { id: 601, service_id: 1, operator_id: 1, duration_min: 60, soak_min: 0, service_name: 'Colore' },
    { id: 602, service_id: 2, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Piega' },
  ],
});
async function loadAccorpata(g) {
  g.api.weekGets().at(-1).resolve(W1.map((date, i) => ({ date, count: i === 3 ? 1 : 0, by_status: {}, appointments: i === 3 ? [accorpata(date)] : [] })));
  await tick();
  g.m.render();
}
const partOf60 = (g, n) => find(g.m.tree, (el) => typeof el.type === 'function' && el.props.a?.id === 60 && el.props.a?.part === n && !el.props.moving);

test('in settimana un servizio di una visita accorpata si sposta da solo', async () => {
  const g = setup();
  await loadAccorpata(g);
  // attaccati: la piega continua il colore, nella stessa corsia
  assert.equal(partOf60(g, 1).props.joinBottom, true);
  assert.equal(partOf60(g, 2).props.joinTop, true);
  assert.equal(partOf60(g, 2).props.left, partOf60(g, 1).props.left);
  partOf60(g, 2).props.onDown(ptr(430, 300, { id: 1 }));
  g.root().props.onPointerMove(ptr(430, 381, { id: 1 }));   // +60'
  g.m.render();
  const moving = findAll(g.root(), (el) => el.props?.moving && el.props.a?.id === 60);
  assert.deepEqual(moving.map((m) => m.props.a.key), ['60:1'], 'viaggia solo la piega');
  g.root().props.onPointerUp(ptr(430, 381, { id: 1 }));
  await tick();
  assert.equal(g.api.posts[0].url, '/api/agenda/appointments/60/split');
  assert.deepEqual(g.api.posts[0].body, { item_id: 602, item_ids: [602], start: isoAtMin(W1[3], 12 * 60) });
});

test('in settimana la barra di una visita accorpata la sposta tutta, e si vede viaggiare intera', async () => {
  const g = setup();
  await loadAccorpata(g);
  partOf60(g, 2).props.onDown(ptr(430, 300, { id: 1 }), { whole: true });
  g.root().props.onPointerMove(ptr(430, 381, { id: 1 }));   // +60'
  g.m.render();
  const moving = findAll(g.root(), (el) => el.props?.moving && el.props.a?.id === 60);
  assert.deepEqual(moving.map((m) => [m.props.a.key, m.props.a.startMin, m.props.joinTop, m.props.joinBottom]), [['60:0', 660, false, true], ['60:1', 720, true, false]]);
  // il badge dice l'orario di tutta la visita
  assert.ok(textOf(find(g.root(), (el) => el.props?.className === 'dk-drag-badge')).includes('11:00–12:30'));
  g.root().props.onPointerUp(ptr(430, 381, { id: 1 }));
  await tick();
  assert.equal(g.api.posts[0].url, '/api/agenda/appointments/60/move');
  assert.deepEqual(g.api.posts[0].body, { start: isoAtMin(W1[3], 11 * 60) });
});

test('in settimana l\'anteprima si apre fuori dalle altre parti della visita, con il servizio indicato in evidenza', async () => {
  const g = setup();
  await loadAccorpata(g);
  // le due parti a schermo, e un estraneo più a destra che non conta
  const el = (appt, r) => ({ dataset: { appt: String(appt) }, getBoundingClientRect: () => r });
  g.scrollEl.querySelectorAll = (sel) => (sel === '[data-appt]'
    ? [el(60, rect(410, 240, 50, 81)), el(60, rect(410, 321, 120, 40)), el(61, rect(700, 240, 50, 40))]
    : []);
  const p1 = partOf60(g, 1);
  p1.props.onHover(p1.props.a, { getBoundingClientRect: () => rect(410, 240, 50, 81) });
  g.m.render();
  const card = find(g.root(), (x) => x.props?.hover && x.props.hints === 'week');
  assert.equal(card.props.hover.x, 540, 'a destra della piega, non sopra');
  assert.deepEqual(card.props.hover.a.focus_item_ids, [601]);
  // con la scheda aperta l'altra parte si evidenzia
  assert.equal(partOf60(g, 2).props.linked, true);
  // nella scheda: un servizio per riga con la sua ora, il colore in evidenza; lo stato; i gesti delle parti
  const drawn = card.type(card.props);
  const rows = findAll(drawn, (x) => x.props?.style?.margin === '0 -6px');
  assert.deepEqual(rows.map((r) => [textOf(r), r.props['data-focus']]), [['10:00Colore', ''], ['11:00Piega', undefined]]);
  const text = textOf(drawn);
  assert.ok(text.includes('closed'), 'lo stato della visita (statusMeta finto: l\'etichetta è lo stato)');
  assert.ok(text.includes('Trascina: sposta questo servizio, anche su un altro giorno · Barra scura: tutta la visita'));
});

test('in settimana i giorni hanno il loro bordo, e la sotto-colonna con lavoro è più larga', async () => {
  const g = setup();
  await loadWeek(g, W1);
  const day = find(g.root(), (el) => el.props?.['data-daycol'] === 3);
  assert.equal(day.props.style.borderLeft, WEEK_DAY_BORDER);
  const subs = findAll(day, (el) => el.props?.['data-subcol'] === '');
  // Sara è di Anna: Anna 3, Giulia 1; la prima non ripete il bordo del giorno
  assert.deepEqual(subs.map((s) => [s.props['data-op'], s.props.style.flex, s.props.style.borderLeft]), [[1, '3 1 0', 'none'], [2, '1 1 0', '1px solid var(--hair-2)']]);
  // la testata ha le stesse larghezze del corpo
  const heads = findAll(g.root(), (el) => el.props?.className === 'dk-wsub');
  assert.deepEqual(heads.slice(6, 8).map((h) => h.props.style.flex), ['3 1 0', '1 1 0']);
});

test('in settimana il blocco dice sempre qualcosa: righe, nome per lungo o iniziali', async () => {
  const g = setup();
  await loadAccorpata(g);
  const draw = (el, extra = {}) => el.type({ ...el.props, ...extra });
  const cls = (tree, c) => find(tree, (x) => x.props?.className === c);
  // il colore: 60' alti 81 px → righe, e per lungo se la colonna è stretta
  const first = draw(partOf60(g, 1));
  assert.ok(first.props.className.includes('dk-wblock--tall'));
  assert.equal(textOf(cls(first, 'dk-wblock__l1')), 'Sarah');
  assert.ok(textOf(cls(first, 'dk-wblock__h')).includes('Mac'));
  assert.equal(textOf(cls(first, 'dk-wblock__v')), 'Sarah Mac · 10:00');
  assert.equal(textOf(cls(first, 'dk-wblock__ini')), 'SM10:00', 'le iniziali e, sotto, l\'ora');
  // la piega attaccata: il suo servizio, non di nuovo il nome
  const second = draw(partOf60(g, 2));
  assert.equal(textOf(cls(second, 'dk-wblock__l1')), 'Piega');
  assert.equal(textOf(cls(second, 'dk-wblock__ini dk-wblock__ini--svc')), 'Piega11:00');
  // bassissimo (zoom piccolo): l'ora non ci sta, restano le iniziali
  assert.equal(textOf(cls(draw(partOf60(g, 1), { pxm: 0.4 }), 'dk-wblock__ini')), 'SM');
  // alta abbastanza, per lungo: il servizio e la sua ora
  assert.equal(textOf(cls(draw(partOf60(g, 2), { pxm: 2 }), 'dk-wblock__v')), 'Piega · 11:00');
  // bassa (30' = 40 px): niente scritta per lungo, le iniziali
  assert.ok(!second.props.className.includes('dk-wblock--tall'));
  assert.equal(cls(second, 'dk-wblock__v'), null);
  // attaccate: niente stacco né angoli fra le due
  assert.equal(second.props.style.top, 11 * 60 * 1.35, 'GRID_DAY parte da mezzanotte');
  assert.match(first.props.style.borderRadius, /^6px 6px 0px 0px$/);
});

test('in settimana posa e caparra: il tratteggio in fondo al servizio, il pallino sulla prima parte', async () => {
  const g = setup();
  const conPosa = (date) => ({ ...accorpata(date), deposit_status: 'required', items: [
    { id: 601, service_id: 1, operator_id: 1, duration_min: 40, soak_min: 20, service_name: 'Colore' },
    { id: 602, service_id: 2, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Piega' },
  ] });
  g.api.weekGets().at(-1).resolve(W1.map((date, i) => ({ date, count: i === 3 ? 1 : 0, by_status: {}, appointments: i === 3 ? [conPosa(date)] : [] })));
  await tick();
  g.m.render();
  const draw = (n) => { const el = partOf60(g, n); return el.type(el.props); };
  const hatch = (tree) => find(tree, (x) => x.props?.title === 'Posa o attesa: l’operatrice è libera');
  assert.equal(hatch(draw(1)).props.style.height, 20 * 1.35);
  assert.equal(hatch(draw(2)), null);
  const dot = (tree) => find(tree, (x) => x.props?.title === 'Caparra da versare');
  assert.ok(dot(draw(1)));
  assert.equal(dot(draw(2)), null, 'la caparra è della visita: una volta sola');
});

test('in settimana il badge avvisa quando si trascina fuori turno, e lo spostamento parte lo stesso', async () => {
  const g = setup();
  // Anna 9–19, Giulia a riposo il giovedì
  g.api.weekGets().at(-1).resolve(weekPayload(W1).map((d) => ({ ...d, shifts: [
    { operator_id: 1, windows: [['09:00', '19:00']], absence: null },
    { operator_id: 2, windows: d.date === W1[3] ? [] : [['09:00', '19:00']], absence: null },
  ] })));
  await tick();
  g.m.render();
  const badge = () => find(g.root(), (el) => el.props?.className?.startsWith?.('dk-drag-badge'));
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));   // 16:00 da Anna: in turno
  g.m.render();
  assert.equal(badge().props.className, 'dk-drag-badge');
  g.root().props.onPointerMove(ptr(430, 400 + 4 * 81));   // 19:00: oltre la fine del turno
  g.m.render();
  assert.equal(badge().props.className, 'dk-drag-badge dk-drag-badge--warn');
  assert.ok(textOf(badge()).includes('Fuori turno'));
  g.root().props.onPointerMove(ptr(490, 481));   // da Giulia, che il giovedì riposa
  g.m.render();
  assert.ok(textOf(badge()).includes('Riposo'));
  g.root().props.onPointerUp(ptr(490, 481));
  await tick();
  assert.equal(g.api.posts.length, 1, 'avvisa, non ferma');
});

test('in settimana con le preferenze «Fissa» e «Solo orizzontali»: colonne uguali e niente scritte per lungo', async () => {
  const g = setup({ dynamicCols: false, verticalText: false });
  await loadWeek(g, W1);
  const day = find(g.root(), (el) => el.props?.['data-daycol'] === 3);
  // Sara è di Anna: con le colonne dinamiche Anna sarebbe 3 e Giulia 1
  assert.deepEqual(findAll(day, (el) => el.props?.['data-subcol'] === '').map((s) => s.props.style.flex), ['1 1 0', '1 1 0']);
  assert.deepEqual(findAll(g.root(), (el) => el.props?.className === 'dk-wsub').slice(6, 8).map((h) => h.props.style.flex), ['1 1 0', '1 1 0']);
  assert.equal(g.block().props.vertical, false);
});

/* 16/10: la cifra della testata era una sola, e non si capiva se fosse il
 * venduto, l'incassato o il previsto. Al passaggio la scheda dice i quattro
 * conti del giorno (GET /api/agenda/day-money). */
test('in settimana al passaggio sulla testata: valore atteso, già fatto, entrato e da incassare', async () => {
  const g = setup();
  globalThis.__dash.showRevenue = true;
  await loadWeek(g, W1);
  const head = () => find(g.root(), (el) => el.type?.name === 'WeekDayHeader' && el.props.index === 3);
  const button = () => find(head().type(head().props), (el) => el.type === 'button' && el.props.onClick && !el.props.role);
  assert.equal(button().props.title, undefined, 'la scheda prende il posto del suggerimento');
  const moneyGets = () => g.api.gets.filter((x) => x.url === '/api/agenda/day-money');
  button().props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => rect(406, 110, 120, 50) } });
  g.m.render();
  assert.deepEqual(moneyGets().map((x) => x.opts.params), [{ date: W1[3], location_id: 1 }]);
  const card = () => find(g.root(), (el) => el.type?.name === 'DayMoneyCard');
  assert.equal(card().props.money, 'loading');
  assert.deepEqual([card().props.tip.x, card().props.tip.y], [466, 166], 'sotto la testata, al centro del giorno');
  moneyGets()[0].resolve({ date: W1[3], expected: '120.00', done: '70.00', cash_in: '75.00', to_collect: '55.00', visits: 2, closed: 1 });
  await tick();
  g.m.render();
  const rows = findAll(card().type(card().props), (el) => el.type?.name === 'Row');
  assert.deepEqual(rows.map((r) => [r.props.label, r.props.amount]), [
    ['Valore atteso', '120.00'], ['Già fatto', '70.00'], ['Entrato in cassa', '75.00'], ['Da incassare', '55.00'],
  ]);
  // via e di nuovo sopra: niente seconda richiesta
  head().props.onMoneyLeave();
  g.m.render();
  assert.equal(card(), null);
  button().props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => rect(406, 110, 120, 50) } });
  g.m.render();
  assert.equal(moneyGets().length, 1);
  // la settimana si ricarica (un conto chiuso altrove): la scheda aperta si richiede
  g.live([{ type: 'sale.created' }]);
  await new Promise((r) => setTimeout(r, 400));
  g.api.weekGets().at(-1).resolve(weekPayload(W1));
  await tick();
  g.m.render();
  assert.equal(moneyGets().length, 2);
});

test('in settimana con gli importi nascosti la testata non apre i conti', async () => {
  const g = setup();
  await loadWeek(g, W1);
  const head = find(g.root(), (el) => el.type?.name === 'WeekDayHeader' && el.props.index === 3);
  assert.equal(head.props.onMoney, null);
  const button = find(head.type(head.props), (el) => el.type === 'button' && el.props.onClick);
  assert.equal(button.props.title, 'Apri il giorno');
  assert.equal(button.props.onMouseEnter, undefined);
});

/* 16/10: la colonna di un'operatrice disattivata, con appuntamenti, in
 * settimana si chiamava «Non più in team»: ora ha il suo nome (arriva dal
 * giorno, `extra_operators`), e al passaggio dice che non è più in team. */
test('in settimana la colonna di una disattivata ha il suo nome', async () => {
  const g = setup();
  const marta = { ...sara(W1[3]), id: 50, operator_id: 77, items: [{ service_id: 1, operator_id: 77, duration_min: 30, soak_min: 0, service_name: 'Piega' }] };
  g.api.weekGets().at(-1).resolve(weekPayload(W1).map((d, i) => (i === 3
    ? { ...d, appointments: [...d.appointments, marta], extra_operators: [{ id: 77, first_name: 'Marta', last_name: 'Gialli', inactive: true }] }
    : d)));
  await tick();
  g.m.render();
  const head = find(g.root(), (el) => el.type?.name === 'WeekDayHeader' && el.props.index === 3);
  const cells = findAll(head.type(head.props), (el) => el.props?.className === 'dk-wsub');
  const cell = cells.find((c) => c.key === '77' || c.props.title?.startsWith('Marta'));
  assert.equal(cell.props.title, 'Marta Gialli (non più in team)');
  assert.equal(textOf(find(cell, (el) => el.props?.className === 'dk-wsub__name')), 'Marta');
  assert.equal(textOf(find(cell, (el) => el.props?.className === 'dk-wsub__ini')), 'MG');
  // gli altri giorni non hanno la sua colonna
  const other = find(g.root(), (el) => el.type?.name === 'WeekDayHeader' && el.props.index === 2);
  assert.equal(findAll(other.type(other.props), (el) => el.props?.title?.startsWith('Marta')).length, 0);
});
