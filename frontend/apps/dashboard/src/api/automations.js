// api/automations.js — endpoint delle automazioni (/api/automations): regole,
// attivazione, catalogo di eventi, campi e operatori.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const automationsApi = {
  list: () => api.get('/api/automations/'),
  create: (body) => api.post('/api/automations/', body),
  update: (id, body) => api.put(`/api/automations/${id}`, body),
  remove: (id) => api.del(`/api/automations/${id}`),
  /* accende o spegne: POST senza corpo */
  toggle: (id) => api.post(`/api/automations/${id}/toggle`),
  eventsCatalog: () => api.get('/api/automations/events-catalog'),
};
