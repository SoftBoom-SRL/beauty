// Sostituto di '@youty/shared' per i test: riesporta i VERI helper puri del
// pacchetto — format.js, labels.js, phone.js e la classe ApiError con il testo
// e il toast d'errore di apiErrors.js — più un `api` finto (in fondo). Serve
// perché l'indice del pacchetto tira dentro i componenti React e api.js (che al
// caricamento legge import.meta.env), che nei test con `node --test` non
// servono (e senza DOM non si caricano).
//
// Un aiuto puro nuovo va esportato qui, dall'indice (packages/shared/src/index.js)
// e dallo SHARED di apps/dashboard/test/grid-harness.mjs, nello stesso commit:
// con il nome solo qui i test passano e il build si rompe, senza il nome qui
// è il contrario. Lo controlla packages/shared/test/shims.test.js.
export * from '../packages/shared/src/format.js';
export * from '../packages/shared/src/labels.js';
// Anche le regole del telefono: sono pure come format.js, e i moduli delle
// app che le importano da '@youty/shared' (import CSV, schede) si possono
// provare così come sono. Solo i nomi dell'indice: COUNTRY_CODES e
// readPhoneField restano interni (li usa PhoneInput.jsx; i test del pacchetto
// li importano dal file).
export {
  COUNTRIES, DEFAULT_ISO2, countryOf,
  splitPhone, joinPhone, formatNational, formatPhone, normalizePhone, isPlausiblePhone,
} from '../packages/shared/src/phone.js';

// La classe vera (non una copia): il test che costruisce l'errore e il modulo
// che lo riconosce con `instanceof` vedono la stessa. Solo i nomi che esporta
// anche l'indice: readableDetail resta interno al pacchetto.
export { ApiError, apiErrorText, toastApiError } from '../packages/shared/src/apiErrors.js';

// `api` finto, come quello dello SHARED di grid-harness.mjs: ogni chiamata va a
// globalThis.__api, che il test imposta (un registratore). Così i moduli di
// apps/dashboard/src/api/ si provano per quello che manderebbero al server —
// metodo, percorso, parametri, corpo — senza rete. Senza __api la chiamata
// fallisce subito: un modulo provato con `npm test` non va in rete da solo.
// API_URL è il valore di api.js quando VITE_API_URL manca.
const call = (m) => (...a) => {
  if (!globalThis.__api?.[m]) throw new Error(`api.${m}: globalThis.__api non impostato (test/shared-shim.mjs)`);
  return globalThis.__api[m](...a);
};
export const api = {
  get: call('get'), post: call('post'), put: call('put'), patch: call('patch'), del: call('del'), postForm: call('postForm'),
};
export const API_URL = 'http://localhost:8000';
