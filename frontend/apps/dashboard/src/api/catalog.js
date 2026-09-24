// api/catalog.js — endpoint del listino (/api/catalog): servizi, pacchetti e
// categorie dei servizi. (Regole comuni ai moduli di api/: vedi core.js.)
import { api } from '@youty/shared';

export const servicesApi = {
  list: () => api.get('/api/catalog/services'),
  create: (body) => api.post('/api/catalog/services', body),
  update: (id, body) => api.put(`/api/catalog/services/${id}`, body),
  remove: (id) => api.del(`/api/catalog/services/${id}`),
};

export const packagesApi = {
  list: () => api.get('/api/catalog/packages'),
  create: (body) => api.post('/api/catalog/packages', body),
  update: (id, body) => api.put(`/api/catalog/packages/${id}`, body),
  remove: (id) => api.del(`/api/catalog/packages/${id}`),
};

/* Le tre famiglie di categorie (servizi, clienti, magazzino) hanno la stessa
 * forma: la gestione categorie le usa per nome (vedi CategoriesManagerModal). */
export const serviceCategoriesApi = {
  list: () => api.get('/api/catalog/categories'),
  create: (body) => api.post('/api/catalog/categories', body),
  update: (id, body) => api.put(`/api/catalog/categories/${id}`, body),
  remove: (id) => api.del(`/api/catalog/categories/${id}`),
  reorder: (ids) => api.post('/api/catalog/categories/reorder', { ids }),
};
