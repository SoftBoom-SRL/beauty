// Il mondo finto in cui girano gli schermi dell'app cliente nei test: un
// '@youty/shared' con gli aiuti puri veri (format, labels, phone, apiErrors,
// ui/meta) e api/clientAuth finti, il contesto finto (useApp) e un'API che
// risponde quando lo dice la prova (ogni chiamata aspetta la sua risposta).
// Non è un file di test: lo importano i *.test.js.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { button, deferred, loadModule, settle, textOf } from './load.mjs';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'shared', 'src');
const at = (f) => JSON.stringify(join(PKG, f));

/** Le chiamate all'API e al login, in ordine: { method, path, args, d }. */
export const net = {
  log: [],
  call(method, path, args) {
    const d = deferred();
    this.log.push({ method, path, args, d });
    return d.promise;
  },
};
globalThis.__net = net;

// Ogni schermo caricato è un bundle con la sua copia di apiErrors.js: si
// tiene quella del primo, così gli errori che costruisce la prova sono
// riconosciuti con `instanceof` da tutti gli schermi dello stesso file.
const SHARED = `
import * as apiErrors from ${at('apiErrors.js')};
export * from ${at('format.js')};
export * from ${at('labels.js')};
export { isPlausiblePhone } from ${at('phone.js')};
export { statusMeta, depositMeta } from ${at('ui/meta.js')};
const E = globalThis.__fakeApiErrors || (globalThis.__fakeApiErrors = apiErrors);
export const { ApiError, apiErrorText, toastApiError } = E;
export function Icon() { return null; }
Icon.stub = true;
export function PhoneInput() { return null; }
PhoneInput.stub = true;
export const SALON_SLUG = 'the-parlour';
const N = globalThis.__net;
N.ApiError = E.ApiError;
const call = (method) => (path, ...args) => N.call(method, path, args);
export const api = { get: call('get'), post: call('post'), put: call('put'), del: call('del') };
export const clientAuth = {
  requestOtp: (...args) => N.call('requestOtp', null, args),
  register: (...args) => N.call('register', null, args),
  verifyOtp: (...args) => N.call('verifyOtp', null, args),
};
`;
const CTX = `
export const useApp = () => globalThis.__ctx;
export const SALON_SLUG = 'the-parlour';
`;

// useTodayKey e gli altri ascoltano documento e finestra
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
globalThis.window = { addEventListener() {}, removeEventListener() {} };

/** Uno schermo (percorso da apps/client-app/) col mondo finto; `stubs`: i
 *  .jsx con gli hook da sostituire con componenti muti. */
export function loadScreen(entry, stubs = []) {
  return loadModule(entry, { shared: SHARED, react: true, jsx: true, ctx: CTX, stubs });
}

export const BRAND = { name: 'The Parlour', phone: '+39 02 1234 5678', type: 'serif', cancelMinHours: 24 };

/** Il contesto del prossimo schermo montato; viste aperte e toast finiscono
 *  negli elenchi restituiti. Svuota anche il registro delle chiamate. */
export function fakeCtx(extra = {}) {
  net.log.length = 0;
  const toasts = [];
  const views = [];
  globalThis.__ctx = {
    t: (it) => it, lang: 'it', brand: BRAND, session: null, viewParams: {},
    setView: (v, params) => views.push([v, params]),
    fireToast: (o) => toasts.push(o),
    ...extra,
  };
  return { toasts, views };
}

/** Le chiamate registrate finora, senza le Promise: [metodo, percorso, ...argomenti]. */
export const calls = () => net.log.map(({ method, path, args }) => [method, path, ...args]);
export const pending = (method, path) => net.log.filter((c) => c.method === method && c.path === path);
export async function reply(entry, data) { entry.d.resolve(data); await settle(); }
export async function fail(entry, status, message) { entry.d.reject(new net.ApiError(status, message)); await settle(); }
export async function lost(entry) { entry.d.reject(new TypeError('Failed to fetch')); await settle(); }

/** Tocca un pulsante di uno schermo montato e ridisegna, e ancora dopo aver
 *  lasciato girare l'azione asincrona fin dove arriva senza risposte nuove
 *  (non ne aspetta la fine: quella dipende dalle risposte che dà la prova).
 *  Un pulsante disabilitato nel browser non risponde: qui è un errore. */
export async function tap(s, label) {
  const b = button(s.tree, label);
  if (b.props.disabled) throw new Error(`«${label}» è disabilitato`);
  const res = b.props.onClick();
  s.render();
  if (res && typeof res.then === 'function') { await settle(); s.render(); }
}

/** Tutto il testo a video dello schermo montato. */
export const text = (s) => textOf(s.tree);
