// Scheda operatrice: PUT parziale, modifiche altrui, dati di cassa nascosti,
// media degli incassi. Caccia ai bug del 22/09/2026: 09-09 (contratto C19),
// 09-01 (C6), 15-03, 15-18.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  changedOperatorFields, formFromDetail, perfStats, sameOperatorField, sameWeeks, weeksFromShifts,
} from '../src/sections/staff/lib.js';
import { rebaseDraft } from '../src/ui/rebase.js';

const detail = {
  id: 7, first_name: 'Giulia', last_name: 'Rossi', color: '#C9B8F2', role_title: 'Stylist',
  location_id: null, user_id: 12, service_ids: [3, 1], hourly_cost: '18.50', cycle_weeks: 1,
  active: true, order: 0, shifts: [{ week_index: 0, weekday: 0, start_min: 540, end_min: 1140 }],
};

test('C19: senza modifiche non si manda nulla', () => {
  assert.deepEqual(changedOperatorFields(formFromDetail(detail), detail), {});
});

test('C19: si manda solo il campo toccato, non colore e servizi letti all’apertura', () => {
  const form = { ...formFromDetail(detail), hourly_cost: 19 };
  assert.deepEqual(changedOperatorFields(form, detail), { hourly_cost: '19.00' });
});

test('C19: servizi come insieme, colore senza maiuscole, testi senza spazi ai lati', () => {
  const form = { ...formFromDetail(detail), service_ids: [1, 3], color: '#c9b8f2', first_name: 'Giulia ' };
  assert.deepEqual(changedOperatorFields(form, detail), {});
  const form2 = { ...formFromDetail(detail), service_ids: [1, 3, 9], last_name: ' Bianchi ', active: false };
  assert.deepEqual(changedOperatorFields(form2, detail), { last_name: 'Bianchi', service_ids: [1, 3, 9], active: false });
});

test('C6: costo orario nascosto (null) non diventa «0» e non si rimanda', () => {
  const hidden = { ...detail, hourly_cost: null, cash_hidden: true };
  const form = formFromDetail(hidden);
  assert.equal(form.hourly_cost, null);
  assert.deepEqual(changedOperatorFields({ ...form, role_title: 'Senior' }, hidden), { role_title: 'Senior' });
});

test('09-09: la modifica fatta altrove (servizio abilitato dal listino) resta, la mia pure', () => {
  const mine = { ...formFromDetail(detail), hourly_cost: 21 };           // io correggo il costo
  const fresh = { ...detail, service_ids: [1, 3, 5], color: '#B3DDF7' };  // la manager abilita il Balayage e cambia colore
  const { draft, conflicts } = rebaseDraft(mine, formFromDetail(detail), formFromDetail(fresh), sameOperatorField);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(draft.service_ids, [1, 3, 5]);
  assert.equal(draft.color, '#B3DDF7');
  assert.equal(draft.hourly_cost, 21);
  // il salvataggio manda solo il costo: il Balayage non si perde
  assert.deepEqual(changedOperatorFields(draft, fresh), { hourly_cost: '21.00' });
});

test('09-09: lo stesso campo cambiato qui e altrove resta il mio e si segnala', () => {
  const mine = { ...formFromDetail(detail), role_title: 'Senior stylist' };
  const fresh = { ...detail, role_title: 'Colorist' };
  const { draft, conflicts } = rebaseDraft(mine, formFromDetail(detail), formFromDetail(fresh), sameOperatorField);
  assert.equal(draft.role_title, 'Senior stylist');
  assert.deepEqual(conflicts, ['role_title']);
});

test('15-03: il pattern turni modificato si riconosce come modifica da salvare', () => {
  const saved = weeksFromShifts(detail.shifts, detail.cycle_weeks);
  const edited = JSON.parse(JSON.stringify(saved));
  assert.ok(sameWeeks(saved, weeksFromShifts(detail.shifts, detail.cycle_weeks)));
  edited[0].days[5].hours = '9–19';
  assert.ok(!sameWeeks(edited, saved));
});

test('15-18: la media degli incassi non è arrotondata all’euro', () => {
  const perf = [1200, 1250, 1300, 1150, 1257, 1250].map((v, i) => ({ month: `2026-0${i + 1}`, revenue: v.toFixed(2), sales_count: 10 }));
  const s = perfStats(perf);
  assert.equal(s.avg, 7407 / 6);                  // 1234,50 €, non 1235
  assert.equal(s.hidden, false);
  assert.equal(s.last, 1250);
});

test('C6: la serie senza importi è «nascosta», non una serie a zero', () => {
  const perf = [{ month: '2026-08', revenue: null, sales_count: 4, cash_hidden: true }, { month: '2026-09', revenue: null, sales_count: 2, cash_hidden: true }];
  assert.equal(perfStats(perf).hidden, true);
});
