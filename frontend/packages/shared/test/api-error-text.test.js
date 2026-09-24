// apiErrorText e toastApiError: il testo e il toast d'errore che le sezioni
// scrivevano a mano in ogni catch. Si confrontano con le copie che devono
// sostituire, riportate com'erano (4ecefc8), su ogni tipo di errore: prenderne
// il posto non deve cambiare né il testo, né la forma del toast, né quando si
// chiama t().
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, apiErrorText, toastApiError } from '../src/apiErrors.js';

const makeT = (lang) => (it, en) => (lang === 'en' ? en : it);

/* ---- le copie che questi aiuti hanno sostituito (refactoring del 24/09) ---- */
// magazzino/lib.js (errMsg)
const errMsg = (err, t) =>
  err instanceof ApiError ? err.message : t('Errore di rete', 'Network error');
// impostazioni/lib.jsx (toastErr) = client-app screens/lib.jsx (errToast);
// agenda/lib.js ha lo stesso corpo con (err, t, fireToast)
function toastErr(err, fireToast, t) {
  if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' });
  else fireToast({ msg: t('Errore di rete', 'Network error'), icon: 'alert' });
}
// la forma in linea dei catch (e delle chiusure toastErr di StaffPage,
// ClientProfile, NoteBits)
const inline = (err, fireToast, t) =>
  fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });

const ERRORS = [
  new ApiError(409, 'Orario non più disponibile', { detail: 'Orario non più disponibile' }),
  new ApiError(422, 'Motivo: al massimo 255 caratteri', { detail: [] }),
  new ApiError(500, ''),               // messaggio vuoto: resta vuoto, non diventa «Errore di rete»
  new TypeError('Failed to fetch'),    // rete giù: fetch rifiuta con un TypeError
  new Error('boom'),
  { name: 'ApiError', message: 'finto' },  // somiglia a un ApiError ma non lo è
  'testo', undefined, null,
];

/** Esegue `fn(fireToast, t)` e registra le chiamate a fireToast e a t. */
function run(fn, lang) {
  const toasts = [];
  const tCalls = [];
  const t = (it, en) => { tCalls.push([it, en]); return makeT(lang)(it, en); };
  const ret = fn((o) => { toasts.push(o); }, t);
  return { ret, toasts, tCalls };
}

test('ApiError: status, messaggio e corpo della risposta', () => {
  const e = new ApiError(404, 'Non trovato', { detail: 'Non trovato' });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ApiError');
  assert.equal(e.status, 404);
  assert.equal(e.message, 'Non trovato');
  assert.deepEqual(e.data, { detail: 'Non trovato' });
  assert.equal(new ApiError(500, 'x').data, undefined);
});

test('apiErrorText: il messaggio del server per un ApiError, «Errore di rete» per il resto', () => {
  assert.equal(apiErrorText(ERRORS[0], makeT('it')), 'Orario non più disponibile');
  assert.equal(apiErrorText(new TypeError('Failed to fetch'), makeT('it')), 'Errore di rete');
  assert.equal(apiErrorText(null, makeT('en')), 'Network error');
  assert.equal(apiErrorText(new ApiError(500, ''), makeT('it')), '');
});

test('apiErrorText si comporta come la copia di magazzino, anche nelle chiamate a t()', () => {
  for (const lang of ['it', 'en']) {
    for (const err of ERRORS) {
      const a = run((_, t) => apiErrorText(err, t), lang);
      const b = run((_, t) => errMsg(err, t), lang);
      assert.deepEqual(a, b, `${lang} ${String(err?.message ?? err)}`);
    }
  }
});

test('toastApiError è il toastErr delle Impostazioni e l\'errToast dell\'app clienti', () => {
  for (const lang of ['it', 'en']) {
    for (const err of ERRORS) {
      const got = run((fireToast, t) => toastApiError(err, fireToast, t), lang);
      assert.deepEqual(got, run((fireToast, t) => toastErr(err, fireToast, t), lang));
      assert.deepEqual(got, run((fireToast, t) => inline(err, fireToast, t), lang));
      // un solo toast, con l'icona d'allarme e niente altro
      assert.equal(got.toasts.length, 1);
      assert.deepEqual(Object.keys(got.toasts[0]), ['msg', 'icon']);
      assert.equal(got.ret, undefined);
    }
  }
});

test('t() si chiama solo quando serve il testo di riserva', () => {
  assert.equal(run((fireToast, t) => toastApiError(ERRORS[0], fireToast, t), 'it').tCalls.length, 0);
  assert.deepEqual(run((fireToast, t) => toastApiError(new Error('x'), fireToast, t), 'it').tCalls,
    [['Errore di rete', 'Network error']]);
});
