// api/marketing.js — endpoint del marketing (/api/marketing): coupon, gift
// card, programmi fedeltà con le iscritte, comunicazioni.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const couponsApi = {
  list: (params) => api.get('/api/marketing/coupons', { params }),
  create: (body) => api.post('/api/marketing/coupons', body),
  update: (id, body) => api.put(`/api/marketing/coupons/${id}`, body),
  remove: (id) => api.del(`/api/marketing/coupons/${id}`),
  redeem: (id) => api.post(`/api/marketing/coupons/${id}/redeem`, {}),
};

export const giftCardsApi = {
  list: (params) => api.get('/api/marketing/gift-cards', { params }),
  create: (body) => api.post('/api/marketing/gift-cards', body),
  markPaid: (id, body) => api.post(`/api/marketing/gift-cards/${id}/mark-paid`, body),
};

export const loyaltyApi = {
  list: (params) => api.get('/api/marketing/loyalty-programs', { params }),
  create: (body) => api.post('/api/marketing/loyalty-programs', body),
  update: (id, body) => api.put(`/api/marketing/loyalty-programs/${id}`, body),
  remove: (id) => api.del(`/api/marketing/loyalty-programs/${id}`),
  accounts: (programId, params) => api.get(`/api/marketing/loyalty-programs/${programId}/accounts`, { params }),
  /* iscrizione a mano a un programma senza iscrizione automatica (C16) */
  enroll: (programId, body) => api.post(`/api/marketing/loyalty-programs/${programId}/accounts`, body),
};

export const communicationsApi = {
  list: (params) => api.get('/api/marketing/communications', { params }),
  create: (body) => api.post('/api/marketing/communications', body),
  update: (id, body) => api.put(`/api/marketing/communications/${id}`, body),
  remove: (id) => api.del(`/api/marketing/communications/${id}`),
  send: (id, body) => api.post(`/api/marketing/communications/${id}/send`, body),
};
