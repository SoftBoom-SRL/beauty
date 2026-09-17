// @youty/shared — raw ESM, consumed directly by Vite (no build step).

export { api, ApiError, qs, mediaUrl, API_URL, setTokenProvider, setOnUnauthorized } from './api.js';

// Auth stores are namespaced (both expose login/logout/getSession/subscribe):
//   import { staffAuth, clientAuth } from '@youty/shared';
//   staffAuth.hasScope('agenda'); clientAuth.requestOtp(slug, phone);
export * as staffAuth from './staffAuth.js';
export * as clientAuth from './clientAuth.js';

export { SALON_SLUG, resolveSalonSlug } from './salon.js';

export { LangProvider, useT, makeT } from './i18n.jsx';

export {
  fmtEur, timeLabel, fmtDur,
  todayStr, toDateStr, parseISO, minutesOfDay, addDays, fmtDateIt,
  // Fuso del salone: le app lo impostano al boot dal payload del server.
  setSalonTz, salonTz, nowMinutes, isoAtMin,
  salonDateParts, salonTzOpts, fmtTime, toDateTimeLocal, dateTimeLocalToIso,
} from './format.js';

// Telefoni: elenco prefissi + conversioni da/verso E.164 (logica pura).
export {
  COUNTRIES, DEFAULT_ISO2, countryOf,
  splitPhone, joinPhone, formatNational, formatPhone, normalizePhone, isPlausiblePhone,
} from './phone.js';

export * from './ui/index.js';
