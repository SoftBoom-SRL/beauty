// api/core.js — endpoint del salone (/api/core): dati del salone e
// impostazioni, sedi, regole della caparra, registro attività, feed live,
// stato della consegna dei messaggi.
//
// Come tutti i moduli di api/: una funzione per endpoint, che fa una sola
// chiamata con il percorso, i parametri e il corpo che le passa chi la usa, e
// restituisce la promessa di `api` così com'è (niente logica, niente
// trasformazioni: chi chiama decide cosa farne). Serve a trovare in un posto
// solo che cosa la dashboard chiede al server. Gli endpoint dell'agenda li
// raccoglie la sezione agenda per conto suo. Le prove di contratto sono in
// apps/dashboard/test/api-endpoints.test.js.
import { api, API_URL } from '@youty/shared';

export const salonApi = {
  get: () => api.get('/api/core/salon'),
};

/* PUT /api/core/settings scrive solo i campi che riceve: ogni schermata manda
 * i suoi (orari, brand, motivazioni, caparra, ottimizzazione, ritardo delle
 * automazioni). */
export const settingsApi = {
  update: (body) => api.put('/api/core/settings', body),
  uploadLogo: (file) => api.postForm('/api/core/settings/logo', { logo: file }),
};

export const locationsApi = {
  list: () => api.get('/api/core/locations'),
  create: (body) => api.post('/api/core/locations', body),
  update: (id, body) => api.put(`/api/core/locations/${id}`, body),
  remove: (id) => api.del(`/api/core/locations/${id}`),
};

export const depositRulesApi = {
  list: () => api.get('/api/core/deposit-rules'),
  create: (body) => api.post('/api/core/deposit-rules', body),
  update: (id, body) => api.put(`/api/core/deposit-rules/${id}`, body),
  remove: (id) => api.del(`/api/core/deposit-rules/${id}`),
};

/* Registro attività e feed live (il feed di ctx.jsx): `feed` è il polling
 * con `after` (cursore), lo stream SSE si apre con un ticket monouso. */
export const activityApi = {
  list: (params) => api.get('/api/core/activity', { params }),
  feed: (params) => api.get('/api/core/activity/feed', { params }),
  streamTicket: () => api.post('/api/core/activity/stream-ticket'),
  streamUrl: (ticket, after) => `${API_URL}/api/core/activity/stream?ticket=${encodeURIComponent(ticket)}&after=${after}`,
};

export const outboxApi = {
  status: () => api.get('/api/core/outbox/status'),
};
