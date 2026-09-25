// I conti della vista settimana (lib/week.js), senza DOM: i giorni pronti da
// disegnare con lo spostamento in corso, l'aggancio ai vicini, la richiesta
// di spostamento, l'avviso, l'ombra dell'appuntamento aperto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin } from '@youty/shared';
import {
  hoverShape, movingBlock, weekBestSnap, weekColOf, weekDays, weekDropChanged, weekGhostSpans, weekMoveBody, whereLabel,
} from '../src/sections/agenda/lib/week.js';

const t = (it) => it;
const W1 = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
const OPS = [
  { id: 1, first_name: 'Anna', last_name: 'Neri', location_id: 1 },
  { id: 2, first_name: 'Giulia', last_name: 'Verdi', location_id: null },
  { id: 3, first_name: 'Bea', last_name: 'Blu', location_id: 2 },
];
const sara = {
  id: 42, start: '2026-10-01T15:00:00+02:00', client_name: 'Sara Bianchi', client_phone: '333', operator_id: 1,
  status: 'confirmed', duration_min: 30, total_price: '30.00', items: [{ service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0 }],
};
const payload = (extra = []) => W1.map((date, i) => ({ date, count: 0, by_status: {}, appointments: i === 3 ? [sara, ...extra] : [] }));

test('i giorni da disegnare: orari in minuti e sotto-colonne della sede', () => {
  const days = weekDays(payload(), null, OPS, 1, 'Non più in team');
  assert.equal(days.length, 7);
  assert.deepEqual(days[3].list.map((a) => [a.id, a.startMin, a.endMin]), [[42, 900, 930]]);
  assert.deepEqual(days[0].dayOps.map((o) => o.id), [1, 2]);          // Bea lavora nell'altra sede
  assert.equal(days[3].date, W1[3]);
  // chi non è più in team ma ha appuntamenti resta visibile, col nome di ripiego
  const orphan = { ...sara, id: 43, operator_id: 99 };
  const withOrphan = weekDays(payload([orphan]), null, OPS, 1, 'Non più in team');
  assert.deepEqual(withOrphan[3].dayOps.map((o) => [o.id, o.first_name]), [[1, 'Anna'], [2, 'Giulia'], [99, 'Non più in team']]);
});

test('lo spostamento in POST compare già dove è stato lasciato', () => {
  const days = weekDays(payload(), { id: 42, dayIdx: 4, ns: 960, nop: 2 }, OPS, 1, '');
  assert.deepEqual(days[3].list, []);
  assert.deepEqual(days[4].list.map((a) => [a.id, a.operator_id, a.startMin, a.endMin]), [[42, 2, 960, 990]]);
});

test('aggancio in settimana: sotto la fine o sopra l\'inizio dei vicini della sotto-colonna', () => {
  const day = {
    list: [
      { id: 1, operator_id: 1, startMin: 540, endMin: 560, client_name: 'Aisha' },
      { id: 2, operator_id: 1, startMin: 600, endMin: 630, client_name: 'Bea' },
      { id: 3, operator_id: 2, startMin: 560, endMin: 600, client_name: 'Carla' },
    ],
  };
  const d = { id: 9, obj: { startMin: 700, endMin: 730 } };   // 30 minuti
  assert.deepEqual(weekBestSnap(561, day, 1, d, 6), { min: 560, dist: 1, label: 'Aisha' });
  assert.deepEqual(weekBestSnap(568, day, 1, d, 6), { min: 570, dist: 2, label: 'Bea' });   // finisce dove comincia Bea
  assert.deepEqual(weekBestSnap(601, day, 2, d, 6), { min: 600, dist: 1, label: 'Carla' });
  assert.equal(weekBestSnap(585, day, 1, d, 6), null);
  assert.equal(weekBestSnap(561, day, 1, { ...d, id: 1 }, 6), null, 'non ci si aggancia a se stessi');
  assert.equal(weekBestSnap(561, null, 1, d, 6), null);
});

test('il rilascio cambia qualcosa solo con orario, giorno o operatrice diversi', () => {
  const d = { ns: 900, orig: 900, dayIdx: 3, origDayIdx: 3, nop: 1, origOp: 1 };
  assert.equal(weekDropChanged(d), false);
  assert.equal(weekDropChanged({ ...d, ns: 915 }), true);
  assert.equal(weekDropChanged({ ...d, dayIdx: 4 }), true);
  assert.equal(weekDropChanged({ ...d, nop: 2 }), true);
});

test('la richiesta di spostamento: operatrice solo se cambia, force solo forzando', () => {
  const day = { date: W1[3] };
  const d = { ns: 960, nop: 1, origOp: 1 };
  assert.deepEqual(weekMoveBody(day, d, false), { start: isoAtMin(W1[3], 960) });
  assert.deepEqual(weekMoveBody(day, { ...d, nop: 2 }, false), { start: isoAtMin(W1[3], 960), operator_id: 2, from_operator_id: 1 });
  assert.deepEqual(weekMoveBody(day, { ...d, nop: null }, true), { start: isoAtMin(W1[3], 960), force: true });
  assert.deepEqual(Object.keys(weekMoveBody(day, { ...d, nop: 2 }, true)), ['start', 'operator_id', 'from_operator_id', 'force']);
});

test('l\'avviso dice giorno, operatrice e ora di arrivo', () => {
  const days = weekDays(payload(), null, OPS, 1, '');
  assert.equal(whereLabel(days, OPS, 3, 1, 960, t), 'Gio 1 · Anna · 16:00');
  assert.equal(whereLabel(days, OPS, 3, 99, 960, t), 'Gio 1 · 16:00');
  assert.equal(whereLabel(days, OPS, 9, 2, 600, t), 'Giulia · 10:00');
  assert.equal(whereLabel(days, OPS, 0, 2, 600, (it, en) => en), 'Mon 28 · Giulia · 10:00');
});

test('il blocco che segue il puntatore e la scheda di anteprima', () => {
  const obj = { id: 42, operator_id: 1, startMin: 900, endMin: 930, client_name: 'Sara' };
  assert.deepEqual(movingBlock({ obj, nop: 2, ns: 960 }), { id: 42, operator_id: 2, startMin: 960, endMin: 990, client_name: 'Sara' });
  const shaped = hoverShape(sara);
  assert.deepEqual(shaped.client, { full_name: 'Sara Bianchi', phone: '333' });
  assert.equal(shaped.total_duration_min, 30);
  assert.equal(shaped.id, 42);
});

test('l\'ombra in settimana: i servizi nell\'ordine in cui arrivano, almeno dieci minuti a video', () => {
  assert.deepEqual(weekGhostSpans(null), []);
  const ghost = {
    start: '2026-10-01T10:00:00+02:00', operator_id: 1,
    items: [
      { id: 2, order: 1, operator_id: 2, duration_min: 30, soak_min: 0 },
      { id: 1, order: 0, operator_id: null, duration_min: 5, soak_min: 0 },
    ],
  };
  // (itemBlocks li ordinerebbe per `order`; la settimana non l'ha mai fatto)
  assert.deepEqual(weekGhostSpans(ghost), [
    { key: 2, opId: 2, startMin: 600, dur: 30 },
    { key: 1, opId: 1, startMin: 630, dur: 10 },
  ]);
});

test('filtro «Team» in settimana: niente sotto-colonna né appuntamenti delle spente, e la testata conta il resto', () => {
  const giulia = { ...sara, id: 43, operator_id: 2, status: 'checked_in', start: '2026-10-01T10:00:00+02:00' };
  const all = weekDays(payload([giulia]), null, OPS, 1, '');
  assert.deepEqual(all[3].dayOps.map((o) => o.id), [1, 2]);
  assert.deepEqual(all[3].list.map((a) => a.id), [42, 43]);
  const days = weekDays(payload([giulia]), null, OPS, 1, '', [1]);   // Anna spenta
  assert.deepEqual(days[0].dayOps.map((o) => o.id), [2], 'la sotto-colonna di Anna non c\'è, nemmeno nei giorni liberi');
  assert.deepEqual(days[3].list.map((a) => a.id), [43], 'la visita di Anna non finisce in una colonna «non più in team»');
  assert.deepEqual(days[3].dayOps.map((o) => o.id), [2]);
  assert.equal(days[3].count, 1);
  assert.deepEqual(days[3].by_status, { checked_in: 1 });
  // senza filtro conteggi e stati restano quelli del server
  assert.equal(weekDays(payload([giulia]), null, OPS, 1, '')[3].count, 0);
});

test('filtro «Team» in settimana: la visita di una spenta resta nella colonna della collega accesa che ci lavora', () => {
  // manicure con Anna (principale) + piega con Giulia, giovedì alle 10
  const visita = {
    ...sara, id: 44, start: '2026-10-01T10:00:00+02:00', operator_id: 1, duration_min: 60,
    items: [{ service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0 }, { service_id: 2, operator_id: 2, duration_min: 30, soak_min: 0 }],
  };
  const days = weekDays(payload([visita]), null, OPS, 1, '', [1]);   // Anna spenta
  const shown = days[3].list.find((a) => a.id === 44);
  assert.ok(shown, 'la piega di Giulia non sparisce con Anna');
  assert.equal(shown.operator_id, 1, 'la principale resta Anna: serve agli spostamenti');
  assert.equal(weekColOf(shown), 2, 'disegnata nella colonna di Giulia');
  assert.equal(days[3].count, 1, 'e contata nella testata');
  // accesa la principale, niente colonna di disegno a parte
  assert.equal(weekDays(payload([visita]), null, OPS, 1, '')[3].list.find((a) => a.id === 44).colOp, undefined);
  // tutte e due spente: la visita non si vede
  assert.equal(weekDays(payload([visita]), null, OPS, 1, '', [1, 2])[3].list.some((a) => a.id === 44), false);
});

test('filtro «Team» in settimana: la colonna di disegno esiste sempre, e una collega della sede viene prima', () => {
  const visita = (items) => ({ ...sara, id: 45, start: '2026-10-01T10:00:00+02:00', operator_id: 1, duration_min: 90,
    items: items.map((op) => ({ service_id: 1, operator_id: op, duration_min: 30, soak_min: 0 })) });
  // Anna spenta; prima un'operatrice non più in team (99), poi Giulia accesa: si disegna da Giulia
  let d = weekDays(payload([visita([1, 99, 2])]), null, OPS, 1, 'Non più in team', [1])[3];
  let v = d.list.find((a) => a.id === 45);
  assert.equal(weekColOf(v), 2, 'nella colonna di Giulia, che c\'è già');
  assert.ok(d.dayOps.some((o) => o.id === weekColOf(v)));
  // solo Bea dell'altra sede oltre ad Anna: Bea riceve la sua colonna in coda
  d = weekDays(payload([visita([1, 3])]), null, OPS, 1, 'Non più in team', [1])[3];
  v = d.list.find((a) => a.id === 45);
  assert.equal(weekColOf(v), 3);
  assert.ok(d.dayOps.some((o) => o.id === 3), 'la colonna di Bea c\'è: la visita si vede, non solo si conta');
  // solo un'operatrice non più in team: la colonna «non più in team» in coda
  d = weekDays(payload([visita([1, 99])]), null, OPS, 1, 'Non più in team', [1])[3];
  assert.ok(d.dayOps.some((o) => o.id === 99 && o.first_name === 'Non più in team'));
});
