// fmtEurNoFree e fmtEurOrZero: gli importi dove lo zero è «€0» e non il
// «Gratis» dei listini. Si confrontano con le copie che devono sostituire,
// riportate com'erano (4ecefc8), su numeri, stringhe decimali dell'API e
// valori che numeri non sono: prenderne il posto non deve cambiare una cifra.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fmtEur, fmtEurNoFree, fmtEurOrZero } from '../src/format.js';

/* ---- le copie di oggi ---- */
// staff/lib.js (eur)
function staffEur(v, lang) {
  const n = Number(v) || 0;
  if (n === 0) return '€0';
  return '€' + n.toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// profile/index.jsx e insight/index.jsx (eur, con lang dalla chiusura)
const kpiEur = (n, lang) => {
  const v = Number(n) || 0;
  return v === 0 ? '€0' : fmtEur(v, lang);
};
// pos/lib.js (money) = eur0 di fedelta/GiftSub.jsx, insight/Charts.jsx,
// clienti/tabs/WalletTab.jsx, clienti/tabs/StoricoTab.jsx
const posMoney = (x, lang) => (Number(x) === 0 ? '€0' : fmtEur(Number(x), lang));

const VALUES = [
  0, -0, '0', '0.00', '', ' ', null, undefined, NaN, 'abc', '12,50', false, true, [], [7], {},
  35, '35.00', '35.5', 12.5, '8.415', 0.005, 0.004, 0.1 + 0.2, -3, '-3.10', 1234567.891, '1e3',
  Infinity, -Infinity,
];

test('fmtEurOrZero scrive come l\'eur di staff, profilo e insight', () => {
  for (const lang of ['it', 'en']) {
    for (const v of VALUES) {
      assert.equal(fmtEurOrZero(v, lang), staffEur(v, lang), `${lang} ${String(v)}`);
      assert.equal(fmtEurOrZero(v, lang), kpiEur(v, lang), `${lang} ${String(v)}`);
    }
  }
});

test('fmtEurNoFree scrive come il money del banco e gli eur0', () => {
  for (const lang of ['it', 'en']) {
    for (const v of VALUES) assert.equal(fmtEurNoFree(v, lang), posMoney(v, lang), `${lang} ${String(v)}`);
  }
});

test('lo zero è «€0», gli altri importi hanno i centesimi', () => {
  assert.equal(fmtEurOrZero('0.00', 'it'), '€0');
  assert.equal(fmtEurNoFree('0.00', 'en'), '€0');
  assert.equal(fmtEurOrZero('35.5', 'it'), '€35,50');
  assert.equal(fmtEurNoFree(1234.5, 'en'), '€1,234.50');
  assert.equal(fmtEur('0.00', 'it'), 'Gratis');   // i listini restano come sono
});

test('le due regole differiscono solo su ciò che non è un numero', () => {
  assert.equal(fmtEurOrZero(undefined, 'it'), '€0');
  assert.equal(fmtEurNoFree(undefined, 'it'), '€NaN');
  assert.equal(fmtEurOrZero('abc', 'en'), '€0');
  assert.equal(fmtEurNoFree('abc', 'en'), '€NaN');
  assert.equal(fmtEurNoFree(null, 'it'), '€0');   // Number(null) è 0
  for (const v of [0, '0.00', null, 12.5, '8.415', -3]) {
    assert.equal(fmtEurOrZero(v, 'it'), fmtEurNoFree(v, 'it'));
  }
});
