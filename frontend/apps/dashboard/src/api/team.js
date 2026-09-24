// api/team.js — endpoint del team e dell'account (/api/auth): membri e loro
// ruolo, ruoli con i permessi, inviti, cambio password dello staff.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const membersApi = {
  list: () => api.get('/api/auth/members'),
  setRole: (id, body) => api.post(`/api/auth/members/${id}/role`, body),
  remove: (id) => api.del(`/api/auth/members/${id}`),
};

export const rolesApi = {
  list: () => api.get('/api/auth/roles'),
  create: (body) => api.post('/api/auth/roles', body),
  update: (id, body) => api.put(`/api/auth/roles/${id}`, body),
  remove: (id) => api.del(`/api/auth/roles/${id}`),
};

export const invitationsApi = {
  list: () => api.get('/api/auth/invitations'),
  create: (body) => api.post('/api/auth/invitations', body),
};

/* Il server risponde con token nuovi (le altre sessioni sono invalidate): chi
 * chiama li applica con staffAuth.applySession. */
export const staffAccountApi = {
  changePassword: (body) => api.post('/api/auth/staff/password', body),
};
