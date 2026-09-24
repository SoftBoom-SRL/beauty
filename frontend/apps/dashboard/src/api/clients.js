// api/clients.js — endpoint delle clienti (/api/clients): anagrafica, import,
// storico, etichette, note con allegati, schede tecniche con foto.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const clientsApi = {
  list: (params) => api.get('/api/clients/', { params }),
  /* Schede attive in tutto e per etichetta, in una risposta: { active,
   * categories: [{ id, count }] } (le card in cima alla sezione Clienti). */
  counts: () => api.get('/api/clients/counts'),
  get: (id) => api.get(`/api/clients/${id}`),
  create: (body) => api.post('/api/clients/', body),
  update: (id, body) => api.put(`/api/clients/${id}`, body),
  /* La scheda archiviata che il server propone con il 409 del duplicato: si
   * riattiva con un PUT del solo `is_active` (i campi assenti non si toccano). */
  reactivate: (id) => api.put(`/api/clients/${id}`, { is_active: true }),
  remove: (id) => api.del(`/api/clients/${id}`),
  importRows: (body) => api.post('/api/clients/import', body),
  history: (id) => api.get(`/api/clients/${id}/history`),
};

export const clientCategoriesApi = {
  list: () => api.get('/api/clients/categories'),
  create: (body) => api.post('/api/clients/categories', body),
  update: (id, body) => api.put(`/api/clients/categories/${id}`, body),
  remove: (id) => api.del(`/api/clients/categories/${id}`),
};

/* `form`: FormData o campi semplici, come api.postForm. */
export const clientNotesApi = {
  list: (clientId) => api.get(`/api/clients/${clientId}/notes`),
  create: (clientId, body) => api.post(`/api/clients/${clientId}/notes`, body),
  upload: (clientId, form) => api.postForm(`/api/clients/${clientId}/notes/upload`, form),
  update: (clientId, noteId, body) => api.put(`/api/clients/${clientId}/notes/${noteId}`, body),
  remove: (clientId, noteId) => api.del(`/api/clients/${clientId}/notes/${noteId}`),
  addAttachments: (clientId, noteId, form) => api.postForm(`/api/clients/${clientId}/notes/${noteId}/attachments`, form),
  removeAttachment: (clientId, noteId, attachmentId) => api.del(`/api/clients/${clientId}/notes/${noteId}/attachments/${attachmentId}`),
};

export const techSheetsApi = {
  list: (clientId) => api.get(`/api/clients/${clientId}/sheets`),
  create: (clientId, body) => api.post(`/api/clients/${clientId}/sheets`, body),
  uploadPhoto: (clientId, sheetId, file) => api.postForm(`/api/clients/${clientId}/sheets/${sheetId}/photo`, { photo: file }),
};
