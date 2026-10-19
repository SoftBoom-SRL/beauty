// api/team.js — endpoint del team e dell'account (/api/auth): membri e loro
// ruolo, ruoli con i permessi, inviti, cambio password dello staff.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const membersApi = {
  list: () => api.get('/api/auth/members'),
  setRole: (id, body) => api.post(`/api/auth/members/${id}/role`, body),
  remove: (id) => api.del(`/api/auth/members/${id}`),
  transferOwnership: (id) => api.post(`/api/auth/members/${id}/transfer-ownership`),
};

export const rolesApi = {
  list: () => api.get('/api/auth/roles'),
  create: (body) => api.post('/api/auth/roles', body),
  update: (id, body) => api.put(`/api/auth/roles/${id}`, body),
  remove: (id) => api.del(`/api/auth/roles/${id}`),
};

export const invitationsApi = {
  list: () => api.get('/api/auth/invitations'),
  // { email, role_id, operator_id? } → l'invito col link e `email_sent`
  create: (body) => api.post('/api/auth/invitations', body),
  resend: (id) => api.post(`/api/auth/invitations/${id}/resend`),
  revoke: (id) => api.del(`/api/auth/invitations/${id}`),
  // la pagina /invito/<codice>, senza login
  preview: (token) => api.get('/api/auth/invitations/preview', { params: { token } }),
  // { token, password, first_name?, last_name? } → la sessione nel salone dell'invito
  accept: (body) => api.post('/api/auth/invitations/accept', body),
  // con la sessione già aperta (chi entra con Yourang)
  acceptSession: (token) => api.post('/api/auth/invitations/accept-session', { token }),
};

/* Il server risponde con token nuovi (le altre sessioni sono invalidate): chi
 * chiama li applica con staffAuth.applySession. */
export const staffAccountApi = {
  changePassword: (body) => api.post('/api/auth/staff/password', body),
};
