// I conti della vista settimana (lib/week.js), senza DOM: i giorni pronti da
// disegnare con lo spostamento in corso, l'aggancio ai vicini, la richiesta
// di spostamento, l'avviso, l'ombra dell'appuntamento aperto.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin } from '@youty/shared';
import {
  hoverShape, movingBlock, movingBlocks, offLabel, shiftText, subcolWeight, weekBestSnap, weekColOf, weekDays, weekDropChanged,
  weekGhostSpans, weekMoveBody, weekParts, weekShiftWarning, weekSplitBody, whereLabel,
} from '../src/sections/agenda/lib/week.js';
import { weekLayout } from '../src/sections/agenda/lib/grid.js';

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

test('una disattivata con appuntamenti ha la colonna col suo nome (extra_operators del giorno)', () => {
  // la dashboard elenca solo le attive: il nome arriva dal giorno, e la colonna
  // diceva «Non più in team» (il titolare, 16/10)
  const marta = { ...sara, id: 44, operator_id: 77 };
  const days = payload([marta]).map((d, i) => (i === 3 ? { ...d, extra_operators: [{ id: 77, first_name: 'Marta', last_name: 'Gialli', inactive: true }] } : d));
  const out = weekDays(days, null, OPS, 1, 'Non più in team');
  const col = out[3].dayOps.find((o) => o.id === 77);
  assert.deepEqual([col.first_name, col.last_name, col.inactive, !!col.unknown], ['Marta', 'Gialli', true, false]);
  // senza nome dal server resta il ripiego, segnato come sconosciuto
  const fallback = weekDays(payload([marta]), null, OPS, 1, 'Non più in team')[3].dayOps.find((o) => o.id === 77);
  assert.deepEqual([fallback.first_name, fallback.unknown], ['Non più in team', true]);
  // le altre giornate non hanno la sua colonna
  assert.equal(out[2].dayOps.some((o) => o.id === 77), false);
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
  // Anna spenta; una parte di un'operatrice non più in team (99) e una di
  // Giulia: ognuna nella colonna di chi la fa, la visita contata una volta
  let d = weekDays(payload([visita([1, 99, 2])]), null, OPS, 1, 'Non più in team', [1])[3];
  assert.deepEqual(d.list.filter((a) => a.id === 45).map(weekColOf), [99, 2]);
  assert.ok(d.dayOps.some((o) => o.id === 2) && d.dayOps.some((o) => o.id === 99));
  assert.equal(d.count, 1, 'la visita conta una volta, non due blocchi (Sara è di Anna, spenta)');
  let v;
  // solo Bea dell'altra sede oltre ad Anna: Bea riceve la sua colonna in coda
  d = weekDays(payload([visita([1, 3])]), null, OPS, 1, 'Non più in team', [1])[3];
  v = d.list.find((a) => a.id === 45);
  assert.equal(weekColOf(v), 3);
  assert.ok(d.dayOps.some((o) => o.id === 3), 'la colonna di Bea c\'è: la visita si vede, non solo si conta');
  // solo un'operatrice non più in team: la colonna «non più in team» in coda
  d = weekDays(payload([visita([1, 99])]), null, OPS, 1, 'Non più in team', [1])[3];
  assert.ok(d.dayOps.some((o) => o.id === 99 && o.first_name === 'Non più in team'));
});

/* Una visita con più colleghe: in settimana una parte per colonna (15/10). */
const visitaMista = {
  ...sara, id: 50, start: '2026-10-01T10:00:00+02:00', operator_id: 1, duration_min: 120, total_price: '120.00',
  items: [
    { id: 501, service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Manicure' },
    { id: 502, service_id: 9, operator_id: 1, duration_min: 0, soak_min: 0, service_name: 'Nail art' },
    { id: 503, service_id: 2, operator_id: 2, duration_min: 60, soak_min: 0, service_name: 'Piega' },
    { id: 504, service_id: 1, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Manicure' },
  ],
};

test('le parti di una visita: una per servizio, gli aggiuntivi col loro servizio', () => {
  assert.deepEqual(weekParts(visitaMista).map((p) => [p.opId, p.startMin, p.endMin, p.items.map((it) => it.id)]), [
    [1, 600, 630, [501, 502]], [2, 630, 690, [503]], [1, 690, 720, [504]],
  ]);
  assert.equal(weekParts(sara).length, 1);
});

test('in settimana ogni parte sta nella colonna di chi la fa; la testata conta e somma la visita una volta', () => {
  const day = weekDays(payload([visitaMista]), null, OPS, 1, '', [])[3];
  const parts = day.list.filter((a) => a.id === 50);
  assert.deepEqual(parts.map((a) => [a.key, weekColOf(a), a.startMin, a.endMin, a.part, a.parts]), [
    ['50:0', 1, 600, 630, 1, 3], ['50:1', 2, 630, 690, 2, 3], ['50:2', 1, 690, 720, 3, 3],
  ]);
  assert.equal(parts[1].operator_id, 1, 'la principale resta Anna: serve agli spostamenti');
  assert.equal(parts[1].visitItems.length, 4);
  assert.deepEqual(day.visits.map((a) => a.id), [42, 50]);
  assert.equal(hoverShape(parts[1]).items.length, 4, 'l\'anteprima mostra tutta la visita');
  // con Anna spenta resta solo la parte di Giulia
  const off = weekDays(payload([visitaMista]), null, OPS, 1, '', [1])[3];
  assert.deepEqual(off.list.map((a) => a.key), ['50:1']);
  assert.equal(off.count, 1);
});

test('staccare una parte: i suoi servizi in un colpo, l\'operatrice solo se cambia', () => {
  const day = { date: W1[3] };
  const part = weekDays(payload([visitaMista]), null, OPS, 1, '', [])[3].list.find((a) => a.key === '50:0');
  const d = { obj: part, ns: 900, origOp: 1, nop: 1 };
  assert.deepEqual(weekSplitBody(day, d, false), { item_id: 501, item_ids: [501], start: isoAtMin(W1[3], 900) });
  assert.deepEqual(weekSplitBody(day, { ...d, nop: 2 }, true), { item_id: 501, item_ids: [501], start: isoAtMin(W1[3], 900), operator_id: 2, force: true });
  assert.equal(weekSplitBody(day, { ...d, obj: { ...part, items: [{ duration_min: 30 }] } }, false), null, 'senza id si sposta la visita');
});

test('spostare tutta la visita dalla barra di una parte: l\'inizio scala di quanto si è mossa la parte', () => {
  const day = { date: W1[3] };
  // la parte di Giulia (10:30) portata alle 11:30: la visita parte alle 11:00
  const d = { isPart: true, whole: true, apptStart: 600, orig: 630, ns: 690, origOp: 2, nop: 2 };
  assert.deepEqual(weekMoveBody(day, d, false), { start: isoAtMin(W1[3], 660) });
  // e durante la POST la visita compare già lì, con le parti al loro posto
  const days = weekDays(payload([visitaMista]), { id: 50, dayIdx: 3, ns: 660, nop: 2, fromOp: 2 }, OPS, 1, '');
  assert.deepEqual(days[3].list.filter((a) => a.id === 50).map((a) => [weekColOf(a), a.startMin]), [[1, 660], [2, 690], [1, 750]]);
});

test('staccando una parte ci si aggancia anche alle altre parti della visita; spostandola tutta no', () => {
  const day = weekDays(payload([visitaMista]), null, OPS, 1, '', [])[3];
  const part = day.list.find((a) => a.key === '50:2');
  const d = { id: 50, key: '50:2', obj: part, isPart: true, whole: false };
  assert.deepEqual(weekBestSnap(632, day, 1, d, 6), { min: 630, dist: 2, label: 'Sara Bianchi' });
  assert.equal(weekBestSnap(632, day, 1, { ...d, whole: true }, 6), null);
});

/* 16/10: i servizi accorpati della STESSA operatrice (le visite importate da
 * AreaBeauty) erano un blocco solo, e trascinandolo si spostava sempre tutta
 * la visita. Ora ogni servizio è una parte, come in vista giorno. */
const accorpata = {
  ...sara, id: 60, start: '2026-10-01T15:00:00+02:00', client_name: 'Sarah Mac', operator_id: 1, duration_min: 150,
  deposit_status: 'required',
  items: [
    { id: 601, service_id: 1, operator_id: 1, duration_min: 60, soak_min: 20, service_name: 'Colore' },
    { id: 602, service_id: 2, operator_id: 1, duration_min: 40, soak_min: 0, service_name: 'Piega' },
    { id: 603, service_id: 9, operator_id: 1, duration_min: 0, soak_min: 0, service_name: 'Nail art' },
    { id: 604, service_id: 3, operator_id: 1, duration_min: 30, soak_min: 0, service_name: 'Manicure' },
  ],
};

test('una visita accorpata della stessa operatrice: una parte per servizio, con la sua posa', () => {
  assert.deepEqual(weekParts(accorpata).map((p) => [p.opId, p.startMin, p.endMin, p.items.map((it) => it.id)]), [
    [1, 900, 980, [601]], [1, 980, 1020, [602, 603]], [1, 1020, 1050, [604]],
  ]);
  const day = weekDays(payload([accorpata]).map((d, i) => (i === 3 ? { ...d, appointments: [accorpata] } : d)), null, OPS, 1, '', [])[3];
  assert.deepEqual(day.list.map((a) => [a.key, weekColOf(a), a.part, a.parts, a.soakMin]), [
    ['60:0', 1, 1, 3, 20], ['60:1', 1, 2, 3, 0], ['60:2', 1, 3, 3, 0],
  ]);
  // il corpo della seconda stacca la piega con la sua nail art, da sola
  const d = { obj: day.list[1], ns: 1080, origOp: 1, nop: 1 };
  assert.deepEqual(weekSplitBody({ date: W1[3] }, d, false), { item_id: 602, item_ids: [602], start: isoAtMin(W1[3], 1080) });
  // l'anteprima di una parte: tutta la visita, con il suo servizio in evidenza
  assert.deepEqual(hoverShape(day.list[1]).focus_item_ids, [602, 603]);
  assert.equal(hoverShape(day.list[1]).items.length, 4);
  assert.equal(hoverShape(sara).focus_item_ids, undefined, 'una visita di un servizio non ne ha');
});

test('le parti attaccate stanno nella stessa corsia e si disegnano unite', () => {
  const day = weekDays(payload([accorpata]).map((d, i) => (i === 3 ? { ...d, appointments: [accorpata] } : d)), null, OPS, 1, '', [])[3];
  const out = weekLayout(day.list.filter((a) => weekColOf(a) === 1));
  const by = (key) => out.find((a) => a.key === key);
  assert.deepEqual(['60:0', '60:1', '60:2'].map((k) => [by(k)._lane, by(k)._joinTop, by(k)._joinBottom]), [
    [0, false, true], [0, true, true], [0, true, false],
  ]);
  // un altro appuntamento a metà visita non la spezza in due corsie
  const rita = { id: 70, startMin: 990, endMin: 1050 };
  const mixed = weekLayout([...day.list, rita]);
  assert.deepEqual(new Set(mixed.filter((a) => a.id === 60).map((a) => a._lane)).size, 1);
  assert.notEqual(mixed.find((a) => a.id === 70)._lane, mixed.find((a) => a.id === 60)._lane);
});

test('un blocco si allarga sulle corsie libere alla sua destra', () => {
  // 10:00–11:30, 10:15–10:45, 10:30–10:50 si sovrappongono; 11:00–11:15 tocca solo il primo
  const out = weekLayout([
    { id: 1, startMin: 600, endMin: 690 }, { id: 2, startMin: 615, endMin: 645 },
    { id: 3, startMin: 630, endMin: 650 }, { id: 4, startMin: 660, endMin: 675 },
  ]);
  const by = (id) => out.find((a) => a.id === id);
  assert.deepEqual([1, 2, 3, 4].map((id) => [by(id)._lane, by(id)._laneCount, by(id)._span]), [
    [0, 3, 1], [1, 3, 1], [2, 3, 1], [1, 3, 2],
  ]);
  // da solo: tutta la colonna
  assert.deepEqual(weekLayout([{ id: 9, startMin: 600, endMin: 630 }]).map((a) => [a._laneCount, a._span]), [[1, 1]]);
});

test('le sotto-colonne si allargano col lavoro del giorno; vuote restano cliccabili', () => {
  assert.equal(subcolWeight([]), 1);
  assert.equal(subcolWeight([{ id: 1, startMin: 600, endMin: 630 }]), 3);
  assert.equal(subcolWeight([{ id: 1, startMin: 600, endMin: 690 }, { id: 2, startMin: 615, endMin: 645 }, { id: 3, startMin: 630, endMin: 650 }]), 7);
  const days = weekDays(payload(), null, OPS, 1, '');
  // giovedì Sara è di Anna; Giulia è libera
  assert.deepEqual(days[3].dayOps.map((o) => [o.id, o.weight]), [[1, 3], [2, 1]]);
  // un giorno vuoto: tutte uguali
  assert.deepEqual(days[0].dayOps.map((o) => o.weight), [1, 1]);
});

test('trascinando la barra viaggiano tutte le parti, unite; la colonna di partenza passa a quella d\'arrivo', () => {
  const day = weekDays(payload([visitaMista]), null, OPS, 1, '', [])[3];
  const giulia = day.list.find((a) => a.key === '50:1');
  // la parte di Giulia (10:30) presa per la barra e portata da Anna, un'ora dopo
  const dg = { id: 50, obj: giulia, isPart: true, whole: true, orig: 630, ns: 690, origOp: 2, nop: 1, origDayIdx: 3, dayIdx: 3 };
  assert.deepEqual(movingBlocks(dg, [0, 1, 2, day]).map((m) => [m.key, m.colOp, m.startMin, m.endMin, m._joinTop, m._joinBottom]), [
    ['50:0', 1, 660, 690, false, true], ['50:1', 1, 690, 750, true, true], ['50:2', 1, 750, 780, true, false],
  ]);
  // senza cambio di colonna le parti restano alle loro operatrici, staccate
  assert.deepEqual(movingBlocks({ ...dg, nop: 2 }, [0, 1, 2, day]).map((m) => [m.colOp, m._joinTop]), [[1, false], [2, false], [1, false]]);
  // il corpo di una parte: viaggia lei sola, senza i segni della corsia di partenza
  const single = movingBlocks({ ...dg, whole: false, obj: { ...giulia, _joinTop: true } }, [0, 1, 2, day]);
  assert.equal(single.length, 1);
  assert.equal(single[0]._joinTop, undefined);
});

/* 16/10: i turni in settimana (`shifts` di /agenda/week). */
test('i turni: ogni sotto-colonna il suo, chi non ne ha a riposo o assente; senza turni in settimana niente', () => {
  const shifts = (i) => [
    { operator_id: 1, windows: [['09:00', '13:00'], ['14:00', '19:00']], absence: null },
    { operator_id: 2, windows: [], absence: i === 3 ? 'holiday' : null },
  ];
  const days = weekDays(payload().map((d, i) => ({ ...d, shifts: shifts(i) })), null, OPS, 1, '');
  assert.equal(days[3].usesShifts, true);
  assert.deepEqual(days[3].dayOps.map((o) => [o.id, o.shift, o.weight]), [
    [1, { windows: [['09:00', '13:00'], ['14:00', '19:00']], absence: null }, 3],
    [2, { windows: [], absence: 'holiday' }, 0.6],
  ]);
  // un'operatrice che il server non elenca: turno sconosciuto, niente tratteggio
  const noBea = weekDays(payload().map((d) => ({ ...d, shifts: [shifts(0)[0]] })), null, OPS, 1, '');
  assert.equal(noBea[3].dayOps[1].shift, null);
  // nessun turno in tutta la settimana: valgono gli orari del centro
  const none = weekDays(payload().map((d) => ({ ...d, shifts: [{ operator_id: 1, windows: [], absence: null }] })), null, OPS, 1, '');
  assert.equal(none[3].usesShifts, false);
  assert.equal(none[3].dayOps[0].shift, null);
  // payload senza turni (vecchio server): come prima
  assert.equal(weekDays(payload(), null, OPS, 1, '')[3].usesShifts, false);
});

test('i turni a parole: riposo, assenze, fasce', () => {
  assert.equal(offLabel({ windows: [], absence: null }, t), 'Riposo');
  assert.equal(offLabel({ windows: [], absence: 'vacation' }, t), 'Ferie');
  assert.equal(offLabel({ windows: [], absence: 'holiday' }, t), 'Festività');
  assert.equal(offLabel({ windows: [], absence: 'other' }, t), 'Assente');
  assert.equal(shiftText({ windows: [['09:00', '13:00'], ['14:00', '19:00']], absence: null }, t), '09:00–13:00 · 14:00–19:00');
  assert.equal(shiftText({ windows: [], absence: 'vacation' }, t), 'Ferie');
  assert.equal(shiftText(null, t), null);
});

test('trascinando fuori turno il badge avvisa; dentro, o senza turni, no', () => {
  const day = {
    usesShifts: true,
    dayOps: [
      { id: 1, shift: { windows: [['09:00', '13:00'], ['14:00', '19:00']], absence: null } },
      { id: 2, shift: { windows: [], absence: 'vacation' } },
      { id: 3, shift: null },
    ],
  };
  const at = (op, s, e) => ({ operator_id: op, startMin: s, endMin: e });
  assert.equal(weekShiftWarning([at(1, 600, 660)], day, t), null);
  assert.equal(weekShiftWarning([at(1, 750, 810)], day, t), 'Fuori turno', 'a cavallo della pausa');
  assert.equal(weekShiftWarning([at(1, 1110, 1170)], day, t), 'Fuori turno', 'sfora la fine');
  assert.equal(weekShiftWarning([at(2, 600, 660)], day, t), 'Ferie');
  assert.equal(weekShiftWarning([at(3, 0, 60)], day, t), null, 'turno sconosciuto');
  // tutta la visita: basta una parte fuori, nella sua colonna (colOp)
  assert.equal(weekShiftWarning([at(1, 600, 660), { ...at(1, 660, 720), colOp: 2 }], day, t), 'Ferie');
  assert.equal(weekShiftWarning([at(1, 750, 810)], { ...day, usesShifts: false }, t), null);
});
