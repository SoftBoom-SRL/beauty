// api/sales.js — endpoint delle vendite (/api/sales): storico, vendita al
// banco, check-out di un appuntamento (anche di più visite in un conto unico),
// conti da saldare, collegamento Stripe del salone.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const salesApi = {
  list: (params) => api.get('/api/sales/', { params }),
  get: (id) => api.get(`/api/sales/${id}`),
  pos: (body) => api.post('/api/sales/pos', body),
  checkout: (appointmentId, body) => api.post(`/api/sales/checkout/${appointmentId}`, body),
  // le altre visite della cliente di quel giorno che si possono chiudere nello stesso conto
  otherVisits: (appointmentId) => api.get(`/api/sales/checkout/${appointmentId}/other-visits`),
  // i conti della cliente ancora da saldare, dal più vecchio, e il loro totale
  dues: (clientId) => api.get('/api/sales/dues', { params: { client_id: clientId } }),
  // pagamento (anche parziale) di quanto resta da saldare su una vendita
  settle: (id, body) => api.post(`/api/sales/${id}/settle`, body),
  // la cassa di un giorno (YYYY-MM-DD): pagamenti arrivati, totali per metodo e scontrino
  register: (date) => api.get('/api/sales/register', { params: { date } }),
};

/* Stripe Connect: `start` e `callback` li chiama la finestra di servizio
 * /stripe-connect/* (oauth/StripeConnectPopup.jsx), gli altri il drawer dei
 * pagamenti. */
export const stripeConnectApi = {
  status: () => api.get('/api/sales/stripe/connect/status'),
  // mode 'existing': collega un account che il titolare ha già (OAuth);
  // senza, il portale crea l'account e Stripe lo fa completare (Account Links).
  start: (mode) => api.post('/api/sales/stripe/connect/start', mode ? { mode } : {}),
  callback: (body) => api.post('/api/sales/stripe/connect/callback', body),
  disconnect: () => api.del('/api/sales/stripe/connect'),
};
