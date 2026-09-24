// nameIn: il nome di servizi, categorie e pacchetti nella lingua
// dell'interfaccia. Si confronta con le copie che deve sostituire, riportate
// com'erano (4ecefc8), anche sugli oggetti a metà (inglese vuoto, italiano
// mancante): prenderne il posto non deve cambiare cosa si legge a video.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nameIn } from '../src/labels.js';

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
