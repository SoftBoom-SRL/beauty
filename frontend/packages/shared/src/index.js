// @youty/shared — raw ESM, consumed directly by Vite (no build step).

export { api, qs, mediaUrl, API_URL, setTokenProvider, setOnUnauthorized } from './api.js';
// L'errore dell'API e il testo o il toast che se ne mostra (logica pura).
//   catch (err) { toastApiError(err, fireToast, t); }  ·  setErr(apiErrorText(err, t))
export { ApiError, apiErrorText, toastApiError } from './apiErrors.js';

// Auth stores are namespaced (both expose login/logout/getSession/subscribe):
//   import { staffAuth, clientAuth } from '@youty/shared';
//   staffAuth.hasScope('agenda'); clientAuth.requestOtp(slug, phone);
export * as staffAuth from './staffAuth.js';
export * as clientAuth from './clientAuth.js';

export { SALON_SLUG, resolveSalonSlug } from './salon.js';

export { LangProvider, useT, makeT, storedLang } from './i18n.jsx';

export {
  fmtEur, fmtEurNoFree, fmtEurOrZero, timeLabel, fmtDur,
  todayStr, toDateStr, parseISO, minutesOfDay, addDays, fmtDateIt,
  // Fuso del salone: le app lo impostano al boot dal payload del server.
  setSalonTz, salonTz, nowMinutes, isoAtMin,
  salonDateParts, salonTzOpts, fmtTime, toDateTimeLocal, dateTimeLocalToIso,
} from './format.js';

// Etichette bilingui (logica pura): nameIn(servizio, lang) → name_en o name_it;
// nomi di mesi (0 = gennaio) e giorni (0 = lunedì, come l'API).
export {
  nameIn,
  MONTHS_LONG_IT, MONTHS_LONG_EN, MONTHS_SHORT_IT, MONTHS_SHORT_EN, WEEKDAYS_SHORT_IT, WEEKDAYS_SHORT_EN,
} from './labels.js';

// Telefoni: elenco prefissi + conversioni da/verso E.164 (logica pura).
export {
  COUNTRIES, DEFAULT_ISO2, countryOf,
  splitPhone, joinPhone, formatNational, normalizePhone, isPlausiblePhone,
} from './phone.js';

export * from './ui/index.js';
