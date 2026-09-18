// staffAuth.js — staff (dashboard) session store.
// Persists the full StaffAuthOut on localStorage key `yt.staff.session`:
//   { user: {id,email,name}, salon: {id,name,slug}, scopes: [str], is_owner: bool, access, refresh }

import { api, setTokenProvider, setOnUnauthorized } from './api.js';

const KEY = 'yt.staff.session';

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
  } catch { /* private mode etc. */ }
  listeners.forEach((fn) => fn(session));
}

export function getSession() { return session; }

/* Le schede dello stesso browser condividono una sola sessione: quando una la
   rinnova o esce, le altre devono accorgersene, altrimenti continuano a usare
   un token già consumato e finiscono buttate fuori a metà giornata. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    session = load();
    listeners.forEach((fn) => fn(session));
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function login(email, password) {
  const data = await api.post('/api/auth/staff/login', { email, password }, { auth: false });
  setSession(data);
  return data;
}

/** Apply a session obtained out-of-band (e.g. Login con Yourang popup). Same
 *  shape as /staff/login: { user, salon, scopes, is_owner, access, refresh }. */
export function applySession(data) { setSession(data); }

/** Uscita: prima si revocano le sessioni sul server, poi si svuota il browser.
 *
 *  Cancellare solo `localStorage` non era un'uscita: il refresh restava valido
 *  trenta giorni, quindi chi ne aveva una copia (telefono smarrito, computer
 *  della reception) continuava a entrare. L'ordine conta, perché la chiamata
 *  ha bisogno del token che stiamo per buttare.
 *
 *  Un errore non ferma l'uscita: se il server non risponde si esce lo stesso
 *  da questo browser — restare dentro sarebbe il peggiore dei due esiti. */
export async function logout() {
  try {
    // Con un timeout: senza, una rete lenta lasciava la persona «dentro» dopo
    // aver premuto Esci, senza nessun segnale, finché fetch non si arrendeva.
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(3000)
      : undefined;
    await api.post('/api/auth/staff/logout', undefined, { signal });
  } catch { /* rete giù, token scaduto o timeout: si esce comunque */ }
  setSession(null);
}

/** true if the session has the scope, or is_owner (owner bypasses all scopes) */
export function hasScope(scope) {
  if (!session) return false;
  return !!session.is_owner || (session.scopes || []).includes(scope);
}

/* ---- single-flight refresh ---- */
let refreshing = null;

/** Re-issues both tokens via POST /api/auth/staff/refresh.
 *  Resolves true on success, false on failure (and logs out). Single-flight. */
export function refresh() {
  // Il token di rinnovo ora vale una volta sola, e ogni scheda del browser
  // teneva la propria copia in memoria senza mai risincronizzarsi: la scheda in
  // secondo piano tentava di rinnovare con un token già consumato dall'altra,
  // riceveva 401 e svuotava localStorage per tutte e due. Si rilegge sempre dal
  // deposito condiviso prima di usarlo.
  const stored = load();
  if (stored && stored.refresh !== session?.refresh) session = stored;
  if (!session?.refresh) return Promise.resolve(false);
  if (refreshing) return refreshing;
  refreshing = api
    .post('/api/auth/staff/refresh', { refresh: session.refresh }, { auth: false })
    .then((data) => { setSession(data); return true; })
    .catch(() => { setSession(null); return false; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

/** Wire this store into the api wrapper. Called once by the dashboard app's
 *  entrypoint — on 401 the api will refresh once and retry, else logout. */
export function installStaffAuth() {
  setTokenProvider(() => session?.access || null);
  setOnUnauthorized(() => refresh());
}
