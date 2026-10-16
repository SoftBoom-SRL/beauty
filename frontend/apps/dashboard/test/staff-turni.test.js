// Turni nello Staff (16/10): il calendario della scheda riempito dal pattern
// (anche non salvato), «Turni del team» con la copertura e le eccezioni al
// volo, il passaggio da un'operatrice all'altra. Prima il calendario mostrava
// solo le assenze, e per sapere se il sabato pomeriggio era coperto bisognava
// aprire le schede una per una.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { todayStr } from '@youty/shared';
import { cycleWeekIndex, dayCoverage, emptyWeek, patternDay } from '../src/sections/staff/lib.js';
import { find, findAll, installDom, loadComponent, mount, rect, spy, textOf, tick } from './grid-harness.mjs';

const { default: AbsenceCalendar } = await loadComponent('apps/dashboard/src/sections/staff/AbsenceCalendar.jsx');
const { default: TeamRoster, cellLook } = await loadComponent('apps/dashboard/src/sections/staff/TeamRoster.jsx');
const { default: StaffPage } = await loadComponent('apps/dashboard/src/sections/staff/StaffPage.jsx', {
  stubs: ['ProfileTab.jsx', 'AbsenceCalendar.jsx', 'PerformancePanel.jsx', 'ServedClients.jsx'],
});
const { default: StaffSection } = await loadComponent('apps/dashboard/src/sections/staff/index.jsx', {
  stubs: ['StaffGrid.jsx', 'StaffPage.jsx', 'TeamRoster.jsx'],
});

const t = (it) => it;
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); });

/* Il ciclo dell'esempio del titolare: tre settimane, il giorno libero che
 * scorre (lunedì, mercoledì, venerdì), la domenica sempre. */
const rotating = () => [0, 2, 4].map((free) => {
  const w = emptyWeek();
  w.days.forEach((d, i) => { if (i !== free && i !== 6) { d.hours = '9–19'; d.brk = '13–14'; } });
  return w;
});
// un lunedì che per il ciclo di 3 settimane è la prima
const MONDAY = ['2026-10-05', '2026-10-12', '2026-10-19'].find((d) => cycleWeekIndex(d, 3) === 0);
const plus = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

test('il pattern su un giorno vero: il giorno libero scorre di settimana in settimana', () => {
  const weeks = rotating();
  const kinds = (base) => [0, 1, 2, 3, 4, 5, 6].map((i) => patternDay(weeks, plus(base, i)).kind);
  assert.deepEqual(kinds(MONDAY), ['off', 'work', 'work', 'work', 'work', 'work', 'off']);
  assert.deepEqual(kinds(plus(MONDAY, 7)), ['work', 'work', 'off', 'work', 'work', 'work', 'off']);
  assert.deepEqual(kinds(plus(MONDAY, 14)), ['work', 'work', 'work', 'work', 'off', 'work', 'off']);
  assert.deepEqual(kinds(plus(MONDAY, 21)), kinds(MONDAY), 'e poi si ripete');
  assert.deepEqual(patternDay(weeks, plus(MONDAY, 1)), { kind: 'work', week: 0, label: '9–19', brk: '13–14' });
  // il centro chiuso il martedì: il turno non conta
  assert.equal(patternDay(weeks, plus(MONDAY, 1), { 0: [['09:00', '19:00']], 1: [] }).kind, 'closed');
  assert.equal(patternDay(weeks, plus(MONDAY, 1), {}).kind, 'work', 'orari del centro non impostati');
  // un orario che non si legge
  weeks[0].days[1].hours = '9 alle 19';
  assert.deepEqual(patternDay(weeks, plus(MONDAY, 1)), { kind: 'bad', week: 0, label: '9 alle 19' });
});

const day = (opening, cells) => ({ date: '2026-10-20', opening, cells });
const cell = (id, windows, absence = null) => ({ operator_id: id, windows, week_index: 0, absence });

test('la copertura: quante in turno e, con gli orari del centro, le ore senza nessuna', () => {
  const both = [cell(1, [['09:00', '13:00'], ['14:00', '19:00']]), cell(2, [['10:00', '13:00'], ['14:00', '18:00']]), cell(3, [])];
  const open = dayCoverage(day([['09:00', '19:00']], both));
  assert.deepEqual([open.working, open.total, open.known], [2, 3, true]);
  assert.deepEqual(open.gaps, [[780, 840]], 'la pausa di tutte con il centro aperto');
  assert.deepEqual(open.slots.slice(0, 3).map((s) => s.count), [1, 1, 2]);
  // il centro chiude per pranzo: niente buco
  assert.deepEqual(dayCoverage(day([['09:00', '13:00'], ['14:00', '19:00']], both)).gaps, []);
  // orari non impostati: si guardano i turni, ma non si sa se all'ora di pranzo il centro è aperto
  const unknown = dayCoverage(day(null, both));
  assert.deepEqual([unknown.known, unknown.gaps, unknown.slots[0].from, unknown.slots.at(-1).to], [false, [], 540, 1140]);
  // centro chiuso: niente fasce
  assert.deepEqual(dayCoverage(day([], both)).slots, []);
});

test('la casella del team: orari, riposo, assenza, centro chiuso', () => {
  const open = day([['09:00', '19:00']], []);
  assert.deepEqual(cellLook(cell(1, [['09:00', '13:00'], ['14:00', '19:00']]), open, t, 'it').lines, ['9–13', '14–19']);
  assert.deepEqual(cellLook(cell(1, []), open, t, 'it').lines, ['Riposo']);
  assert.deepEqual(cellLook(cell(1, [], { id: 4, type: 'vacation', note: '', date_from: '2026-10-20', date_to: '2026-10-20' }), open, t, 'it').lines, ['Ferie']);
  assert.equal(cellLook(cell(1, [['09:00', '19:00']]), day([], []), t, 'it').kind, 'closed');
});

test('il calendario della scheda: ogni giorno col turno del ciclo, la settimana del ciclo per riga, l\'anteprima non salvata', () => {
  installDom();
  globalThis.__api = { get: () => Promise.resolve([]), post: spy(), put: spy(), del: spy(), patch: spy() };
  globalThis.__dash = { t, lang: 'it', fireToast: spy(), settings: { opening_hours_week: {} } };
  // la settimana del 10 del mese di oggi (il calendario si apre su quello)
  const [ty, tm] = todayStr().split('-');
  const tenth = `${ty}-${tm}-10`;
  const base = plus(tenth, -((new Date(tenth + 'T12:00:00').getDay() + 6) % 7));
  const absences = [{ id: 9, type: 'vacation', date_from: plus(base, 5), date_to: plus(base, 5), note: 'mare' }];
  const m = mount(AbsenceCalendar, { operatorId: 7, absences, onChanged: spy(), canEdit: true, weeks: rotating(), draft: true });
  mounted.push(m);
  const kind = (iso) => find(m.tree, (el) => el.props?.['data-day'] === iso).props['data-kind'];
  const free = [0, 2, 4][cycleWeekIndex(base, 3)];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => kind(plus(base, i))),
    [0, 1, 2, 3, 4, 5, 6].map((i) => (i === 5 ? 'absence' : i === 6 || i === free ? 'off' : 'work')));
  const labels = findAll(m.tree, (el) => el.props?.['data-cycle-week'] != null).map((el) => el.props['data-cycle-week']);
  assert.ok(labels.length >= 4, 'una per riga');
  labels.slice(1).forEach((w, i) => assert.equal(w, (labels[i] % 3) + 1, 'le settimane del ciclo in fila'));
  assert.ok(textOf(m.tree).includes('Anteprima con i turni non ancora salvati'));
  assert.ok(textOf(m.tree).includes('Riposo'), 'la legenda e i giorni dicono «Riposo»');
});

/* ---- Turni del team ---- */
const OPS = [
  { id: 7, first_name: 'Vera', last_name: 'Tosi', initials: 'VT', color: '#E53935', location_id: null, cycle_weeks: 3 },
  { id: 8, first_name: 'Inés', last_name: 'Marin', initials: 'IM', color: '#1A237E', location_id: null, cycle_weeks: 1 },
];
function roster() {
  installDom();
  const calls = { get: [], post: [], del: [] };
  const vacation = { id: 31, type: 'vacation', note: 'mare', date_from: '2026-10-21', date_to: '2026-10-21' };
  const payload = {
    operators: OPS,
    days: ['2026-10-19', '2026-10-20', '2026-10-21'].map((date, i) => ({
      date, opening: [['09:00', '19:00']],
      cells: [cell(7, i === 1 ? [] : i === 2 ? [] : [['09:00', '19:00']], i === 2 ? vacation : null), cell(8, i === 0 ? [['14:00', '19:00']] : [['09:00', '19:00']])],
    })),
  };
  globalThis.__api = {
    get: (url, opts) => { calls.get.push({ url, opts }); return Promise.resolve(payload); },
    post: (url, body) => { calls.post.push({ url, body }); return Promise.resolve({ id: 40, ...body }); },
    del: (url) => { calls.del.push(url); return Promise.resolve({ ok: true }); },
    put: spy(), patch: spy(),
  };
  globalThis.__dash = { t, lang: 'it', fireToast: spy(), hasScope: () => true, locationId: 3, opColors: {} };
  const onOpen = spy();
  const m = mount(TeamRoster, { onOpen });
  mounted.push(m);
  return { m, calls, onOpen };
}

test('turni del team: chiede i giorni della sede, mostra le caselle e la copertura', async () => {
  const g = roster();
  await tick();
  g.m.render();
  assert.equal(g.calls.get[0].url, '/api/staff/roster');
  assert.deepEqual(Object.keys(g.calls.get[0].opts.params), ['start', 'days', 'location_id']);
  assert.equal(g.calls.get[0].opts.params.days, 14);
  const kinds = findAll(g.m.tree, (el) => el.props?.['data-cell'] != null).map((el) => [el.props['data-cell'], el.props['data-kind']]);
  assert.deepEqual(kinds.slice(0, 3), [['7:2026-10-19', 'work'], ['7:2026-10-20', 'off'], ['7:2026-10-21', 'absence']]);
  // lunedì Inés solo di pomeriggio e Vera tutto il giorno: coperto; martedì Vera riposa, Inés c'è
  const cov = (iso) => find(g.m.tree, (el) => el.props?.['data-coverage'] === iso);
  assert.equal(cov('2026-10-20').props.title, 'Coperto');
  assert.ok(textOf(cov('2026-10-20')).includes('1/2'));
  // 4 settimane: si richiede
  find(g.m.tree, (el) => el.type === 'button' && textOf(el) === '4 settimane').props.onClick();
  await tick();
  g.m.render();
  assert.equal(g.calls.get.at(-1).opts.params.days, 28);
  // il nome apre la scheda
  find(g.m.tree, (el) => el.type === 'button' && el.props.title === 'Apri la scheda: turni e assenze' && textOf(el).includes('Vera')).props.onClick();
  assert.deepEqual(g.onOpen.calls, [[7]]);
});

test('turni del team: un clic segna le ferie per più giorni, o le toglie', async () => {
  const g = roster();
  await tick();
  g.m.render();
  const cellBtn = (key) => find(g.m.tree, (el) => el.props?.['data-cell'] === key);
  cellBtn('7:2026-10-19').props.onClick({ currentTarget: { getBoundingClientRect: () => rect(500, 300, 60, 40) } });
  g.m.render();
  const pop = () => find(g.m.tree, (el) => el.props?.role === 'dialog');
  assert.ok(textOf(pop()).includes('In turno 9–19'));
  find(pop(), (el) => el.type === 'button' && textOf(el) === 'Festività').props.onClick();
  g.m.render();
  find(pop(), (el) => el.type === 'input' && el.props.type === 'date').props.onChange({ target: { value: '2026-10-20' } });
  g.m.render();
  find(pop(), (el) => el.type === 'button' && textOf(el) === 'Aggiungi').props.onClick();
  await tick();
  g.m.render();
  assert.deepEqual(g.calls.post, [{ url: '/api/staff/7/absences', body: { date_from: '2026-10-19', date_to: '2026-10-20', type: 'holiday', note: '' } }]);
  assert.equal(pop(), null, 'il riquadro si chiude');
  assert.equal(g.calls.get.length, 2, 'e i turni si rileggono');
  // l'assenza del mercoledì si toglie
  cellBtn('7:2026-10-21').props.onClick({ currentTarget: { getBoundingClientRect: () => rect(560, 300, 60, 40) } });
  g.m.render();
  assert.ok(textOf(pop()).includes('Ferie'));
  assert.ok(textOf(pop()).includes('mare'));
  find(pop(), (el) => el.type === 'button' && textOf(el).startsWith('Togli l’assenza')).props.onClick();
  await tick();
  assert.deepEqual(g.calls.del, ['/api/staff/7/absences/31']);
});

test('turni del team: chi non ha il permesso «team» guarda e basta', async () => {
  const g = roster();
  globalThis.__dash.hasScope = () => false;
  g.m.render();
  await tick();
  g.m.render();
  find(g.m.tree, (el) => el.props?.['data-cell'] === '7:2026-10-19').props.onClick({ currentTarget: { getBoundingClientRect: () => rect(500, 300, 60, 40) } });
  g.m.render();
  const pop = find(g.m.tree, (el) => el.props?.role === 'dialog');
  assert.equal(find(pop, (el) => el.type === 'button' && textOf(el) === 'Aggiungi'), null);
  assert.ok(textOf(pop).includes('In turno'));
});

test('lo Staff: schede o turni del team; dai turni la scheda si apre sui turni, e si passa da una all\'altra', () => {
  installDom();
  globalThis.__dash = { t, lang: 'it' };
  const m = mount(StaffSection, {});
  mounted.push(m);
  const tabs = () => find(m.tree, (el) => el.type?.name === 'SubTabs' || (el.props?.tabs && el.props.onChange));
  assert.ok(find(m.tree, (el) => el.type?.name === 'StaffGrid'));
  find(m.tree, (el) => el.type?.name === 'StaffGrid').props.top.props.onChange('roster');
  m.render();
  const roster = find(m.tree, (el) => el.type?.name === 'TeamRoster');
  assert.ok(roster, 'la vista dei turni');
  assert.ok(tabs() || roster.props.top);
  roster.props.onOpen(8);
  m.render();
  const page = () => find(m.tree, (el) => el.type?.name === 'StaffPage');
  assert.deepEqual([page().props.id, page().props.initialTab], [8, 'turni']);
  page().props.onSwitch(7);
  m.render();
  assert.equal(page().props.id, 7);
  page().props.onBack();
  m.render();
  assert.ok(find(m.tree, (el) => el.type?.name === 'TeamRoster'), 'si torna ai turni');
});

test('nella scheda si passa all\'operatrice dopo sulla stessa linguetta, ma non con modifiche in sospeso', async () => {
  installDom();
  const detail = { id: 8, first_name: 'Inés', last_name: 'Marin', initials: 'IM', color: '#1A237E', role_title: '', location_id: null, user_id: null, service_ids: [], hourly_cost: null, cycle_weeks: 1, active: true, order: 1, shifts: [] };
  globalThis.__api = {
    get: (url) => Promise.resolve(url === '/api/staff/8' ? detail : []),
    post: spy(), put: spy(), del: spy(), patch: spy(),
  };
  const fireToast = spy();
  globalThis.__dash = {
    t, lang: 'it', services: [], serviceCategories: [], locations: [], fireToast, hasScope: () => true, showRevenue: true,
    setSelClient: spy(), setTab: spy(), opPalette: [], reload: { operators: () => Promise.resolve() },
    operators: [{ id: 7, first_name: 'Vera', last_name: 'Tosi' }, { id: 8, first_name: 'Inés', last_name: 'Marin' }, { id: 9, first_name: 'Dafne', last_name: 'Pozzi' }],
  };
  const onSwitch = spy();
  const m = mount(StaffPage, { id: 8, onBack: spy(), initialTab: 'turni', onSwitch });
  mounted.push(m);
  await tick();
  m.render();
  const btn = (label) => find(m.tree, (el) => el.type === 'button' && el.props['aria-label'] === label);
  assert.equal(btn('Operatrice successiva').props.title, 'Dopo: Dafne Pozzi');
  assert.ok(textOf(m.tree).includes('2/3'));
  btn('Operatrice precedente').props.onClick();
  assert.deepEqual(onSwitch.calls, [[7]]);
  // un turno cambiato e non salvato: non si passa, e si dice perché
  const pattern = find(m.tree, (el) => el.type?.name === 'ShiftPattern');
  assert.ok(pattern, 'si è aperta sui turni');
  const weeks = pattern.props.weeks.map((w) => ({ days: w.days.map((d, i) => (i === 0 ? { hours: '9–19', brk: '' } : d)) }));
  pattern.props.setWeeks(weeks);
  m.render();
  btn('Operatrice successiva').props.onClick();
  assert.equal(onSwitch.calls.length, 1);
  assert.match(fireToast.calls.at(-1)[0].msg, /modifiche non salvate/);
});
