// Il rapporto di lavoro dell'operatrice (16/10): nel team dal / fino al.
// Fuori da quei giorni non ha turni (il server, shift_windows): il
// riempimento dei mesi passati contava i turni di chi è arrivata dopo come
// capacità vuota. La scheda propone come inizio il primo appuntamento; il
// calendario, i turni del team e il pallino di oggi dicono «Non (ancora, più)
// in team» invece di «Riposo».
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { todayStr } from '@youty/shared';
import {
  changedOperatorFields, dayCoverage, emptyWeek, formFromDetail, outOfTeam, patternDay, todayStatus,
} from '../src/sections/staff/lib.js';
import { find, findAll, installDom, loadComponent, mount, spy, textOf, tick } from './grid-harness.mjs';

const { default: ProfileTab } = await loadComponent('apps/dashboard/src/sections/staff/ProfileTab.jsx', {
  stubs: ['ServicesAssign.jsx', 'ColorWheel.jsx'], expand: ['EmploymentFields'],
});
const { default: AbsenceCalendar } = await loadComponent('apps/dashboard/src/sections/staff/AbsenceCalendar.jsx');
const { cellLook } = await loadComponent('apps/dashboard/src/sections/staff/TeamRoster.jsx');
const { default: NewOperatorModal } = await loadComponent('apps/dashboard/src/sections/staff/NewOperatorModal.jsx', { stubs: ['ColorWheel.jsx'] });

const t = (it) => it;
const mounted = [];
afterEach(() => { while (mounted.length) mounted.pop().unmount(); });

test('fuori dal rapporto di lavoro: prima «before», dopo «after», estremi compresi', () => {
  assert.equal(outOfTeam('2026-03-01', '2026-03-02', null), 'before');
  assert.equal(outOfTeam('2026-03-02', '2026-03-02', '2026-03-10'), null);
  assert.equal(outOfTeam('2026-03-10', '2026-03-02', '2026-03-10'), null);
  assert.equal(outOfTeam('2026-03-11', '2026-03-02', '2026-03-10'), 'after');
  assert.equal(outOfTeam('2020-01-01', null, null), null, 'senza date nessun limite');
  // il pattern di quel giorno non vale
  const week = emptyWeek();
  week.days.forEach((d) => { d.hours = '9–19'; });
  assert.equal(patternDay([week], '2026-03-01', null, { from: '2026-03-02' }).kind, 'out');
  assert.equal(patternDay([week], '2026-03-03', null, { from: '2026-03-02' }).kind, 'work');
});

test('la copertura conta solo chi quel giorno è nel team, il pallino di oggi lo dice', () => {
  const day = { opening: [['09:00', '13:00']], cells: [
    { windows: [['09:00', '13:00']] }, { windows: [], out_of_team: 'before' }, { windows: [] },
  ] };
  assert.deepEqual([dayCoverage(day).working, dayCoverage(day).total], [1, 2]);
  assert.equal(todayStatus({ out_of_team: 'before', windows: [] }, t, 'it').label, 'Non ancora in team');
  assert.equal(todayStatus({ out_of_team: 'after', absence_type: 'vacation' }, t, 'it').label, 'Non più in team');
  assert.equal(cellLook({ windows: [], out_of_team: 'after' }, { opening: [['09:00', '19:00']] }, t, 'it').lines[0], 'Uscita');
});

test('la scheda manda le date solo se cambiate, vuote come null', () => {
  const detail = { first_name: 'Vera', last_name: 'T', color: '#E53935', active: true, service_ids: [], order: 0, employed_from: null, employed_until: null };
  const form = formFromDetail(detail);
  assert.deepEqual([form.employed_from, form.employed_until], [null, null]);
  assert.deepEqual(changedOperatorFields(form, detail), {});
  assert.deepEqual(changedOperatorFields({ ...form, employed_from: '2026-03-02' }, detail), { employed_from: '2026-03-02' });
  const saved = { ...detail, employed_from: '2026-03-02' };
  assert.deepEqual(changedOperatorFields({ ...formFromDetail(saved), employed_from: null }, saved), { employed_from: null }, 'svuotata: null');
});

function profile(form, firstWorkDay) {
  installDom();
  const state = { form };
  const setForm = (fn) => { state.form = typeof fn === 'function' ? fn(state.form) : fn; };
  const props = {
    form, setForm, canTeam: true, canPricing: true, locations: [], initials: 'VT', color: '#E53935', opPalette: [],
    services: [], serviceCategories: [], toggleSvc: spy(), onServiceCreated: spy(), t, lang: 'it', fireToast: spy(), firstWorkDay,
  };
  const m = mount(ProfileTab, props);
  mounted.push(m);
  return { m, state };
}
const base = { first_name: 'Vera', last_name: 'T', role_title: '', hourly_cost: '0', active: true, service_ids: [], location_id: null, employed_from: null, employed_until: null };

test('la scheda propone come inizio il giorno del primo appuntamento', () => {
  const { m, state } = profile(base, '2026-02-03');
  const box = find(m.tree, (el) => el.props?.['data-employment'] !== undefined);
  assert.ok(textOf(box).includes('Nel team dal'));
  const use = find(box, (el) => el.props?.['data-use-first-day'] !== undefined);
  assert.match(textOf(use), /Usa il primo appuntamento: 3 feb 2026/);
  use.props.onClick();
  assert.equal(state.form.employed_from, '2026-02-03');
  // una data scelta e poi svuotata torna null, non «»
  const inputs = findAll(box, (el) => el.type === 'input' && el.props.type === 'date');
  inputs[0].props.onChange({ target: { value: '' } });
  assert.equal(state.form.employed_from, null);
  inputs[1].props.onChange({ target: { value: '2026-12-31' } });
  assert.equal(state.form.employed_until, '2026-12-31');
});

test('la scheda avvisa se ci sono appuntamenti prima dell\'inizio, e se la fine viene prima', () => {
  const later = profile({ ...base, employed_from: '2026-03-01' }, '2026-02-03').m;
  assert.equal(find(later.tree, (el) => el.props?.['data-use-first-day'] !== undefined), null, 'la data c\'è: niente proposta');
  assert.match(textOf(find(later.tree, (el) => el.props?.['data-employment-warn'] !== undefined)), /Ha già appuntamenti dal 3 feb 2026/);
  const reversed = profile({ ...base, employed_from: '2026-03-01', employed_until: '2026-02-01' }, null).m;
  assert.ok(find(reversed.tree, (el) => el.props?.['data-employment-error'] !== undefined));
  const fine = profile({ ...base, employed_from: '2026-01-10' }, '2026-02-03').m;
  assert.equal(find(fine.tree, (el) => el.props?.['data-employment-warn'] !== undefined), null);
});

test('il calendario della scheda: prima di «nel team dal» non ha il turno del pattern', () => {
  installDom();
  globalThis.__api = { get: () => Promise.resolve([]), post: spy(), put: spy(), del: spy(), patch: spy() };
  globalThis.__dash = { t, lang: 'it', fireToast: spy(), settings: { opening_hours_week: {} } };
  const week = emptyWeek();
  week.days.forEach((d) => { d.hours = '9–19'; });
  const [y, mo] = todayStr().split('-');
  const from = `${y}-${mo}-15`;
  const m = mount(AbsenceCalendar, { operatorId: 7, absences: [], onChanged: spy(), canEdit: true, weeks: [week], period: { from, until: null } });
  mounted.push(m);
  const kind = (iso) => find(m.tree, (el) => el.props?.['data-day'] === iso).props['data-kind'];
  assert.deepEqual([kind(`${y}-${mo}-14`), kind(from)], ['out', 'work']);
  assert.ok(textOf(m.tree).includes('Non in team'), 'nella legenda');
});

test('nuova operatrice: «nel team dal» parte vuota, «Da oggi» la mette, e arriva al server', async () => {
  installDom();
  const posts = [];
  globalThis.__api = {
    get: () => Promise.resolve([]), put: spy(), del: spy(), patch: spy(),
    post: (url, body) => { posts.push(body); return Promise.resolve({ id: 99, ...body }); },
  };
  globalThis.__dash = {
    t, lang: 'it', services: [], locations: [], operators: [], opPalette: ['#E53935'],
    reload: { operators: () => Promise.resolve() }, fireToast: spy(),
  };
  const m = mount(NewOperatorModal, { onClose: spy(), onCreated: spy() });
  mounted.push(m);
  const box = () => find(m.tree, (el) => el.props?.['data-employment'] !== undefined);
  assert.equal(find(box(), (el) => el.type === 'input').props.value, '');
  find(box(), (el) => el.type === 'button' && textOf(el) === 'Da oggi').props.onClick();
  m.render();
  assert.equal(find(box(), (el) => el.type === 'input').props.value, todayStr());
  const inputs = findAll(m.tree, (el) => el.type === 'input' && !el.props.type);
  inputs[0].props.onChange({ target: { value: 'Cleo' } });
  inputs[1].props.onChange({ target: { value: 'C' } });
  m.render();
  const foot = find(m.tree, (el) => el.props?.foot).props.foot;
  await find(foot, (el) => el.type === 'button' && textOf(el).includes('Crea')).props.onClick();
  await tick();
  assert.equal(posts[0].employed_from, todayStr());
});
