// labels.js. nameIn: il nome di servizi, categorie e pacchetti nella lingua
// dell'interfaccia; si confronta con le copie che deve sostituire, riportate
// com'erano (4ecefc8), anche sugli oggetti a metà (inglese vuoto, italiano
// mancante): prenderne il posto non deve cambiare cosa si legge a video.
// Mesi e giorni: le stesse tabelle che le sezioni si erano scritte.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  nameIn,
  MONTHS_LONG_IT, MONTHS_LONG_EN, MONTHS_SHORT_IT, MONTHS_SHORT_EN, WEEKDAYS_SHORT_IT, WEEKDAYS_SHORT_EN,
} from '../src/labels.js';
import { parseISO, salonDateParts, setSalonTz } from '../src/format.js';

/* ---- le copie di oggi ---- */
// pos/lib.js svcLabel, servizi (PacchettiSub, PkgEditModal, ServiziSub svcName),
// fedelta/modals/GiftCardModal, StaffPage catLabel, agenda GroupBookingDrawer svcName
const formA = (s, lang) => (lang === 'en' && s.name_en ? s.name_en : s.name_it);
// staff/lib.js svcLabel, fedelta/modals/LoyaltyEditModal svcName
const formB = (s, lang) => (lang === 'en' ? (s.name_en || s.name_it) : s.name_it);
// app clienti svcLangName; servizi ServiziSub e SvcEditModal catName
function svcLangName(obj, lang) {
  if (!obj) return '';
  return (lang === 'en' && obj.name_en) ? obj.name_en : obj.name_it;
}
// agenda NewApptModal svcName: diversa (vedi l'ultimo test)
const newApptSvcName = (s, lang) => (lang === 'en' && s?.name_en ? s.name_en : s?.name_it || '');

const OBJS = [
  { name_it: 'Piega', name_en: 'Blow-dry' },
  { name_it: 'Piega', name_en: '' },
  { name_it: 'Piega', name_en: null },
  { name_it: 'Piega' },
  { name_it: '', name_en: 'Blow-dry' },
  { name_en: 'Blow-dry' },
  { name_it: null, name_en: '' },
  {},
];
const LANGS = ['it', 'en', undefined, 'EN', 'fr'];

test('nameIn: l\'inglese se c\'è, altrimenti l\'italiano', () => {
  const s = { name_it: 'Piega', name_en: 'Blow-dry' };
  assert.equal(nameIn(s, 'it'), 'Piega');
  assert.equal(nameIn(s, 'en'), 'Blow-dry');
  assert.equal(nameIn({ name_it: 'Piega', name_en: '' }, 'en'), 'Piega');
  assert.equal(nameIn({ name_en: 'Blow-dry' }, 'it'), undefined);
});

test('nameIn scrive come le due forme delle copie di oggi', () => {
  for (const lang of LANGS) {
    for (const s of OBJS) {
      assert.equal(nameIn(s, lang), formA(s, lang), `${lang} ${JSON.stringify(s)}`);
      assert.equal(nameIn(s, lang), formB(s, lang), `${lang} ${JSON.stringify(s)}`);
    }
  }
});

test('senza oggetto è un TypeError, come nelle copie', () => {
  for (const lang of ['it', 'en']) {
    for (const s of [null, undefined]) {
      assert.throws(() => nameIn(s, lang), TypeError);
      assert.throws(() => formA(s, lang), TypeError);
    }
  }
});

test('`obj ? nameIn(obj, lang) : \'\'` è svcLangName dell\'app clienti', () => {
  for (const lang of LANGS) {
    for (const s of [...OBJS, null, undefined]) {
      assert.equal(s ? nameIn(s, lang) : '', svcLangName(s, lang), `${lang} ${JSON.stringify(s)}`);
    }
  }
});

test('non sostituisce svcName della nuova prenotazione: lì l\'italiano mancante è \'\'', () => {
  assert.equal(newApptSvcName({ name_en: 'Blow-dry' }, 'it'), '');
  assert.equal(nameIn({ name_en: 'Blow-dry' }, 'it'), undefined);
});

/* ---- mesi e giorni: le tabelle di oggi ---- */
// agenda/lib.js e staff/lib.js (MONTHS_IT, MONTHS_EN; l'inglese anche in clienti/helpers.js)
const LONG_IT = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const LONG_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// comunicazioni/helpers.js, pos/lib.js (saleDateLabel), impostazioni/dates.js, clienti/helpers.js (MONTHS_SHORT)
const SHORT_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const SHORT_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// agenda/lib.js (DOW_IT, DOW_EN), staff/lib.js (WEEKDAYS), staff/AbsenceCalendar.jsx,
// insight/Charts.jsx, app clienti (WEEKDAYS_SHORT, prime due colonne)
const DOW_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

test('mesi e giorni sono le tabelle che le sezioni si erano scritte', () => {
  assert.deepEqual([...MONTHS_LONG_IT], LONG_IT);
  assert.deepEqual([...MONTHS_LONG_EN], LONG_EN);
  assert.deepEqual([...MONTHS_SHORT_IT], SHORT_IT);
  assert.deepEqual([...MONTHS_SHORT_EN], SHORT_EN);
  assert.deepEqual([...WEEKDAYS_SHORT_IT], DOW_IT);
  assert.deepEqual([...WEEKDAYS_SHORT_EN], DOW_EN);
});

test('le tabelle condivise non si possono modificare', () => {
  for (const tab of [MONTHS_LONG_IT, MONTHS_LONG_EN, MONTHS_SHORT_IT, MONTHS_SHORT_EN, WEEKDAYS_SHORT_IT, WEEKDAYS_SHORT_EN]) {
    assert.ok(Object.isFrozen(tab));
    assert.throws(() => { tab[0] = 'x'; }, TypeError);
    assert.throws(() => tab.push('x'), TypeError);
  }
  assert.equal(MONTHS_LONG_IT[0], 'Gennaio');
});

test('mese 0 = gennaio, giorno 0 = lunedì', () => {
  setSalonTz('Europe/Rome');
  const p = salonDateParts('2026-09-03T08:00:00Z');
  assert.equal(`${p.day} ${MONTHS_SHORT_IT[p.month - 1]} ${p.year}`, '3 set 2026');
  assert.equal(MONTHS_LONG_EN[parseISO('2026-12-01').getMonth()], 'December');
  const monday = parseISO('2026-09-21');
  assert.equal(WEEKDAYS_SHORT_IT[(monday.getDay() + 6) % 7], 'Lun');
  assert.equal(WEEKDAYS_SHORT_EN[(parseISO('2026-09-27').getDay() + 6) % 7], 'Sun');
});
