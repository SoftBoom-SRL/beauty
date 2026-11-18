// shell/apptSearch.js — la ricerca degli appuntamenti nella barra in alto:
// come si scrive un risultato e come si chiede all'agenda di aprirlo.
// Logica pura, provata da npm test (test/ricerca-appuntamenti.test.js).
import { salonTzOpts } from '@youty/shared';

// Sotto i 2 caratteri il server non cerca (agenda/services/search.py).
export const MIN_QUERY = 2;

/** Vero se la ricerca è abbastanza lunga da chiedere gli appuntamenti. */
export const shouldSearch = (q) => (q || '').trim().length >= MIN_QUERY;

/** Il deepLink che apre un appuntamento in agenda: «appt:42». */
export const apptLink = (id) => 'appt:' + id;
/** L'id dell'appuntamento di un deepLink «appt:42»; null per ogni altro. */
export function apptIdOf(link) {
  const m = /^appt:(\d+)$/.exec(typeof link === 'string' ? link : '');
  return m ? Number(m[1]) : null;
}

/** «mer 18 nov 2026 · 10:30», giorno e ora del salone (non del dispositivo). */
export function hitWhen(hit, lang) {
  const d = new Date(hit.start);
  const loc = lang === 'en' ? 'en-GB' : 'it-IT';
  const day = d.toLocaleDateString(loc, salonTzOpts({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }));
  const time = d.toLocaleTimeString(loc, salonTzOpts({ hour: '2-digit', minute: '2-digit', hour12: false }));
  return day + ' · ' + time;
}

/** «Manicure · Pedicure · Giulia Bianchi». */
export const hitDetail = (hit) => [...(hit.services || []), hit.operator_name].filter(Boolean).join(' · ');
