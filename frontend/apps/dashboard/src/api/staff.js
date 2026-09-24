// api/staff.js — endpoint delle operatrici (/api/staff): elenco e scheda,
// turni, colore in agenda, prestazioni, clienti servite, assenze.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const staffApi = {
  list: (params) => api.get('/api/staff/', { params }),
  create: (body) => api.post('/api/staff/', body),
  get: (id) => api.get(`/api/staff/${id}`),
  update: (id, body) => api.put(`/api/staff/${id}`, body),
  setColor: (id, color) => api.patch(`/api/staff/${id}/color`, { color }),
  updateShifts: (id, body) => api.put(`/api/staff/${id}/shifts`, body),
  performance: (id, params) => api.get(`/api/staff/${id}/performance`, { params }),
  clients: (id, params) => api.get(`/api/staff/${id}/clients`, { params }),
};

export const absencesApi = {
  list: (operatorId) => api.get(`/api/staff/${operatorId}/absences`),
  create: (operatorId, body) => api.post(`/api/staff/${operatorId}/absences`, body),
  update: (operatorId, id, body) => api.put(`/api/staff/${operatorId}/absences/${id}`, body),
  remove: (operatorId, id) => api.del(`/api/staff/${operatorId}/absences/${id}`),
};
