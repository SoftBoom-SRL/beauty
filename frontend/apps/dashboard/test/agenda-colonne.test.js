// Le colonne della vista giorno e i loro colori: il filtro «Team» (chi si
// disegna, «Solo chi lavora oggi») e il testo leggibile sopra i colori del
// salone. Riordino dell'agenda del 24/09/2026: la riga delle chip «Calendari»
// è diventata un filtro nella barra, e le colonne di chi è a riposo si
// possono nascondere senza perdere un blocco.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inkOn, restingIds, visibleDayRows, wantsLightText, workingOperatorIds } from '../src/sections/agenda/lib.js';

const it = (id, op) => ({ id, service_id: id, operator_id: op, duration_min: 30, soak_min: 0 });
/* Anna lavora; Bea è a riposo ma fa la piega dentro la visita di Anna; Carla
 * è a riposo e ha solo una pausa; Dora è a riposo e non ha niente. */
const ROWS = [
  { operator: { id: 1, name: 'Anna' }, windows: [['09:00', '18:00']], pauses: [],
    appointments: [{ id: 10, operator_id: 1, status: 'confirmed', items: [it(101, 1), it(102, 2)] }] },
  { operator: { id: 2, name: 'Bea' }, windows: [], pauses: [], appointments: [] },
  { operator: { id: 3, name: 'Carla' }, windows: [], pauses: [{ id: 5, operator_id: 3 }], appointments: [] },
  { operator: { id: 4, name: 'Dora' }, windows: [], pauses: [], appointments: [] },
];
const ids = (rows) => rows.map((r) => r.operator.id);

test('chi lavora: turno, pausa, o un servizio dentro la visita di una collega', () => {
  assert.deepEqual([...workingOperatorIds(ROWS)].sort(), [1, 2, 3]);
});

test('un appuntamento annullato non tiene visibile la colonna', () => {
  const rows = [{ operator: { id: 4, name: 'Dora' }, windows: [], pauses: [],
    appointments: [{ id: 11, operator_id: 4, status: 'cancelled', items: [it(111, 4)] }] }];
  assert.deepEqual([...workingOperatorIds(rows)], []);
});

test('«Solo chi lavora oggi» nasconde solo chi non ha niente, mai il blocco di una collega', () => {
  assert.deepEqual(ids(visibleDayRows(ROWS, {}, { onlyWorking: true })), [1, 2, 3]);
  assert.deepEqual(ids(visibleDayRows(ROWS, {}, { onlyWorking: false })), [1, 2, 3, 4]);
});

test('il filtro spegne le colonne scelte, e «Solo chi lavora» si somma', () => {
  assert.deepEqual(ids(visibleDayRows(ROWS, { 1: false })), [2, 3, 4]);
  assert.deepEqual(ids(visibleDayRows(ROWS, { 1: false }, { onlyWorking: true })), [2, 3]);
  // tutto spento: la griglia resta vuota, non si riaccende niente da sola
  assert.deepEqual(ids(visibleDayRows(ROWS, { 1: false, 2: false, 3: false, 4: false })), []);
});

test('la colonna dell\'ombra dell\'appuntamento aperto resta anche a riposo', () => {
  assert.deepEqual(ids(visibleDayRows(ROWS, {}, { onlyWorking: true, keep: [4] })), [1, 2, 3, 4]);
});

test('chi è a riposo e il filtro sta nascondendo (fra le accese)', () => {
  assert.deepEqual(restingIds(ROWS, {}), [4]);
  assert.deepEqual(restingIds(ROWS, { 4: false }), [], 'Dora spenta a mano non conta');
  assert.deepEqual(restingIds(ROWS, {}, [4]), [], 'Dora tenuta per l\'ombra non conta');
});

test('testo bianco sui colori scuri, scuro sui chiari: vince il contrasto più alto', () => {
  assert.equal(wantsLightText('#6366F1'), true, 'indaco pieno (seed_demo)');
  assert.equal(wantsLightText('#1E3A8A'), true, 'blu notte');
  assert.equal(wantsLightText('#EC4899'), false, 'il rosa pieno regge meglio il testo scuro');
  assert.equal(wantsLightText('#FDE2E4'), false, 'categoria Unghie');
  assert.equal(wantsLightText('#F59E0B'), false, 'l\'ambra è chiara: testo scuro');
  assert.equal(wantsLightText('#6366F1', 0.2), false, 'lo stesso indaco schiarito all\'80%');
  assert.equal(wantsLightText('#FFF'), false, 'anche a tre cifre');
});

test('un colore che non si sa leggere resta col testo scuro di sempre', () => {
  assert.equal(wantsLightText('var(--clay)'), false);
  assert.equal(wantsLightText(null), false);
  assert.equal(inkOn('var(--clay)').ink, 'var(--ink)');
  assert.equal(inkOn('#1A1A2E', 0.82).ink, '#FFFFFF');
});
