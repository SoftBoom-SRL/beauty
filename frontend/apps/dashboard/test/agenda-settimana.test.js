// Vista settimana (WeekView.jsx vero, montato con test/grid-harness.mjs).
// Reperti della caccia ai bug del 22/09/2026: 12-10 (ricarico senza guardia),
// 12-14 / 12-15 / 12-18 (secondo dito, rotella, Esc durante il trascinamento),
// 12-21 (sotto-colonne di tutte le sedi), 13-08 (clic su un blocco con la
// prenotazione aperta). Bug sospetti del 24/09/2026: n. 48 (pinch e
// ⌘-rotella), n. 50 (clic per prenotare).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin } from '@youty/shared';
import { WHEEL_ZOOM_FACTOR, weekDayOps } from '../src/sections/agenda/lib.js';
import { EDGE_DELAY_FRAMES } from '../src/sections/agenda/lib/drag.js';
import { find, findAll, installDom, loadComponent, mount, ptr, rect, spy, tick } from './grid-harness.mjs';

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
  assert.equal(ritaEl().props.lc, 2);
  g.block().props.onDown(ptr(430, 400));
  g.root().props.onPointerMove(ptr(430, 481));
  g.m.render();
  // prima Sara usciva dal calcolo e Rita si allargava a tutta la sotto-colonna
  assert.equal(ritaEl().props.lc, 2, 'Rita resta nella sua corsia');
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
