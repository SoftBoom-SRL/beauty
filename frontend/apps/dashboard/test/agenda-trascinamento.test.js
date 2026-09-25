// I conti del trascinamento in vista giorno (lib/drag.js), senza DOM: aggancio
// ai vicini, esito del rilascio, ridimensionamento, intenzione mandata al
// padre, posizione dei blocchi e testo del badge. Gli stessi casi della
// giornata di daygrid-drag.test.js, che li prova attraverso il componente.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { itemBlocks } from '../src/sections/agenda/lib.js';
import {
  badgeSpot, bestSnap, bestSnapEnd, canDo, dayDragContext, dragBadge, dragDy, dragReach, dragSpan, dropIntent, edgeSpeed, itemPosition, opFirstName,
  pausePosition, resizeStep, skillVerdict, snapAnchors, snapStart, snapTolerance, validateDrag, verdictTone, visitVerdict,
} from '../src/sections/agenda/lib/drag.js';

const t = (it) => it;
const PXM = 1.35;
const DATE = '2026-10-01';                       // giovedì
const at = (hm) => `${DATE}T${hm}:00+02:00`;     // ora del salone (Europe/Rome, ora legale)
const item = (id, name, op, dur, order = 0, soak = 0) => ({ id, service_id: id, service_name: name, operator_id: op, duration_min: dur, soak_min: soak, order });
const appt = (id, op, hm, client, items) => ({
  id, status: 'confirmed', operator_id: op, start: at(hm), client: { id: id + 100, full_name: client },
  total_duration_min: items.reduce((s, it) => s + it.duration_min + it.soak_min, 0), total_price: '40.00', items,
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
const OPS = [{ id: 1, first_name: 'Anna', service_ids: [] }, { id: 2, first_name: 'Giulia', service_ids: [] }];
const ctxOf = (extra = {}) => dayDragContext({ rows: ROWS, operators: OPS, step: 15, nowMin: null, t, ...extra });
const blockOf = (a, itemId) => itemBlocks(a).find((b) => b.item.id === itemId);

/* I trascinamenti come li costruisce DayGrid (onItemDown, onItemResizeDown, onPauseDown). */
const wholeDrag = (a, itemId, extra = {}) => {
  const b = blockOf(a, itemId);
  return { kind: 'item', apptId: a.id, itemId, block: b, detach: false, orig: b.startMin, origOp: b.opId, apptStart: itemBlocks(a)[0].startMin, ns: b.startMin, nop: b.opId, moved: false, ...extra };
};
const detachDrag = (a, itemId, extra = {}) => wholeDrag(a, itemId, { detach: true, ...extra });
const resizeDrag = (a, itemId, extra = {}) => {
  const b = blockOf(a, itemId);
  return { kind: 'item', mode: 'resize', apptId: a.id, itemId, block: b, orig: b.startMin, origDur: b.activeMin, ndur: b.activeMin, moved: false, ...extra };
};
const pauseDrag = (extra = {}) => ({ kind: 'pause', id: 5, obj: pausa, orig: 780, origOp: 1, ns: 780, nop: 1, moved: false, ...extra });

test('tolleranza dell\'aggancio: un filo sotto la metà della fascia, fra 4 e 8 minuti', () => {
  assert.deepEqual([5, 10, 15, 20, 30, 60].map(snapTolerance), [4, 4, 6, 8, 8, 8]);
  assert.equal(ctxOf().snapTol, 6);
  assert.equal(ctxOf({ step: 30 }).snapTol, 8);
});

test('il dy del trascinamento conta anche lo scorrimento della griglia', () => {
  assert.equal(dragDy({ cy: 500, startY: 400, startScroll: 20 }, 101), 181);
  assert.equal(dragDy({ cy: 380, startY: 400 }, 0), -20);   // senza startScroll si parte da zero
});

test('orario d\'arrivo: la fascia, oppure l\'aggancio se è vicino, dentro la griglia', () => {
  assert.deepEqual(snapStart(561, 15, null, 540, 1260), { ns: 555, snap: null });
  const near = { min: 560, dist: 1, label: 'Nail art', side: 'after' };
  // l'aggancio vince sulla fascia e il badge lo dice
  assert.deepEqual(snapStart(561, 15, near, 540, 1260), { ns: 560, snap: near });
  // se cade già sulla fascia non c'è niente da dire
  const onGrid = { min: 840, dist: 2, label: 'pausa', side: 'after' };
  assert.deepEqual(snapStart(842, 15, onGrid, 540, 1260), { ns: 840, snap: null });
  // mai prima dell'inizio della griglia, mai oltre l'ultima fascia
  assert.equal(snapStart(500, 15, null, 540, 1260).ns, 540);
  assert.equal(snapStart(1300, 15, null, 540, 1260).ns, 1245);
});

test('tutto quello che si muove resta entro la mezzanotte', () => {
  // un servizio di 1h45 portato in fondo alla giornata: finisce alle 24:00, non alle «25:30»
  assert.equal(snapStart(23 * 60 + 45, 15, null, 0, 1440, { tail: 105 }).ns, 22 * 60 + 15);
  // la piega (seconda della visita, un'ora dopo l'inizio) portata a mezzanotte e mezza: la visita parte alle 00:00
  assert.equal(snapStart(20, 15, null, 0, 1440, { head: 60, tail: 30 }).ns, 60);
  // quello che è corto resta all'ultima fascia
  assert.equal(snapStart(1500, 15, null, 0, 1440, { tail: 5 }).ns, 1425);
  // quanto si muove col blocco preso: la visita di Maria dalla piega (11:00) va dalle 10:00 alle 11:30
  assert.deepEqual(dragReach(wholeDrag(maria, 412)), { head: 60, tail: 30 });
  assert.deepEqual(dragReach(wholeDrag(maria, 411)), { head: 0, tail: 90 });
  // staccata la piega va da sola; la pausa è la pausa
  assert.deepEqual(dragReach(detachDrag(maria, 412)), { head: 0, tail: 30 });
  assert.deepEqual(dragReach(pauseDrag()), { head: 0, tail: 60 });
});

test('scorrimento ai bordi: dentro la fascia, più svelto verso il bordo, mai fuori', () => {
  // area 100..900, fascia 48 px
  assert.equal(edgeSpeed(500, 100, 900), 0);
  assert.equal(edgeSpeed(100, 100, 900), -16);        // sul bordo alto: il massimo, in su
  assert.equal(edgeSpeed(900, 100, 900), 16);
  assert.ok(edgeSpeed(870, 100, 900) > 0 && edgeSpeed(870, 100, 900) < edgeSpeed(890, 100, 900));
  assert.equal(edgeSpeed(147, 100, 900), -1, 'al limite della fascia, piano');
  // fuori dall'area (sopra, sull'intestazione) niente
  assert.equal(edgeSpeed(99, 100, 900), 0);
  assert.equal(edgeSpeed(901, 100, 900), 0);
  // in un'area bassa le due fasce non si toccano
  assert.equal(edgeSpeed(150, 100, 200), 0);
  assert.equal(edgeSpeed(101, 100, 200), -Math.round(16 * (24 / 25) ** 2));
});

test('il contesto: tutti i blocchi e le pause del giorno, e le righe per operatrice', () => {
  const ctx = ctxOf();
  assert.deepEqual(ctx.blocks.map((b) => b.item.id), [411, 412, 421, 431, 441]);
  assert.deepEqual(ctx.pauses.map((p) => p.id), [5]);
  assert.equal(ctx.rowOf(2).operator.name, 'Giulia Verdi');
  assert.equal(ctx.rowOf(9), undefined);
  assert.equal(opFirstName(ctx, 2), 'Giulia');
  assert.equal(opFirstName(ctx, 9), '');
});

test('abilitazione: senza elenco dei servizi non si blocca niente', () => {
  assert.equal(canDo(OPS, 1, 421), true);                               // elenco vuoto
  assert.equal(canDo([{ id: 1 }], 1, 421), true);                       // payload vecchio
  assert.equal(canDo([], 1, 421), true);                                // operatrice sconosciuta
  assert.equal(canDo([{ id: 2, service_ids: [412] }], 2, 421), false);
  assert.equal(canDo([{ id: 2, service_ids: [412] }], 2, 412), true);
  const ctx = ctxOf({ operators: [OPS[0], { id: 2, first_name: 'Giulia', service_ids: [412] }] });
  assert.deepEqual(skillVerdict(ctx, 2, [blockOf(sara, 421)]), {
    ok: false, code: 'skill', label: 'Giulia non fa Manicure', detail: 'Abilita il servizio in Staff',
  });
  assert.equal(skillVerdict(ctx, 2, [blockOf(maria, 412)]), null);
});

test('i bordi a cui agganciarsi: servizi, pause e turno, tranne quello che si trascina', () => {
  const ctx = ctxOf();
  assert.deepEqual(snapAnchors(ctx, 1, wholeDrag(sara, 421)).map((a) => [a.min, a.side, a.label]), [
    [660, 'after', 'Manicure'], [600, 'before', 'Manicure'],     // Maria (la visita di Sara no)
    [1230, 'after', 'Colore'], [1140, 'before', 'Colore'],
    [840, 'after', 'pausa'], [780, 'before', 'pausa'],
    [540, 'after', 'inizio turno'], [1140, 'before', 'fine turno'],
  ]);
  // la pausa trascinata non fa da vicino a se stessa
  assert.ok(!snapAnchors(ctx, 1, pauseDrag()).some((a) => a.label === 'pausa'));
  // la posa: ci si aggancia anche alla fine della fase attiva
  const colore = appt(50, 1, '09:00', 'Rita', [item(501, 'Colore', 1, 30, 0, 45)]);
  const soakCtx = dayDragContext({ rows: [{ ...ROWS[0], appointments: [colore] }], operators: OPS, step: 15, nowMin: null, t });
  assert.deepEqual(snapAnchors(soakCtx, 1, wholeDrag(sara, 421)).slice(0, 3).map((a) => [a.min, a.label]),
    [[615, 'Colore'], [570, 'posa di Colore'], [540, 'Colore']]);
});

test('quanto occupa quello che si trascina', () => {
  assert.equal(dragSpan(pauseDrag()), 60);
  assert.equal(dragSpan(detachDrag(maria, 411)), 60);
  // la visita intera: il gruppo della colonna di partenza
  assert.equal(dragSpan(wholeDrag(maria, 411)), 60);
  assert.equal(dragSpan(wholeDrag(maria, 412)), 30);
  const lunga = appt(51, 1, '09:00', 'Rita', [item(511, 'Colore', 1, 30, 0, 30), item(512, 'Piega', 1, 30, 1)]);
  assert.equal(dragSpan(wholeDrag(lunga, 512)), 90);
});

test('l\'aggancio più vicino, entro la tolleranza', () => {
  const nail = appt(52, 1, '09:00', 'Rita', [item(521, 'Nail art', 1, 20)]);   // finisce alle 09:20
  const ctx = dayDragContext({ rows: [{ ...ROWS[0], appointments: [nail, sara] }], operators: OPS, step: 15, nowMin: null, t });
  // Sara (30') trascinata alle 09:21: si attacca alla fine della nail art
  assert.deepEqual(bestSnap(ctx, 561, wholeDrag(sara, 421), 1), { min: 560, dist: 1, label: 'Nail art', side: 'after' });
  // alle 08:52 si attacca sopra, finendo dove comincia la nail art
  assert.deepEqual(bestSnap(ctx, 512, wholeDrag(sara, 421), 1), { min: 510, dist: 2, label: 'Nail art', side: 'before' });
  assert.equal(bestSnap(ctx, 600, wholeDrag(sara, 421), 1), null);
  // allungando, la fine si ferma dove comincia il vicino (a parità vince il primo)
  assert.deepEqual(bestSnapEnd(ctxOf(), 1137, resizeDrag(sara, 421), 1), { min: 1140, dist: 3, label: 'Colore', side: 'before' });
  assert.equal(bestSnapEnd(ctxOf(), 950, resizeDrag(sara, 421), 1), null);
});

test('esito di uno spostamento: libero, occupato, passato, non abilitata', () => {
  const ctx = ctxOf();
  assert.deepEqual(visitVerdict(ctx, sara, 0, 1, 2), { ok: true, code: 'ok', label: 'Disponibile', detail: '' });
  const busy = visitVerdict(ctx, sara, -270, 1, 1);           // Sara alle 10:30, sopra la manicure di Maria
  assert.equal(busy.code, 'busy');
  assert.equal(busy.label, 'Occupata fino alle 11:00');
  assert.equal(busy.detail, 'Maria Russo · Manicure');
  assert.equal(visitVerdict(ctxOf({ nowMin: 16 * 60 }), sara, 30, 1, 1).code, 'past');
  const skilled = ctxOf({ operators: [OPS[0], { id: 2, first_name: 'Giulia', service_ids: [412] }] });
  assert.equal(visitVerdict(skilled, sara, 0, 1, 2).code, 'skill');
  // la visita divisa: passano di mano solo i servizi della colonna di partenza
  assert.equal(visitVerdict(skilled, maria, 0, 1, 2).code, 'skill');   // la manicure non la fa Giulia
  assert.equal(visitVerdict(skilled, maria, 0, 2, 2).code, 'ok');
});

test('esito del rilascio per ogni tipo di trascinamento', () => {
  const ctx = ctxOf();
  assert.equal(validateDrag(ctx, null), null);
  assert.equal(validateDrag(ctx, resizeDrag(sara, 421)), null);
  // la pausa alle 10:00 finisce sopra la manicure di Maria
  assert.equal(validateDrag(ctx, pauseDrag({ ns: 600 })).code, 'busy');
  assert.equal(validateDrag(ctx, pauseDrag({ ns: 900, nop: 9 })), null);   // colonna sconosciuta
  // lo stacco della piega su Anna alle 10:30: sopra la manicure della STESSA cliente, si può
  assert.equal(validateDrag(ctx, detachDrag(maria, 412, { ns: 630, nop: 1 })).code, 'ok');
  // la visita intera di Sara alle 10:30: occupato
  assert.equal(validateDrag(ctx, wholeDrag(sara, 421, { ns: 630 })).code, 'busy');
  const skilled = ctxOf({ operators: [{ id: 1, first_name: 'Anna', service_ids: [411] }, OPS[1]] });
  assert.equal(validateDrag(skilled, detachDrag(maria, 412, { ns: 960, nop: 1 })).code, 'skill');
});

test('ridimensionare: passi di 5, aggancio al vicino, nessun tetto prima della mezzanotte', () => {
  const ctx = ctxOf();
  // un tocco di un pixel non cambia la durata e non conta come movimento
  assert.deepEqual(resizeStep(ctx, resizeDrag(sara, 421), 1, PXM), { ndur: 30, snap: null, moved: false });
  // +27 px = +20 minuti
  assert.deepEqual(resizeStep(ctx, resizeDrag(sara, 421), 27, PXM), { ndur: 50, snap: null, moved: true });
  // allungata fino a sfiorare le 19:00 di Elena: si ferma lì
  const snapped = resizeStep(ctx, resizeDrag(sara, 421), 207 * PXM, PXM);
  assert.equal(snapped.ndur, 240);
  assert.equal(snapped.snap.label, 'Colore');
  // il taglio delle 19:45 di Giulia si allunga oltre la griglia, fino alla mezzanotte
  assert.deepEqual(resizeStep(ctx, resizeDrag(tardi, 441), 370 * PXM, PXM), { ndur: 255, snap: null, moved: true });
  // la pausa non ha `block`: niente TypeError (12-02)
  assert.deepEqual(resizeStep(ctx, pauseDrag({ mode: 'resize', origDur: 60, ndur: 60 }), 27, PXM), { ndur: 80, snap: null, moved: true });
});

test('che cosa si manda al padre al rilascio', () => {
  assert.equal(dropIntent(wholeDrag(sara, 421)), null);                      // non si è mosso niente
  assert.deepEqual(dropIntent(detachDrag(maria, 411, { ns: 700, nop: 2 })),
    { kind: 'split', appt: maria, item: maria.items[0], startMin: 700, opId: 2 });
  // dalla piega (11:00) alle 11:30: la visita parte alle 10:30
  assert.deepEqual(dropIntent(wholeDrag(maria, 412, { ns: 690 })),
    { kind: 'appt', appt: maria, newApptStart: 630, opArg: 2, fromOp: 2 });
  assert.deepEqual(dropIntent(pauseDrag({ ns: 800 })), { kind: 'pause', pause: pausa, startMin: 800, opId: 1 });
});

test('dove si disegna un servizio: trascinamento > attesa del server > dati del server', () => {
  const b411 = blockOf(maria, 411), b412 = blockOf(maria, 412);
  const still = { startMin: 600, opId: 1, activeMin: 60, soakMin: 0 };
  assert.deepEqual(itemPosition(b411, null, null), still);
  // la visita intera da Anna a Carla (3), un'ora dopo: la piega di Giulia slitta e resta sua
  const whole = wholeDrag(maria, 411, { ns: 660, nop: 3, moved: true, verdict: 'V' });
  assert.deepEqual(itemPosition(b411, whole, null), { startMin: 660, opId: 3, activeMin: 60, soakMin: 0, dragging: true, verdict: 'V' });
  assert.deepEqual(itemPosition(b412, whole, null), { startMin: 720, opId: 2, activeMin: 30, soakMin: 0, dragging: true, verdict: 'V' });
  assert.deepEqual(itemPosition(b411, { ...whole, moved: false }, null), still);   // non ancora un trascinamento
  // lo stacco muove solo quel servizio
  const split = detachDrag(maria, 412, { ns: 700, nop: 1, moved: true, verdict: 'V' });
  // (`detach`: il servizio lascia la visita, e in colonna niente spina lo segue)
  assert.deepEqual(itemPosition(b412, split, null), { startMin: 700, opId: 1, activeMin: 30, soakMin: 0, dragging: true, detach: true, verdict: 'V' });
  assert.deepEqual(itemPosition(b411, split, null), still);
  // allungando la manicure la piega dopo slitta
  const resize = resizeDrag(maria, 411, { ndur: 75 });
  assert.deepEqual(itemPosition(b411, resize, null), { startMin: 600, opId: 1, activeMin: 75, soakMin: 0, resizing: true });
  assert.deepEqual(itemPosition(b412, resize, null), { startMin: 675, opId: 2, activeMin: 30, soakMin: 0 });
  // POST in corso: la visita è già all'arrivo, i servizi di Anna con Carla
  const pending = { kind: 'appt', id: 41, startMin: 720, opId: 3, fromOp: 1 };
  assert.deepEqual(itemPosition(b411, null, pending), { startMin: 720, opId: 3, activeMin: 60, soakMin: 0 });
  assert.deepEqual(itemPosition(b412, null, pending), { startMin: 780, opId: 2, activeMin: 30, soakMin: 0 });
});

test('dove si disegna una pausa', () => {
  assert.deepEqual(pausePosition(pausa, null, null), { startMin: 780, opId: 1 });
  assert.deepEqual(pausePosition(pausa, pauseDrag({ ns: 800, nop: 2, moved: true, verdict: 'V' }), null), { startMin: 800, opId: 2, dragging: true, verdict: 'V' });
  assert.deepEqual(pausePosition(pausa, pauseDrag({ mode: 'resize', ndur: 90 }), null), { startMin: 780, opId: 1, dur: 90, resizing: true });
  assert.deepEqual(pausePosition(pausa, null, { kind: 'pause', id: 5, startMin: 800, opId: 2, dur: 90 }), { startMin: 800, opId: 2, dur: 90 });
  assert.deepEqual(pausePosition(pausa, null, { kind: 'appt', id: 5, startMin: 800, opId: 2 }), { startMin: 780, opId: 1 });
});

test('tono del badge: al massimo l\'ambra, mai un divieto', () => {
  assert.equal(verdictTone(null), '');
  assert.equal(verdictTone({ ok: true, code: 'ok' }), 'ok');
  assert.equal(verdictTone({ ok: true, code: 'soak' }), 'warn');
  assert.equal(verdictTone({ ok: false, code: 'busy' }), 'warn');
});

test('il badge dice durata e inizio di quello che si muove davvero', () => {
  // stacco della piega: la SUA durata e il suo orario, non quelli della visita
  assert.deepEqual(dragBadge(detachDrag(maria, 412, { ns: 840 })), { detach: true, durMin: 30, start: 840, group: 1, moving: false });
  // la visita intera dalla spina di Anna: si muove il gruppo della sua colonna (1 di 2)
  assert.deepEqual(dragBadge(wholeDrag(maria, 411, { ns: 630 })), { detach: false, durMin: 90, start: 630, group: 1, moving: true });
  assert.deepEqual(dragBadge(wholeDrag(sara, 421, { ns: 960 })), { detach: false, durMin: 30, start: 960, group: 1, moving: false });
  assert.deepEqual(dragBadge(pauseDrag({ ns: 800 })), { detach: false, durMin: 60, start: 800, group: 1, moving: false });
});

test('il badge del trascinamento resta nella finestra', () => {
  const view = { innerWidth: 1440, innerHeight: 900 };
  // di solito in basso a destra del puntatore
  assert.deepEqual(badgeSpot(500, 400, view), { top: 418, left: 518 });
  // vicino al fondo sale sopra il puntatore, vicino al bordo destro va a sinistra
  assert.deepEqual(badgeSpot(500, 880, view), { bottom: 34, left: 518 });
  assert.deepEqual(badgeSpot(1300, 400, view), { top: 418, right: 154 });
  assert.deepEqual(badgeSpot(1300, 880, view), { bottom: 34, right: 154 });
});
