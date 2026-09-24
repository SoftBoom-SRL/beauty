// I testi degli avvisi dopo un gesto (lib/toastText.js), confrontati con le
// espressioni che sostituiscono, copiate com'erano dai gesti, in italiano e in
// inglese: spostamento (stesso giorno, altro giorno, a un'altra operatrice),
// stacco, pausa, ripristino, settimana, pannello, «torna indietro».
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fmtDateIt, parseISO, timeLabel } from '@youty/shared';
import { DOW_EN, DOW_IT, firstName } from '../src/sections/agenda/lib.js';
import {
  breakAddedText, movedText, nothingToUndoText, panelMovedText, pauseMovedText, restoredText, splitText, undoneText,
  weekMovedText,
} from '../src/sections/agenda/lib/toastText.js';

const LANGS = ['it', 'en'];
const tFor = (lang) => (it, en) => (lang === 'en' ? (en ?? it) : it);   // come makeT
const DATE = '2026-10-02';   // venerdì
const dd = parseISO(DATE);
// «Ven 2, 10:00», com'era scritto nei gesti prima di dayTimeLabel
const dayTime = (t, min) => t(`${DOW_IT[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(min)}`, `${DOW_EN[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(min)}`);

test('spostamento in vista giorno: stesso giorno, altro giorno, altra operatrice', () => {
  for (const lang of LANGS) {
    const t = tFor(lang);
    for (const otherDay of [false, true]) {
      for (const reassigned of [false, true]) {
        const startMin = 10 * 60 + 15, opName = 'Giulia';
        const when = otherDay ? dayTime(t, startMin) : timeLabel(startMin);
        const was = reassigned
          ? t(`Spostato a ${opName}, ${when}`, `Moved to ${opName}, ${when}`)
          : otherDay
            ? t('Spostato a ' + when, 'Moved to ' + when)
            : t('Spostato alle ' + when, 'Moved to ' + when);
        assert.equal(movedText(t, { opName, reassigned, otherDay, date: DATE, startMin }), was);
      }
    }
    // il rilascio su un giorno della striscia, com'era scritto in moveApptToDate
    assert.equal(movedText(t, { reassigned: false, otherDay: true, date: DATE, startMin: 900 }),
      t(`Spostato a ${DOW_IT[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(900)}`, `Moved to ${DOW_EN[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(900)}`));
  }
  assert.equal(movedText(tFor('it'), { reassigned: false, otherDay: false, date: DATE, startMin: 600 }), 'Spostato alle 10:00');
  assert.equal(movedText(tFor('en'), { opName: 'Bea', reassigned: true, otherDay: true, date: DATE, startMin: 600 }), 'Moved to Bea, Fri 2, 10:00');
});

test('stacco, pause e ripristino', () => {
  for (const lang of LANGS) {
    const t = tFor(lang);
    for (const otherDay of [false, true]) {
      const when = otherDay ? dayTime(t, 690) : timeLabel(690);
      assert.equal(splitText(t, 'Piega', { otherDay, date: DATE, startMin: 690 }), t(`Piega staccato alle ${when}`, `Piega detached at ${when}`));
    }
    assert.equal(pauseMovedText(t, 780), t('Pausa spostata alle ' + timeLabel(780), 'Break moved to ' + timeLabel(780)));
    for (const first of ['Anna', undefined]) {
      assert.equal(breakAddedText(t, first, 780), t(`Pausa aggiunta · ${firstName(first)} alle ${timeLabel(780)}`, `Break added · ${firstName(first)} at ${timeLabel(780)}`));
    }
    for (const name of ['Maria Russo', undefined]) {
      assert.equal(restoredText(t, name), t(`Appuntamento di ${firstName(name)} ripristinato`, `${firstName(name)}'s appointment restored`));
    }
  }
  assert.equal(breakAddedText(tFor('it'), undefined, 780), 'Pausa aggiunta ·  alle 13:00');
});

test('settimana e pannello di dettaglio', () => {
  for (const lang of LANGS) {
    const t = tFor(lang);
    assert.equal(weekMovedText(t, 'Gio 1 · Anna · 16:00'), t('Spostato · ', 'Moved · ') + 'Gio 1 · Anna · 16:00');
    for (const [day, baseDate] of [[DATE, DATE], [DATE, '2026-10-01']]) {
      for (const who of [{ first_name: 'Bea' }, undefined]) {
        for (const reassigned of [false, true]) {
          const target = 11 * 60;
          const when = day === baseDate ? timeLabel(target) : `${fmtDateIt(day)} · ${timeLabel(target)}`;
          const was = reassigned
            ? t(`Passato a ${who?.first_name || ''}, ${when}`, `Moved to ${who?.first_name || ''}, ${when}`)
            : t(`Spostato · ${when}`, `Moved · ${when}`);
          assert.equal(panelMovedText(t, { reassigned, who, day, baseDate, target }), was);
        }
      }
    }
  }
  assert.equal(panelMovedText(tFor('it'), { reassigned: false, day: DATE, baseDate: '2026-10-01', target: 660 }), 'Spostato · Venerdì 2 ottobre · 11:00');
});

test('«torna indietro»', () => {
  for (const lang of LANGS) {
    const t = tFor(lang);
    assert.equal(undoneText(t, 'Spostamento di Sara'), t('Annullato · Spostamento di Sara', 'Undone · Spostamento di Sara'));
    assert.equal(nothingToUndoText(t), t('Non c\'è più niente da annullare', 'Nothing left to undo'));
  }
});
