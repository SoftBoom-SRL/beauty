// agendaApi.js — le chiamate dell'agenda all'API, una funzione per endpoint.
// Gli indirizzi erano scritti a mano in ogni file (lo spostamento in cinque
// posti): qui si leggono tutti insieme. I corpi e i parametri passano così
// come li costruisce chi chiama — stessi campi, stesso ordine —, e le
// risposte e gli errori (ApiError) arrivano come da `api`.
// NON lo importano i moduli puri di lib/: il sostituto di '@youty/shared' dei
// test con `node --test` non ha `api`.
import { api } from '@youty/shared';

const appt = (id) => `/api/agenda/appointments/${id}`;

/* ---- giornate: giorno, settimana, mese ---- */
export const getDay = (date, locationId) => api.get('/api/agenda/day', { params: { date, location_id: locationId } });
/** La sede va nei parametri solo se c'è (senza, il server mostra tutte le sedi). */
export const getWeek = (start, locationId) => api.get('/api/agenda/week', { params: { start, ...(locationId ? { location_id: locationId } : {}) } });
export const getRange = (start, end, locationId) => api.get('/api/agenda/range', { params: { start, end, location_id: locationId } });
/** Orari liberi: `params` com'è, perché ogni pannello li scrive nel suo ordine. */
export const getAvailability = (params) => api.get('/api/agenda/availability', { params });

/* ---- colonna di destra, lista d'attesa, «torna indietro» ---- */
export const getWaitlist = () => api.get('/api/agenda/waitlist');
export const getReleased = () => api.get('/api/agenda/released');
export const getTodaySummary = () => api.get('/api/sales/today-summary');
export const markWaitlistContacted = (id) => api.post(`/api/agenda/waitlist/${id}/contacted`);
export const getUndoStack = () => api.get('/api/agenda/undo');
/** Annulla la voce `entryId`, o l'ultima di chi guarda se manca. */
export const undoGesture = (entryId) => api.post('/api/agenda/undo', entryId ? { entry_id: entryId } : {});

/* ---- appuntamenti ---- */
export const getAppointment = (id) => api.get(appt(id));
export const createAppointment = (body) => api.post('/api/agenda/appointments', body);
export const updateAppointment = (id, body) => api.put(appt(id), body);
export const moveAppointment = (id, body) => api.post(`${appt(id)}/move`, body);
export const splitAppointment = (id, body) => api.post(`${appt(id)}/split`, body);
export const restoreAppointment = (id, force) => api.post(`${appt(id)}/restore`, { force });
/** check-in, start, no-show, cancel: il comando è l'ultimo pezzo del percorso. */
export const appointmentAction = (id, action, body) => api.post(`${appt(id)}/${action}`, body);
export const getMargin = (id) => api.get(`${appt(id)}/margin`);

/* ---- caparra ---- */
export const sendDepositLink = (id) => api.post(`/api/sales/appointments/${id}/deposit-link`, {});
export const cashDeposit = (id, method) => api.post(`${appt(id)}/deposit-cashed`, { method });
export const markDepositRefunded = (id) => api.post(`${appt(id)}/deposit-refunded`, {});

/* ---- pause ---- */
export const createPause = (body) => api.post('/api/agenda/pauses', body);
export const updatePause = (id, body) => api.put(`/api/agenda/pauses/${id}`, body);
export const deletePause = (id) => api.del(`/api/agenda/pauses/${id}`);

/* ---- clienti e gift card (picker cliente, prenotazione) ---- */
export const getClient = (id) => api.get(`/api/clients/${id}`);
export const searchClients = (q) => api.get('/api/clients/', { params: { q, limit: 7, is_active: true } });
export const createClient = (body) => api.post('/api/clients/', body);
export const addClientNote = (id, body) => api.post(`/api/clients/${id}/notes`, body);
export const reactivateClient = (id) => api.put(`/api/clients/${id}`, { is_active: true });
export const getClientGiftCards = (clientId) => api.get('/api/marketing/gift-cards', { params: { client_id: clientId, status: 'active', payment_status: 'paid' } });
