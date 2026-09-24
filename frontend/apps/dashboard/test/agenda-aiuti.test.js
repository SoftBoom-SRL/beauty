// Aiuti dell'agenda nati dalle copie sparse nelle viste (giorno della
// settimana, etichette di giorno e ora, passo degli slot, anteprima al
// passaggio del mouse, righe della griglia, fasce fuori turno). Ognuno si
// confronta con l'espressione che sostituisce, copiata così com'era.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseISO, timeLabel } from '@youty/shared';
import {
  DOW_EN, DOW_IT, closedIntervals, dayLabel, dayTimeLabel, dowIndex, gridMarks, hmToMin, hoverPlacement,
  openApptIdOf, slotStep, visibleMarks,
} from '../src/sections/agenda/lib.js';

// come makeT di @youty/shared (i18n.jsx, che nei test non si carica)
const tFor = (lang) => (it, en) => (lang === 'en' ? (en ?? it) : it);
const DAYS = ['2026-09-28', '2026-09-29', '2026-10-01', '2026-10-04', '2026-12-31', '2027-01-01', '2026-03-29'];

test('dowIndex: lunedì 0 … domenica 6, come (getDay() + 6) % 7', () => {
  assert.deepEqual(DAYS.map((iso) => dowIndex(parseISO(iso))), DAYS.map((iso) => (parseISO(iso).getDay() + 6) % 7));
  assert.equal(dowIndex(parseISO('2026-09-28')), 0);
  assert.equal(dowIndex(parseISO('2026-10-04')), 6);
});

test('dayLabel e dayTimeLabel scrivono quello che scrivevano le viste', () => {
  for (const lang of ['it', 'en']) {
    const t = tFor(lang);
    for (const iso of DAYS) {
      const dd = parseISO(iso);
      // vista giorno, badge sopra la pillola (DayGrid)
      assert.equal(dayLabel(iso, t), `${t(DOW_IT[(dd.getDay() + 6) % 7], DOW_EN[(dd.getDay() + 6) % 7])} ${dd.getDate()}`);
      for (const min of [0, 9 * 60 + 5, 23 * 60 + 55]) {
        // avvisi degli spostamenti su un altro giorno (index.jsx)
        const was = t(`${DOW_IT[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(min)}`, `${DOW_EN[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(min)}`);
        assert.equal(dayTimeLabel(iso, min, t), was);
        // «Spostato a …» ora si compone con il testo del giorno
        const when = dayTimeLabel(iso, min, t);
        assert.equal(t('Spostato a ' + when, 'Moved to ' + when),
          t(`Spostato a ${DOW_IT[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(min)}`, `Moved to ${DOW_EN[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(min)}`));
      }
    }
  }
  assert.equal(dayTimeLabel('2026-10-02', 15 * 60, tFor('it')), 'Ven 2, 15:00');
  assert.equal(dayTimeLabel('2026-10-02', 15 * 60, tFor('en')), 'Fri 2, 15:00');
});

test('slotStep: il passo delle Impostazioni, altrimenti 15', () => {
  for (const settings of [null, undefined, {}, { slot_interval_min: 0 }, { slot_interval_min: 30 }, { slot_interval_min: 5 }]) {
    assert.equal(slotStep(settings), settings?.slot_interval_min || 15);
  }
});

test('openApptIdOf: l\'appuntamento del pannello di dettaglio, solo quello', () => {
  assert.equal(openApptIdOf(null), null);
  assert.equal(openApptIdOf({ name: 'newappt', props: { appointment: { id: 4 } } }), null);
  assert.equal(openApptIdOf({ name: 'apptdetail', props: { appointment: { id: 4 } } }), 4);
  assert.equal(openApptIdOf({ name: 'apptdetail', props: {} }), null);
});

test('hoverPlacement: a destra se ci sta, mai troppo in basso', () => {
  const view = { innerWidth: 1400, innerHeight: 900 };
  const was = (r, clear) => {
    const right = r.right + 320 < view.innerWidth;
    return { x: right ? r.right + 10 : r.left - 10, y: Math.min(r.top, view.innerHeight - clear), side: right ? 'right' : 'left' };
  };
  const rects = [
    { left: 100, right: 260, top: 200 }, { left: 900, right: 1079, top: 800 }, { left: 900, right: 1080, top: 10 },
    { left: 1200, right: 1390, top: 700 },
  ];
  for (const r of rects) for (const clear of [260, 280]) assert.deepEqual(hoverPlacement(r, view, clear), was(r, clear));
  assert.deepEqual(hoverPlacement({ left: 1200, right: 1390, top: 700 }, view, 260), { x: 1190, y: 640, side: 'left' });
});

test('visibleMarks: rimpicciolendo restano solo le ore', () => {
  const marks = gridMarks(15, 9 * 60, 12 * 60);
  for (const pxm of [0.4 * 1.35, 0.65 * 1.35, 1.35, 2 * 1.35]) {
    assert.deepEqual(visibleMarks(marks, pxm),
      marks.filter(({ kind }) => (kind === 'hour') || (kind === 'half' && 30 * pxm > 12) || (kind === 'quarter' && 15 * pxm > 12)));
  }
  assert.deepEqual(visibleMarks(marks, 0.3).map((m) => m.kind), ['hour', 'hour', 'hour', 'hour']);
});

test('closedIntervals: il fuori turno dentro la fascia della griglia', () => {
  assert.deepEqual(closedIntervals([['09:00', '13:00'], ['14:00', '19:00']], 8 * 60, 20 * 60),
    [[8 * 60, 9 * 60], [13 * 60, 14 * 60], [19 * 60, 20 * 60]]);
  // turni fuori ordine e sovrapposti: si leggono ordinati
  assert.deepEqual(closedIntervals([['14:00', '19:00'], ['09:00', '15:00']], 9 * 60, 19 * 60), []);
  // niente turni: tutta la fascia
  assert.deepEqual(closedIntervals([], 8 * 60, 20 * 60), [[8 * 60, 20 * 60]]);
  assert.deepEqual(closedIntervals(undefined), [[8 * 60, 20 * 60]]);
  // un turno che esce dalla griglia non allarga niente
  assert.deepEqual(closedIntervals([['07:00', '21:00']], 8 * 60, 20 * 60), []);
  assert.equal(hmToMin('9:05'), 545);
});
