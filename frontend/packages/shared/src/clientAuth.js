// clientAuth.js — client (mobile web app) session store.
// Persists on localStorage key `yt.client.session:<slug>`: { access, client: {id, first_name, lang} }.
// There is NO client refresh endpoint: token lives ~30 days, on 401 → logout (re-do OTP).
//
// La chiave è namespacizzata per salone: tutti i saloni vivono sullo stesso origin
// (`/<slug>` nel path), quindi condividono il localStorage. Senza namespace una
// cliente che apre due saloni presenterebbe al secondo il token emesso dal primo.

import { api, setTokenProvider, setOnUnauthorized } from './api.js';
import { SALON_SLUG } from './salon.js';

const KEY = `yt.client.session:${SALON_SLUG}`;

let session = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  listeners.forEach((fn) => fn(session));
}

export function getSession() { return session; }

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** POST /api/auth/client/register — creates the client and issues an OTP.
 *  payload: { salon_slug, first_name, last_name, phone, email?, lang? }
 *  400 "Numero di telefono già registrato" se il numero è GIÀ in anagrafica,
 *  attivo o disattivato che sia: chi chiama non può distinguere i due casi. */
export function register(payload) {
  return api.post('/api/auth/client/register', payload, { auth: false });
}

/** POST /api/auth/client/request-otp — 200 SEMPRE, 429 se si supera il tetto.
 *  Il 200 non dice se il numero è in anagrafica e non deve dirlo: rispondere
 *  404 sugli sconosciuti faceva dell'endpoint un oracolo, e chi ciclava i
 *  numeri si ricavava la rubrica del salone. Quindi da qui NON si deduce che
 *  la cliente è nuova: la registrazione è una scelta esplicita di chi entra. */
export function requestOtp(salonSlug, phone) {
  return api.post('/api/auth/client/request-otp', { salon_slug: salonSlug, phone }, { auth: false });
}

/** POST /api/auth/client/verify-otp — 400 "Codice non valido o scaduto".
 *  On success stores { access, client } and returns it. */
export async function verifyOtp(salonSlug, phone, code) {
  const data = await api.post('/api/auth/client/verify-otp', { salon_slug: salonSlug, phone, code }, { auth: false });
  setSession(data);
  return data;
}

export function logout() { setSession(null); }

/** Wire this store into the api wrapper. Called once by the client app's
 *  entrypoint — on 401 just logout (no refresh exists for clients). */
export function installClientAuth() {
  setTokenProvider(() => session?.access || null);
  setOnUnauthorized(() => { setSession(null); return false; });
}
