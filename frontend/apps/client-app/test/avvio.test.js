// L'avvio dell'app cliente (ctx.jsx, AppProvider): il branding del salone.
// Il provider vero col React finto di test/load.mjs e un '@youty/shared' finto
// (lingua, toast e sessione finti; il testo e la classe degli errori veri);
// le chiamate vanno all'API finta di test/fake-app.mjs e rispondono quando lo
// dice la prova. Si guarda il valore del contesto (`brandError`), che App.jsx
// scrive sotto «Impossibile caricare il salone».
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fail, lost, net, pending } from './fake-app.mjs';
import { loadModule, renderHook } from './load.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'shared', 'src');
const L = (globalThis.__bootLang = { lang: 'it' });
const SHARED = `
import * as apiErrors from ${JSON.stringify(join(PKG, 'apiErrors.js'))};
// la stessa classe degli errori che costruiscono fail() e gli schermi di fake-app.mjs
const E = globalThis.__fakeApiErrors || (globalThis.__fakeApiErrors = apiErrors);
export const { ApiError, apiErrorText, toastApiError } = E;
const N = globalThis.__net;
N.ApiError = E.ApiError;
const L = globalThis.__bootLang;
// t e setLang stabili come quelli veri (t cambia solo con la lingua)
const T = { it: (it) => it, en: (it, en) => en };
const setLang = (l) => { L.lang = l; };
export const useT = () => ({ t: T[L.lang], lang: L.lang, setLang });
export const useToastHost = () => ({ fireToast: () => {}, toastProps: {} });
export const storedLang = () => null;
export const setSalonTz = () => {};
export const mediaUrl = (p) => p;
export const SALON_SLUG = 'the-parlour';
export const clientAuth = { getSession: () => null, subscribe: () => () => {}, logout: () => {} };
export const api = { get: (path, ...args) => N.call('get', path, args) };
`;
const { AppProvider } = await loadModule('src/ctx.jsx', { shared: SHARED, react: true });

const BRANDING = '/api/core/public/branding';
/** Il valore che il provider mette nel contesto. */
const value = (h) => h.result.props.value;

test('salone che non si carica senza rete: «Errore di rete» nella lingua dell\'app (voce 31)', async () => {
  for (const [lang, want] of [['it', 'Errore di rete'], ['en', 'Network error']]) {
    net.log.length = 0;
    L.lang = lang;
    const h = renderHook(AppProvider, { children: null });
    try {
      assert.equal(value(h).brandError, null);
      // fetch senza rete rifiuta con il testo del browser: «Failed to fetch»
      await lost(pending('get', BRANDING)[0]);
      h.render();
      assert.equal(value(h).brandError, want);
      assert.equal(value(h).brand, null);
    } finally { h.unmount(); }
  }
});

test('salone che non si carica per una risposta del server: il suo messaggio; «Riprova» lo toglie', async () => {
  net.log.length = 0;
  L.lang = 'it';
  const h = renderHook(AppProvider, { children: null });
  try {
    await fail(pending('get', BRANDING)[0], 404, 'Salone non trovato');
    h.render();
    assert.equal(value(h).brandError, 'Salone non trovato');
    value(h).reloadBrand();
    h.render();
    assert.equal(value(h).brandError, null);
    assert.equal(pending('get', BRANDING).length, 2);
  } finally { h.unmount(); }
});
