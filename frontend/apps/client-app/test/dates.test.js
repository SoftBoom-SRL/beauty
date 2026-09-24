// Giorni ed etichette di data dell'app cliente (lib/dates.js): «oggi», la
// striscia dei giorni e le date degli istanti si leggono sul calendario del
// SALONE, anche quando il telefono è in un altro fuso.
//
// Il fuso del dispositivo si fissa qui, prima di qualunque data: le differenze
// si vedono solo quando dispositivo e salone non sono d'accordo sul giorno.
// Tokyo è avanti di 16-17 ore su Los Angeles: per buona parte della giornata i
// due calendari dicono giorni diversi.
process.env.TZ = 'Asia/Tokyo';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isoAtMin, setSalonTz, todayStr, toDateStr } from '@youty/shared';
import { dayStripLabel, fmtDayMed, nextDays, relLabel } from '../src/lib/dates.js';

const tIt = (it) => it;
const tEn = (it, en) => en;

/** Il fuso del salone per la durata di una prova, poi di nuovo Roma. */
function inSalon(tz, fn) {
  setSalonTz(tz);
  try { fn(); } finally { setSalonTz('Europe/Rome'); }
}

/** 'AAAA-MM-GG' + n giorni, con l'aritmetica di UTC (nessun fuso di mezzo). */
function plusDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Il giorno di adesso in un fuso, letto con Intl e non con format.js. */
const dayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

test('la striscia dei giorni parte da oggi in salone, non da oggi sul telefono', () => {
  for (const tz of ['America/Los_Angeles', 'Europe/Rome', 'Pacific/Kiritimati']) {
    inSalon(tz, () => {
      const days = nextDays();
      assert.equal(days.length, 14);
      assert.equal(todayStr(), dayIn(tz));
      days.forEach((d, i) => {
        // Date a mezzanotte LOCALE: da qui in poi sono aritmetica di giorni.
        assert.equal(d.getHours(), 0);
        assert.equal(d.getMinutes(), 0);
        assert.equal(toDateStr(d), plusDays(dayIn(tz), i), `${tz}, giorno ${i}`);
      });
      assert.equal(nextDays(3).length, 3);
    });
  }
});

test('etichetta del chip: giorno della settimana abbreviato, con la maiuscola, e numero', () => {
  assert.deepEqual(dayStripLabel(new Date(2026, 10, 14), 'it'), { wd: 'Sab', num: '14' });
  assert.deepEqual(dayStripLabel(new Date(2026, 10, 14), 'en'), { wd: 'Sat', num: '14' });
  assert.deepEqual(dayStripLabel(new Date(2027, 0, 5), 'it'), { wd: 'Mar', num: '5' });
});

test('data media: una data pura resta quel giorno, un istante si legge in salone', () => {
  assert.equal(fmtDayMed('2026-11-14', 'it'), 'Sab 14 nov');
  assert.equal(fmtDayMed('2026-11-14', 'en'), 'Sat 14 Nov');
  assert.equal(fmtDayMed('2026-12-02', 'it'), 'Mer 2 dic');
  // Le 23:30 UTC del 14 sono già il 15 a Roma, ancora il 14 a Los Angeles.
  inSalon('Europe/Rome', () => {
    assert.equal(fmtDayMed('2026-11-14T23:30:00Z', 'it'), 'Dom 15 nov');
    assert.equal(fmtDayMed('2026-11-14T23:30:00Z', 'en'), 'Sun 15 Nov');
    assert.equal(fmtDayMed(new Date('2026-11-14T23:30:00Z'), 'it'), 'Dom 15 nov');
  });
  inSalon('America/Los_Angeles', () => {
    assert.equal(fmtDayMed('2026-11-14T23:30:00Z', 'it'), 'Sab 14 nov');
    assert.equal(fmtDayMed(new Date('2026-11-14T23:30:00Z'), 'en'), 'Sat 14 Nov');
  });
});

test('«Oggi», «Domani» e il giorno della settimana si contano sul calendario del salone', () => {
  for (const tz of ['America/Los_Angeles', 'Europe/Rome']) {
    inSalon(tz, () => {
      const today = todayStr();
      const at = (n, min) => isoAtMin(plusDays(today, n), min);
      // Le 23:00 di oggi in salone: a Tokyo è spesso già domani.
      assert.equal(relLabel(at(0, 23 * 60), 'it', tIt), 'Oggi alle 23:00');
      assert.equal(relLabel(at(0, 23 * 60), 'en', tEn), 'Today at 23:00');
      assert.equal(relLabel(at(1, 600), 'it', tIt), 'Domani alle 10:00');
      assert.equal(relLabel(at(1, 600), 'en', tEn), 'Tomorrow at 10:00');
      // Da 2 a 6 giorni: il nome del giorno per intero, nel fuso del salone.
      for (const n of [2, 3, 6]) {
        const iso = at(n, 555);
        const long = (lang) => {
          const wd = new Date(plusDays(today, n) + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'long', timeZone: 'UTC' });
          return wd.charAt(0).toUpperCase() + wd.slice(1);
        };
        assert.equal(relLabel(iso, 'it', tIt), long('it') + ' alle 09:15', `${tz} +${n}`);
        assert.equal(relLabel(iso, 'en', tEn), long('en') + ' at 09:15', `${tz} +${n}`);
      }
      // Da una settimana in poi, e per il passato: data media · ora.
      for (const n of [7, 10, -1]) {
        const iso = at(n, 600);
        assert.equal(relLabel(iso, 'it', tIt), fmtDayMed(iso, 'it') + ' · 10:00', `${tz} ${n}`);
        assert.equal(relLabel(iso, 'en', tEn), fmtDayMed(iso, 'en') + ' · 10:00', `${tz} ${n}`);
      }
    });
  }
});
