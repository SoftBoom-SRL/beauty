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

export function logout() { setSession(null); }

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
