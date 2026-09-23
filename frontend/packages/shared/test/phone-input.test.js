// Caccia 22/09 — PhoneInput tasto per tasto (16-02).
//
// Il «+» battuto da solo veniva tolto come un carattere qualsiasi: chi
// scriveva il numero col prefisso otteneva «+39 39 333…» (o «+39 44 7911…»),
// numeri che passavano isPlausiblePhone. L'accesso falliva in silenzio e la
// registrazione creava una scheda fantasma. Lo stesso incollando «(+39) 333…»
// o «393331234567».
//
// Qui si simula il campo come lo usa PhoneInput: a ogni tasto il testo è
// quello mostrato più il carattere nuovo, readPhoneField decide bandiera e
// cifre, joinPhone il valore. Nessun DOM: la logica è tutta in phone.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatNational, joinPhone, readPhoneField } from '../src/phone.js';

function field(iso2 = 'IT') {
  const st = { iso2, raw: '', value: '' };
  const shown = () => (/^(\+|00)/.test(st.raw) ? st.raw : formatNational(st.iso2, st.raw));
  const input = (text) => {
    const r = readPhoneField(st.iso2, text);
    if (r.pending) { st.raw = r.pending; st.value = ''; return; }
    st.iso2 = r.iso2;
    st.raw = r.national;
    st.value = joinPhone(r.iso2, r.national);
  };
  const f = {
    type(keys) { for (const k of keys) input(shown() + k); return f; },
    paste(text) { input(shown() + text); return f; },
    get iso2() { return st.iso2; },
    get value() { return st.value; },
    get shown() { return shown(); },
  };
  return f;
}

test('«+39 333 1234567» battuto a mano non diventa +39 39 333…', () => {
  const f = field('IT').type('+39 333 1234567');
  assert.equal(f.value, '+393331234567');
  assert.equal(f.iso2, 'IT');
  assert.equal(f.shown, '333 123 4567');
});

test('«+44 7911 123456» battuto a mano è inglese, non +39 44…', () => {
  const f = field('IT').type('+44 7911 123456');
  assert.equal(f.value, '+447911123456');
  assert.equal(f.iso2, 'GB');
});

test('il «+» resta in campo finché il prefisso non si riconosce, come «00»', () => {
  const f = field('IT').type('+');
  assert.equal(f.shown, '+');
  assert.equal(f.value, '');
  f.type('4');
  assert.equal(f.shown, '+4');
  assert.equal(f.value, '');
  assert.equal(f.iso2, 'IT');
  f.type('4');
  assert.equal(f.iso2, 'GB');
  assert.equal(f.shown, '');

  const g = field('IT').type('00');
  assert.equal(g.shown, '00');
  assert.equal(g.value, '');
  g.type('39 06 1234567');
  assert.equal(g.value, '+39061234567');
});

test('il prefisso scritto insieme alle cifre (bandiera IT) si riconosce', () => {
  // Più di 11 cifre con un prefisso assegnato: come splitPhone e il backend.
  const it = field('IT').type('39 333 123 4567');
  assert.equal(it.value, '+393331234567');
  assert.equal(it.shown, '333 123 4567');
  const gb = field('IT').type('447911123456');
  assert.equal(gb.value, '+447911123456');
  assert.equal(gb.iso2, 'GB');
  // Un cellulare italiano che comincia per 33 (Francia) resta italiano.
  assert.equal(field('IT').type('333 123 4567').value, '+393331234567');
  // 12 cifre senza prefisso assegnato: italiano, come nel backend.
  assert.equal(field('IT').type('289012345678').value, '+39289012345678');
});

test('numeri incollati col prefisso', () => {
  assert.equal(field('IT').paste('(+39) 333 1234567').value, '+393331234567');
  assert.equal(field('IT').paste('393331234567').value, '+393331234567');
  const gb = field('IT').paste('+44 20 7946 0958');
  assert.equal(gb.value, '+442079460958');
  assert.equal(gb.shown, '207 946 0958');
});

test('prefissi fuori dal menu: bandiera 🌐 e numero intatto', () => {
  const unassigned = field('IT').type('+289 0123456');
  assert.equal(unassigned.iso2, '');
  assert.equal(unassigned.value, '+2890123456');
  const vatican = field('IT').type('+379 06 6981 2345');
  assert.equal(vatican.iso2, '');
  assert.equal(vatican.value, '+3790669812345');
});

test('lo 0 interurbano resta sotto le dita ma cade dal valore (uno solo)', () => {
  const gb = field('GB').type('07911 123456');
  assert.equal(gb.value, '+447911123456');
  assert.equal(gb.shown, '079 111 234 56');
  assert.equal(field('RO').type('0721 234 567').value, '+40721234567');
  // In Italia lo 0 fa parte del numero.
  assert.equal(field('IT').type('06 1234567').value, '+39061234567');
});
