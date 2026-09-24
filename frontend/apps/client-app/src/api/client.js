// client.js — gli endpoint dell'API che usa l'app cliente, una funzione per
// endpoint: stessi percorsi e parametri di sempre, `auth: false` per quelli
// pubblici (il salone arriva come slug e non serve la sessione). Accesso e
// registrazione col codice via SMS sono in clientAuth di @youty/shared.
// I parametri di query si passano come oggetto: l'ordine delle chiavi è
// l'ordine nella query string.
import { api } from '@youty/shared';

/* ---- pubblici ---- */

/** Branding del salone: nome, colore, logo, fuso, lingua, soglia di preavviso. */
export const getBranding = (salon) => api.get('/api/core/public/branding', { params: { salon }, auth: false });

/** Listino pubblico: le categorie con i loro servizi. */
export const getPublicServices = (salon) => api.get('/api/catalog/public/services', { params: { salon }, auth: false });

/** Pacchetti pubblici. */
export const getPublicPackages = (salon) => api.get('/api/catalog/public/packages', { params: { salon }, auth: false });

/** Operatrici attive, per la scelta dell'operatrice nella prenotazione. */
export const getPublicOperators = (salon) => api.get('/api/staff/public/operators', { params: { salon }, auth: false });

/** Orari liberi per chi prenota senza sessione: { salon, date, items }. */
export const getPublicAvailability = (params) => api.get('/api/agenda/public/availability', { params, auth: false });

/** Modulo contatti pubblico di /<slug>/hook. */
export const sendHook = (body) => api.post('/api/clients/public/hook', body, { auth: false });

/* ---- della cliente, con la sessione ---- */

/** Orari liberi: { date, items } (+ exclude_appointment_id per lo spostamento). */
export const getAvailability = (params) => api.get('/api/agenda/client/availability', { params });

/** I suoi appuntamenti: { upcoming, past }. */
export const getAppointments = () => api.get('/api/agenda/client/appointments');

/** Nuovo appuntamento: { items, start }. */
export const createAppointment = (body) => api.post('/api/agenda/client/appointments', body);

export const moveAppointment = (id, start) => api.post(`/api/agenda/client/appointments/${id}/move`, { start });

/** Senza corpo, come sempre. */
export const cancelAppointment = (id) => api.post(`/api/agenda/client/appointments/${id}/cancel`);

/** Il link di pagamento della caparra, rifatto dal server a ogni richiesta. */
export const createDepositLink = (id) => api.post(`/api/sales/client/appointments/${id}/deposit-link`, {});

export const getWaitlist = () => api.get('/api/agenda/client/waitlist');

/** Richiesta di lista d'attesa: { service_id, preference, exact_days?, exact_time? }. */
export const joinWaitlist = (body) => api.post('/api/agenda/client/waitlist', body);

export const leaveWaitlist = (id) => api.del(`/api/agenda/client/waitlist/${id}`);

/** Portafoglio: gift card, coupon, programmi fedeltà. */
export const getWallet = () => api.get('/api/marketing/client/wallet');

/** Gift card comprata dall'app (si paga in salone): { value, recipient_name }. */
export const buyGiftCard = (body) => api.post('/api/marketing/client/gift-cards', body);

export const setMarketingConsent = (accepted) => api.post('/api/marketing/client/marketing-consent', { accepted });

export const getMe = () => api.get('/api/auth/client/me');

export const updateMe = (patch) => api.put('/api/auth/client/me', patch);
