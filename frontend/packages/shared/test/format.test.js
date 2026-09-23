// Test di regressione sul fuso: gli orari sono quelli del SALONE, non quelli
// del dispositivo. Si esegue con `npm test` (node --test, nessuna dipendenza).
// Il caso: un portatile in America o un telefono in Giappone mostravano
// l'appuntamento a un'ora che non era quella a cui la cliente è attesa.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fmtEur, fmtTime, isoAtMin, minutesOfDay, nowMinutes, setSalonTz,
  parseISO, timeLabel, todayStr, toDateStr, toDateTimeLocal, dateTimeLocalToIso,
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

/* «Adesso» non si può fissare a un valore atteso, ma si può confrontare con un
 * orologio indipendente: Intl legge l'ora in un fuso QUALUNQUE, senza dipendere
 * da quello della macchina che esegue i test — che qui è lo stesso del salone
 * predefinito, e quindi da solo non distingue niente. I fusi scelti hanno tutti
 * uno scarto diverso (e uno è a mezz'ora), così nessuna macchina può passare il
 * test per caso. L'asserzione precedente — «è un numero fra 0 e 1439» — la
 * superava qualunque implementazione, compresa una che ignora il salone. */
const ELSEWHERE = ['Pacific/Kiritimati', 'Pacific/Honolulu', 'Asia/Kolkata', 'Europe/Rome'];

function clockAt(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return (get('hour') % 24) * 60 + get('minute');
}

test('nowMinutes segue l\'orologio del salone, non quello della macchina', () => {
  for (const tz of ELSEWHERE) {
    setSalonTz(tz);
    // Due letture consecutive: l'unica differenza ammessa è lo scatto del
    // minuto fra la funzione e l'orologio di controllo.
    const ok = nowMinutes() === clockAt(tz) || nowMinutes() === clockAt(tz);
    assert.ok(ok, `nowMinutes() non è l'ora di ${tz}`);
  }
  setSalonTz('Europe/Rome');
});

test('todayStr è il giorno del salone, non quello della macchina', () => {
  const dayAt = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  // A Kiritimati (+14) e alle Hawaii (-10) la data è diversa per 24 ore su 24:
  // se todayStr guardasse il calendario della macchina, almeno una fallirebbe.
  setSalonTz('Pacific/Kiritimati');
  assert.equal(todayStr(), dayAt('Pacific/Kiritimati'));
  setSalonTz('Pacific/Honolulu');
  assert.equal(todayStr(), dayAt('Pacific/Honolulu'));
  setSalonTz('Europe/Rome');
  assert.equal(todayStr(), dayAt('Europe/Rome'));
});

/* ---------------- denaro ----------------
 * fmtEur non aveva un solo test, e intanto perdeva i centesimi: «35,5» sul
 * carrello, «8,415» su un prezzo scontato. Gli importi arrivano dall'API come
 * stringhe decimali, quindi anche quelle vanno lette come numeri. */

test('gli importi hanno sempre due decimali', () => {
  assert.equal(fmtEur(35.5), '€35,50');
  assert.equal(fmtEur(12.3), '€12,30');
  assert.equal(fmtEur(49), '€49,00');
  assert.equal(fmtEur(35.5, 'en'), '€35.50');
});

test('i decimali di troppo vengono arrotondati, non stampati', () => {
  // 9,90 meno il 15% di sconto fornitore: a video usciva «€8,415», mentre lo
  // stesso ordine stampato diceva 8,42 €.
  assert.equal(fmtEur(9.9 * 0.85), '€8,42');
  assert.equal(fmtEur(9.999), '€10,00');
});

test('le stringhe decimali dell\'API valgono come i numeri', () => {
  assert.equal(fmtEur('35.50'), fmtEur(35.5));
  assert.equal(fmtEur('12.3'), '€12,30');
});

test('lo zero è lo zero, comunque sia scritto', () => {
  // «0.00» non era === 0: la stessa cifra si leggeva «Gratis» oppure «€0,00»
  // a seconda di chi la passava.
  assert.equal(fmtEur(0), 'Gratis');
  assert.equal(fmtEur('0.00'), 'Gratis');
  assert.equal(fmtEur(0, 'en'), 'Free');
  assert.equal(fmtEur('0.00', 'en'), 'Free');
});
