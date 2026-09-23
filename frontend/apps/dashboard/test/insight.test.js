// Analisi dati: «vs prec.» alla pari e giorni di chiusura fuori dal minimo.
// Caccia ai bug del 22/09/2026: 08-07 (+ 15-22), 15-14 (contratto C10).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setSalonTz } from '../../../packages/shared/src/format.js';
import { buildAllKpis, comparisonRanges } from '../src/sections/insight/kpiDefs.js';
import { occupancyStats } from '../src/sections/insight/chartMath.js';

test('08-07: il 22 settembre si confronta 1–22 settembre con 1–22 agosto, non con tutto agosto', () => {
  assert.deepEqual(comparisonRanges('month', '2026-09-22'), {
    current: { date_from: '2026-09-01', date_to: '2026-09-22' },
    previous: { date_from: '2026-08-01', date_to: '2026-08-22' },
  });
});

test('08-07: il 31 marzo si confronta con tutto febbraio (che finisce prima)', () => {
  assert.deepEqual(comparisonRanges('month', '2026-03-31').previous, { date_from: '2026-02-01', date_to: '2026-02-28' });
  // gennaio: il mese prima è dicembre dell'anno prima
  assert.deepEqual(comparisonRanges('month', '2026-01-10').previous, { date_from: '2025-12-01', date_to: '2025-12-10' });
});

test('08-07: trimestre e anno, stesso tratto del periodo precedente', () => {
  // 22/9 è il 3° mese del 3° trimestre → 1/4–22/6
  assert.deepEqual(comparisonRanges('quarter', '2026-09-22'), {
    current: { date_from: '2026-07-01', date_to: '2026-09-22' },
    previous: { date_from: '2026-04-01', date_to: '2026-06-22' },
  });
  // 1° trimestre: il precedente è il 4° dell'anno prima
  assert.deepEqual(comparisonRanges('quarter', '2026-02-15').previous, { date_from: '2025-10-01', date_to: '2025-11-15' });
  assert.deepEqual(comparisonRanges('year', '2026-09-22').previous, { date_from: '2025-01-01', date_to: '2025-09-22' });
  assert.deepEqual(comparisonRanges('year', '2028-02-29').previous, { date_from: '2027-01-01', date_to: '2027-02-28' });
});

test('15-22: «oggi» del confronto è il giorno del salone', () => {
  setSalonTz('Europe/Rome');
  const realNow = Date.now;
  // 1° ottobre 00:30 a Roma = 30 settembre 22:30 UTC: il mese in corso è ottobre
  Date.now = () => Date.parse('2026-09-30T22:30:00Z');
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [RealDate.now()])); }
    static now() { return RealDate.parse('2026-09-30T22:30:00Z'); }
  };
  try {
    assert.deepEqual(comparisonRanges('month').current, { date_from: '2026-10-01', date_to: '2026-10-01' });
    assert.deepEqual(comparisonRanges('month').previous, { date_from: '2026-09-01', date_to: '2026-09-01' });
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
});

test('08-07: le frecce confrontano il tratto in corso, i valori restano quelli del periodo', () => {
  const t = (it) => it;
  const eur = (n) => '€' + Number(n).toFixed(2);
  const cur = { revenue: '5000.00', sales_count: 50, avg_ticket: '100.00', retail_revenue: '0', appointments_count: 40, occupancy_pct: 55, return_rate: 0.5, rebooking_rate: 0.4, noshow_rate: 0.05, cancel_rate: 0.1, new_clients: 10, returning_clients: 30, avg_frequency: 1.5 };
  const partial = { ...cur, occupancy_pct: 60 };
  const prev = { ...cur, revenue: '5000.00', occupancy_pct: 60 };
  const k = buildAllKpis(cur, prev, t, 'it', eur, partial);
  assert.equal(k.revenue.delta, 0);          // stesso ritmo: niente freccia rossa
  assert.equal(k.occupancy_pct.delta, 0);    // confronto sul tratto in corso (60 vs 60)
  assert.equal(k.occupancy_pct.value, '55%'); // il valore mostrato è quello del periodo
});

test('15-14 / C10: un giorno di chiusura non è «il giorno più scarico»', () => {
  const rows = [
    { weekday: 0, occupancy_pct: null }, // lunedì chiuso
    { weekday: 1, occupancy_pct: 70 },
    { weekday: 2, occupancy_pct: 45 },   // mercoledì mezzo vuoto
    { weekday: 3, occupancy_pct: 80 },
    { weekday: 6, occupancy_pct: null }, // domenica chiusa
  ];
  const s = occupancyStats(rows);
  assert.equal(s.quietest.weekday, 2);
  assert.equal(s.lo, 45);
  assert.equal(s.hi, 80);
  assert.equal(s.open.length, 3);
});

test('C10: tutto chiuso → nessun minimo né giorno più scarico', () => {
  const s = occupancyStats([{ weekday: 0, occupancy_pct: null }]);
  assert.equal(s.quietest, null);
  assert.equal(s.hi, null);
});
