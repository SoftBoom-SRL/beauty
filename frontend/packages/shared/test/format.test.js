// Test di regressione sul fuso: gli orari sono quelli del SALONE, non quelli
// del dispositivo. Si esegue con `npm test` (node --test, nessuna dipendenza).
// Il caso: un portatile in America o un telefono in Giappone mostravano
// l'appuntamento a un'ora che non era quella a cui la cliente è attesa.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fmtTime, isoAtMin, minutesOfDay, nowMinutes, setSalonTz,
  parseISO, timeLabel, toDateStr, toDateTimeLocal, dateTimeLocalToIso,
} from '../src/format.js';

const APPT = '2026-09-24T10:00:00+02:00';  // le 10:00 a Roma

test('l\'ora dell\'appuntamento non dipende dal fuso del dispositivo', () => {
  assert.equal(timeLabel(minutesOfDay(APPT)), '10:00');
  assert.equal(fmtTime(APPT), '10:00');
  assert.equal(toDateStr(APPT), '2026-09-24');
});

test('lo slot scelto viene costruito sull\'orologio del salone', () => {
  assert.equal(isoAtMin('2026-09-24', 600), '2026-09-24T08:00:00.000Z');
  // ora legale: a gennaio lo stesso orario è un\'ora più indietro rispetto a UTC
  assert.equal(isoAtMin('2026-01-14', 600), '2026-01-14T09:00:00.000Z');
});

test('andata e ritorno del campo datetime-local', () => {
  assert.equal(toDateTimeLocal(APPT), '2026-09-24T10:00');
  assert.equal(dateTimeLocalToIso('2026-09-24T10:00'), '2026-09-24T08:00:00.000Z');
});

test('una data pura resta il giorno che è', () => {
  assert.equal(toDateStr('2026-09-24'), '2026-09-24');
  assert.equal(minutesOfDay('2026-09-24'), 0);
});

test('l\'aritmetica dei giorni non viene spostata dal fuso', () => {
  // Un Date costruito a mano è mezzanotte LOCALE: convertirlo nel fuso del
  // salone farebbe tornare indietro di un giorno ogni dispositivo più avanti
  // (Tokyo, Sydney), e la vista mese partirebbe dal giorno sbagliato.
  assert.equal(toDateStr(new Date(2026, 8, 24)), '2026-09-24');
  assert.equal(toDateStr(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(toDateStr(parseISO('2026-09-24')), '2026-09-24');
});

test('un altro fuso del salone sposta gli orari, non il dispositivo', () => {
  setSalonTz('America/New_York');
  assert.equal(fmtTime(APPT), '04:00');
  assert.equal(isoAtMin('2026-09-24', 600), '2026-09-24T14:00:00.000Z');
  setSalonTz('Europe/Rome');
  assert.equal(fmtTime(APPT), '10:00');
});

test('un fuso sconosciuto non rompe niente', () => {
  setSalonTz('Pianeta/Marte');
  assert.equal(fmtTime(APPT), '10:00');
});

test('adesso è un orario plausibile', () => {
  const m = nowMinutes();
  assert.ok(Number.isInteger(m) && m >= 0 && m < 1440);
});
