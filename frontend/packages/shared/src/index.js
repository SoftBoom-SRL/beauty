// @youty/shared — raw ESM, consumed directly by Vite (no build step).

export { api, ApiError, qs, mediaUrl, API_URL, setTokenProvider, setOnUnauthorized } from './api.js';

// Auth stores are namespaced (both expose login/logout/getSession/subscribe):
//   import { staffAuth, clientAuth } from '@youty/shared';
//   staffAuth.hasScope('agenda'); clientAuth.requestOtp(slug, phone);
export * as staffAuth from './staffAuth.js';
export * as clientAuth from './clientAuth.js';

export { LangProvider, useT, makeT } from './i18n.jsx';

export {
  fmtEur, timeLabel, fmtDur,
  todayStr, toDateStr, parseISO, minutesOfDay, addDays, fmtDateIt,
  // Salon-timezone layer: every INSTANT coming from the API must be rendered
  // through these, never through the browser's local time. See format.js.
  setSalonTimeZone, salonTimeZone, salonParts, salonTodayStr, salonNowMinutes,
  salonWeekday, fmtTimeSalon, fmtDateTimeSalon, salonIsoAt,
  salonDateStr, salonDayDiff,
} from './format.js';

export * from './ui/index.js';
