// Il pannello delle preferenze di visualizzazione dell'agenda
// (parts/ViewPrefs.jsx) e le sue scelte nella griglia (16/10): colonne
// dinamiche o fisse, scritte nei blocchi anche verticali o solo orizzontali;
// poi chi non è in turno e i giorni di chiusura, nascosti per lasciare
// spazio a chi lavora (trimWeek).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fixedColumns, trimWeek, weekShiftWarning } from '../src/sections/agenda/lib/week.js';
import { find, findAll, installDom, loadComponent, mount, rect, spy, textOf, tick } from './grid-harness.mjs';

const { default: ViewPrefs } = await loadComponent('apps/dashboard/src/sections/agenda/parts/ViewPrefs.jsx', { expand: ['Choice'] });
const { default: WeekBlock } = await loadComponent('apps/dashboard/src/sections/agenda/grid/WeekBlock.jsx');
const WEEK_PARTS = ['WeekDayHeader', 'HourGutter', 'WeekDayColumn', 'GridLines', 'NowLine', 'WeekDragBadge'];
const { default: WeekView } = await loadComponent('apps/dashboard/src/sections/agenda/WeekView.jsx', { expand: WEEK_PARTS });

const t = (it) => it;

test('il pannello: le due scelte con quella accesa e che cosa fa', () => {
  installDom();
  const setDynamicCols = spy(), setVerticalText = spy();
  const m = mount(ViewPrefs, { dynamicCols: true, setDynamicCols, verticalText: false, setVerticalText, t });
  const toggle = find(m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Preferenze di visualizzazione');
  assert.equal(toggle.props['aria-expanded'], false);
  toggle.props.onClick();
  m.render();
  const choice = (label) => find(m.tree, (el) => el.type === 'button' && textOf(el) === label);
  assert.deepEqual(['Dinamica', 'Fissa', 'Anche verticali', 'Solo orizzontali'].map((l) => choice(l).props['aria-pressed']), [true, false, false, true]);
  const text = textOf(m.tree);
  assert.ok(text.includes('Chi ha più appuntamenti nel giorno ha la colonna più larga'));
  assert.ok(text.includes('Mai per lungo'));
  choice('Fissa').props.onClick();
  choice('Anche verticali').props.onClick();
  assert.deepEqual(setDynamicCols.calls, [[false]]);
  assert.deepEqual(setVerticalText.calls, [[true]]);
  m.unmount();
});

test('colonne fisse: tutte le sotto-colonne larghe uguali, qualunque sia il lavoro', () => {
  const days = [{ date: '2026-10-15', dayOps: [{ id: 1, weight: 7 }, { id: 2, weight: 0.6 }] }];
  assert.deepEqual(fixedColumns(days)[0].dayOps.map((o) => o.weight), [1, 1]);
  assert.equal(days[0].dayOps[0].weight, 7, 'senza toccare i dati');
});

test('scritte solo orizzontali: niente nome per lungo, restano le iniziali e l\'ora', () => {
  installDom();
  const a = { id: 9, status: 'confirmed', client_name: 'Maria Russo', operator_id: 1, startMin: 600, endMin: 690, items: [{ id: 91, service_id: 1, service_name: 'Colore', operator_id: 1, duration_min: 90, soak_min: 0 }] };
  const draw = (vertical) => WeekBlock({ a, vertical, colorOf: () => '#C9B8F2', t, canWrite: true, left: 0, width: '100%' });
  const both = draw(true);
  assert.ok(both.props.className.includes('dk-wblock--tall'));
  assert.ok(find(both, (el) => el.props?.className === 'dk-wblock__v'));
  const flat = draw(false);
  assert.equal(flat.props.className, 'dk-wblock');
  assert.equal(find(flat, (el) => el.props?.className === 'dk-wblock__v'), null);
  assert.equal(textOf(find(flat, (el) => el.props?.className === 'dk-wblock__ini')), 'MR10:00');
  assert.equal(findAll(flat, (el) => el.props?.className === 'dk-wblock__h').length, 1, 'da larghi le righe restano');
});

/* ---- chi non è in turno, giorni di chiusura (16/10) ------------------------ */

test('il pannello: chi non è in turno e i giorni di chiusura, mostrati o nascosti', () => {
  installDom();
  const setHideOffShift = spy(), setHideClosed = spy();
  const m = mount(ViewPrefs, { hideOffShift: true, setHideOffShift, hideClosed: false, setHideClosed, dynamicCols: true, setDynamicCols: spy(), verticalText: true, setVerticalText: spy(), t });
  find(m.tree, (el) => el.type === 'button' && el.props['aria-label'] === 'Preferenze di visualizzazione').props.onClick();
  m.render();
  const groups = findAll(m.tree, (el) => el.props?.role === 'group').map((g) => g.props['aria-label']);
  assert.deepEqual(groups, ['Chi non è in turno', 'Giorni di chiusura', 'Larghezza delle colonne', 'Scritte nei blocchi']);
  assert.ok(textOf(m.tree).includes('più spazio a chi lavora'));
  const group = (label) => find(m.tree, (el) => el.props?.role === 'group' && el.props['aria-label'] === label);
  const btn = (label, txt) => find(group(label), (el) => el.type === 'button' && textOf(el) === txt);
  assert.deepEqual([btn('Chi non è in turno', 'Nascondi').props['aria-pressed'], btn('Giorni di chiusura', 'Mostra').props['aria-pressed']], [true, true]);
  btn('Chi non è in turno', 'Mostra').props.onClick();
  btn('Giorni di chiusura', 'Nascondi').props.onClick();
  assert.deepEqual(setHideOffShift.calls, [[false]]);
  assert.deepEqual(setHideClosed.calls, [[true]]);
});

const op = (id, windows, absence = null) => ({ id, first_name: 'Op' + id, last_name: '', weight: 1, shift: windows ? { windows, absence } : null });
const blk = (id, opId) => ({ id, operator_id: opId, startMin: 600, endMin: 660 });
const W = [['09:00', '19:00']];
const DAYS = [
  // lunedì: Anna lavora, Bea a riposo, Ciro a riposo ma con un appuntamento
  { date: '2026-10-12', usesShifts: true, list: [blk(1, 3)], dayOps: [op(1, W), op(2, []), op(3, [])] },
  // martedì aperto, nessuna in turno, niente in agenda
  { date: '2026-10-13', usesShifts: true, list: [], dayOps: [op(1, [], 'vacation'), op(2, [])] },
  // domenica chiusa per gli orari del centro
  { date: '2026-10-18', usesShifts: true, list: [], dayOps: [op(1, W), op(2, W)] },
];
const closedSunday = (date) => date === '2026-10-18';

test('trimWeek: senza turno e senza appuntamenti la colonna va via; chi ha lavoro o l\'ombra resta', () => {
  const plain = trimWeek(DAYS, { closedByHours: closedSunday });
  assert.deepEqual(plain.map((d) => d.dayOps.length), [3, 2, 2], 'senza le preferenze non cambia niente');
  assert.deepEqual(plain.map((d) => [d.hidden, d.closedHours, d.nobody]), [[false, false, false], [false, false, true], [false, true, false]]);
  const [mon, tue] = trimWeek(DAYS, { hideResting: true, closedByHours: closedSunday });
  assert.deepEqual(mon.dayOps.map((o) => o.id), [1, 3], 'Ciro a riposo ma con un appuntamento resta');
  assert.deepEqual(mon.offOps.map((o) => o.id), [2]);
  assert.deepEqual(tue.dayOps, [], 'nessuna in turno: nessuna colonna');
  assert.equal(tue.nobody, true, '«Nessuna in turno» si calcola prima di togliere le colonne');
  // l'operatrice dell'appuntamento aperto tiene la colonna dove cade l'ombra
  const kept = trimWeek(DAYS, { hideResting: true, keep: (date) => (date === '2026-10-12' ? [2] : []) });
  assert.deepEqual(kept[0].dayOps.map((o) => o.id), [1, 2, 3]);
  // senza turni in settimana non si toglie nessuno (le colonne libere sono quelle dove si prenota)
  const noShifts = trimWeek(DAYS.map((d) => ({ ...d, usesShifts: false, dayOps: d.dayOps.map((o) => ({ ...o, shift: null })) })), { hideResting: true });
  assert.deepEqual(noShifts.map((d) => d.dayOps.length), [3, 2, 2]);
  assert.equal(DAYS[0].dayOps.length, 3, 'senza toccare i dati');
});

test('trimWeek: un giorno chiuso, o senza nessuna in turno, sparisce solo se non ha appuntamenti', () => {
  const out = trimWeek(DAYS, { hideClosed: true, closedByHours: closedSunday });
  assert.deepEqual(out.map((d) => d.hidden), [false, true, true]);
  assert.equal(out.length, 3, 'i giorni nascosti restano al loro posto: gli indici non cambiano');
  // con un appuntamento la domenica resta
  const busy = trimWeek(DAYS.map((d, i) => (i === 2 ? { ...d, list: [blk(5, 1)] } : d)), { hideClosed: true, closedByHours: closedSunday });
  assert.deepEqual(busy.map((d) => d.hidden), [false, true, false]);
  // l'ombra dell'appuntamento aperto sul martedì lo tiene
  const ghost = trimWeek(DAYS, { hideClosed: true, closedByHours: closedSunday, keep: (date) => (date === '2026-10-13' ? [1] : []) });
  assert.deepEqual(ghost.map((d) => d.hidden), [false, false, true]);
  // chiusi tutti: si vedono tutti, una settimana vuota non direbbe niente
  const all = trimWeek(DAYS.slice(1), { hideClosed: true, closedByHours: closedSunday });
  assert.deepEqual(all.map((d) => d.hidden), [false, false]);
});

test('spostando su chi a riposo non ha la colonna, l\'avviso dice ancora «Riposo»', () => {
  const [mon] = trimWeek(DAYS, { hideResting: true });
  assert.equal(weekShiftWarning([{ ...blk(9, 2), colOp: 2 }], mon, t), 'Riposo');
  assert.equal(weekShiftWarning([{ ...blk(9, 1), colOp: 1 }], mon, t), null);
});

/* ---- nella griglia della settimana ------------------------------------------ */

const TEAM = [{ id: 1, first_name: 'Anna', last_name: 'Neri' }, { id: 2, first_name: 'Bea', last_name: 'Blu' }];
const WEEK = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const HOURS = { 0: W, 1: W, 2: W, 3: W, 4: W, 5: W, 6: [] };   // domenica chiusa

async function week(props = {}) {
  installDom();
  let resolveWeek = null;
  globalThis.__api = {
    get: () => new Promise((r) => { resolveWeek = r; }),
    post: () => Promise.resolve({}), put: () => Promise.resolve({}), patch: () => Promise.resolve({}), del: () => Promise.resolve({}),
  };
  globalThis.__dash = {
    t, lang: 'it', showRevenue: false, fireToast: spy(), openModal: spy(), hasScope: () => true,
    settings: { slot_interval_min: 15, opening_hours_week: HOURS }, locationId: null, modal: null, live: { subscribe: () => () => {} },
  };
  const scrollEl = {
    // stretta: i sette giorni non ci stanno (vedi «tutta la settimana in vista»)
    scrollTop: 0, clientHeight: 600, clientWidth: 600, getBoundingClientRect: () => rect(0, 100, 600, 600),
    querySelector: () => null, querySelectorAll: () => [], setPointerCapture() {}, addEventListener() {}, removeEventListener() {},
  };
  const onWidthZoom = spy();
  const m = mount(WeekView, {
    weekStart: WEEK[0], operators: TEAM, colorOf: () => '#C9B8F2', itemColor: null, nowMin: null,
    onOpenDay: spy(), onNewAppt: spy(), onOpenAppt: spy(), pickMode: false, ghost: null, ghostDate: WEEK[0], zoom: 1, onZoom: null,
    onWidthZoom, widthApi: { current: null }, ...props,
  }, { attach: (tree) => { if (tree?.props?.ref) tree.props.ref.current = scrollEl; } });
  // Bea lavora solo da mercoledì a sabato; il martedì è in ferie
  resolveWeek(WEEK.map((date, i) => ({
    date, count: 0, by_status: {},
    shifts: [
      { operator_id: 1, windows: i === 6 ? [] : W, absence: null },
      { operator_id: 2, windows: i >= 2 && i < 6 ? W : [], absence: i === 1 ? 'vacation' : null },
    ],
    appointments: [],
  })));
  await tick();
  m.render();
  return { m, onWidthZoom };
}
const dayCols = (m) => findAll(m.tree, (el) => el.props?.['data-daycol'] !== undefined).map((el) => el.props['data-daycol']);
const subOps = (m, i) => findAll(find(m.tree, (el) => el.props?.['data-daycol'] === i), (el) => el.props?.['data-subcol'] === '').map((el) => el.props['data-op']);
const heads = (m) => findAll(m.tree, (el) => el.type?.name === 'WeekDayHeader');

test('settimana: chi non è in turno senza colonna, la testata le conta; la domenica chiusa sparisce', async () => {
  const shown = await week();
  assert.deepEqual(dayCols(shown.m), [0, 1, 2, 3, 4, 5, 6], 'di partenza tutti i giorni');
  assert.deepEqual(subOps(shown.m, 0), [1, 2]);
  const { m, onWidthZoom } = await week({ hideOffShift: true, hideClosed: true });
  assert.deepEqual(dayCols(m), [0, 1, 2, 3, 4, 5], 'la domenica chiusa e vuota non c\'è; gli altri giorni tengono il loro indice');
  assert.deepEqual(heads(m).map((h) => [h.props.index, h.props.last]), [[0, false], [1, false], [2, false], [3, false], [4, false], [5, true]]);
  assert.deepEqual(subOps(m, 0), [1], 'lunedì Bea è a riposo: niente colonna');
  assert.deepEqual(subOps(m, 2), [1, 2]);
  // la testata dice quante mancano, e chi, al passaggio
  const head = (i) => heads(m).find((h) => h.props.index === i);
  const badge = (i) => find(head(i).type(head(i).props), (el) => el.props?.['data-off-ops'] != null);
  assert.equal(badge(0).props['data-off-ops'], 1);
  assert.equal(badge(0).props['aria-label'], 'Non in turno: Bea (Riposo)');
  assert.equal(badge(1).props['aria-label'], 'Non in turno: Bea (Ferie)');
  assert.equal(badge(2), null);
  // «Tutta la settimana in vista» sui sei giorni disegnati
  const { widthApi } = m.props;
  widthApi.current.fit();
  const sixDays = onWidthZoom.calls.at(-1)[0];
  const seven = await week({ hideOffShift: true });
  seven.m.props.widthApi.current.fit();
  assert.ok(sixDays > seven.onWidthZoom.calls.at(-1)[0], 'con un giorno in meno i giorni si allargano');
});

test('settimana: la testata di un giorno di chiusura dice «Chiuso», non «Libero»', async () => {
  const { m } = await week({ hideOffShift: true });
  const head = (i) => heads(m).find((h) => h.props.index === i);
  const text = (i) => textOf(head(i).type(head(i).props));
  assert.ok(text(6).includes('Chiuso'));
  assert.deepEqual(subOps(m, 6), [], 'la domenica nessuna in turno: nessuna colonna');
  // e niente conto di chi manca sopra la data: lo dice già «Chiuso»
  assert.equal(find(head(6).type(head(6).props), (el) => el.props?.['data-off-ops'] != null), null);
  assert.ok(find(head(0).type(head(0).props), (el) => el.props?.['data-off-ops'] != null));
  assert.ok(text(0).includes('Libero'));
});
