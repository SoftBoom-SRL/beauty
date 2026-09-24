// useOtpFlow (src/hooks/useOtpFlow.js): il codice via SMS di accesso e
// prenotazione. Gli stessi rifiuti con gli stessi messaggi nei due posti; gli
// altri errori sotto il campo nell'accesso (il messaggio del server, o
// «Errore di rete» se una risposta non è arrivata) e nel toast nella
// prenotazione.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, apiErrorText, toastApiError } from '@youty/shared';
import { loadModule, renderHook } from './load.mjs';

// La classe vera di ApiError, il testo e il toast veri, condivisi col modulo
// impacchettato: il modulo li riconosce con `instanceof` e li chiama come
// nell'app.
globalThis.__otp = { ApiError, apiErrorText, toastApiError, calls: [], next: [] };
const SHARED = `
const O = globalThis.__otp;
export const ApiError = O.ApiError;
export const apiErrorText = O.apiErrorText;
export const toastApiError = O.toastApiError;
export const SALON_SLUG = 'the-parlour';
const call = (name) => async (...args) => {
  O.calls.push([name, ...args]);
  const res = O.next.shift();
  if (res instanceof Error) throw res;
  return res;
};
export const clientAuth = { requestOtp: call('requestOtp'), register: call('register'), verifyOtp: call('verifyOtp') };
`;
const { useOtpFlow } = await loadModule('src/hooks/useOtpFlow.js', { react: true, shared: SHARED });

const t = (it) => it;
const tEn = (it, en) => en;
const O = globalThis.__otp;
function answer(...res) { O.calls.length = 0; O.next = res; }

/** L'hook nei due modi: accesso (errori sotto il campo) e prenotazione (toast). */
function flow(mode, phone = ' 333 884 1120 ', tr = t) {
  const toasts = [];
  const h = renderHook((p) => useOtpFlow({ phone: p, t: tr, fireToast: (o) => toasts.push(o), otherErrors: mode }), phone);
  return { h, toasts };
}

test('richiesta del codice: col numero senza spazi ai bordi, 429 = troppi codici', async () => {
  for (const mode of ['inline', 'toast']) {
    const { h, toasts } = flow(mode);
    answer({ ok: true });
    assert.equal(await h.result.request(), true);
    assert.deepEqual(O.calls, [['requestOtp', 'the-parlour', '333 884 1120']]);
    answer(new ApiError(429, 'Troppe richieste'));
    assert.equal(await h.result.request(), false);
    h.render();
    assert.equal(h.result.error, 'Troppi codici richiesti. Riprova tra qualche minuto.');
    assert.deepEqual(toasts, []);
  }
  const { h } = flow('inline', '333', tEn);
  answer(new ApiError(429, 'x'));
  await h.result.request();
  h.render();
  assert.equal(h.result.error, 'Too many codes requested. Try again in a few minutes.');
});

test('verifica: 400 = codice non valido, 429 = troppi tentativi, altrimenti la sessione', async () => {
  for (const mode of ['inline', 'toast']) {
    const { h, toasts } = flow(mode);
    answer({ access: 'jwt' });
    assert.equal(await h.result.verify('123456'), true);
    assert.deepEqual(O.calls, [['verifyOtp', 'the-parlour', '333 884 1120', '123456']]);
    answer(new ApiError(400, 'Codice non valido o scaduto'));
    assert.equal(await h.result.verify('000000'), false);
    h.render();
    assert.equal(h.result.error, 'Codice non valido o scaduto');
    answer(new ApiError(429, 'x'));
    await h.result.verify('000000');
    h.render();
    assert.equal(h.result.error, 'Troppi tentativi. Riprova tra qualche minuto.');
    assert.deepEqual(toasts, []);
  }
});

test('registrazione: il salone aggiunto in testa, 400 = numero già in anagrafica', async () => {
  const { h, toasts } = flow('toast');
  const fields = { first_name: 'Giada', last_name: 'Bellini', phone: '333 884 1120', lang: 'it' };
  answer(new ApiError(400, 'Numero di telefono già registrato'));
  assert.equal(await h.result.register(fields), 'blocked');
  h.render();
  assert.equal(h.result.error, null);
  assert.deepEqual(toasts, []);
  assert.equal(h.result.codeSurelySent, false);
  answer({ ok: true });
  assert.equal(await h.result.register(fields), 'ok');
  // stesso corpo di prima, chiavi nello stesso ordine
  assert.equal(JSON.stringify(O.calls), JSON.stringify([['register', { salon_slug: 'the-parlour', ...fields }]]));
  h.render();
  // solo dopo la registrazione il codice è partito di sicuro, e solo per quel numero
  assert.equal(h.result.codeSurelySent, true);
  h.render(' 333 884 1120');
  assert.equal(h.result.codeSurelySent, true);
  h.render('333 884 1121');
  assert.equal(h.result.codeSurelySent, false);
});

test('gli altri errori: nell\'accesso sotto il campo, nella prenotazione nel toast', async () => {
  const boom = new ApiError(500, 'Servizio non disponibile');
  const offline = new TypeError('Failed to fetch');
  const cases = [
    ['request', []], ['register', [{ first_name: 'A', last_name: 'B', phone: '1', lang: 'it' }]], ['verify', ['123456']],
  ];
  for (const [fn, args] of cases) {
    const inl = flow('inline');
    answer(boom);
    await inl.h.result[fn](...args);
    inl.h.render();
    assert.equal(inl.h.result.error, 'Servizio non disponibile', fn);
    // senza rete «Errore di rete», nella lingua dell'app: il messaggio
    // dell'errore era quello del browser, «Failed to fetch» (voce 31)
    answer(offline);
    await inl.h.result[fn](...args);
    inl.h.render();
    assert.equal(inl.h.result.error, 'Errore di rete', fn);
    const en = flow('inline', ' 333 884 1120 ', tEn);
    answer(offline);
    await en.h.result[fn](...args);
    en.h.render();
    assert.equal(en.h.result.error, 'Network error', fn);
    // una risposta senza messaggio: anche lei «Errore di rete», come prima
    answer(new ApiError(502, ''));
    await inl.h.result[fn](...args);
    inl.h.render();
    assert.equal(inl.h.result.error, 'Errore di rete', fn);
    assert.deepEqual(inl.toasts, []);

    const tst = flow('toast');
    answer(boom);
    await tst.h.result[fn](...args);
    answer(offline);
    await tst.h.result[fn](...args);
    tst.h.render();
    assert.equal(tst.h.result.error, null, fn);
    assert.deepEqual(tst.toasts, [
      { msg: 'Servizio non disponibile', icon: 'alert' },
      { msg: 'Errore di rete', icon: 'alert' },
    ], fn);
  }
});
