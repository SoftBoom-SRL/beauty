// api/sales.js — endpoint delle vendite (/api/sales): storico, vendita al
// banco, check-out di un appuntamento, collegamento Stripe del salone.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const salesApi = {
  list: (params) => api.get('/api/sales/', { params }),
  get: (id) => api.get(`/api/sales/${id}`),
  pos: (body) => api.post('/api/sales/pos', body),
  checkout: (appointmentId, body) => api.post(`/api/sales/checkout/${appointmentId}`, body),
};

/* Stripe Connect: `start` e `callback` li chiama la finestra di servizio
 * /stripe-connect/* (oauth/StripeConnectPopup.jsx), gli altri il drawer dei
 * pagamenti. */
export const stripeConnectApi = {
  status: () => api.get('/api/sales/stripe/connect/status'),
  start: () => api.post('/api/sales/stripe/connect/start', {}),
  callback: (body) => api.post('/api/sales/stripe/connect/callback', body),
  disconnect: () => api.del('/api/sales/stripe/connect'),
};
