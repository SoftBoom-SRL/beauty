// api/inventory.js — endpoint del magazzino (/api/inventory): prodotti e loro
// movimenti, carichi e scarichi, categorie, fornitori, ordini, storico.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

const PROD_PAGE = 500;
const PROD_MAX_PAGES = 20;   // fino a 10.000 articoli: oltre, le metriche si dichiarano parziali

export const productsApi = {
  list: (params) => api.get('/api/inventory/products', { params }),
  get: (id) => api.get(`/api/inventory/products/${id}`),
  create: (body) => api.post('/api/inventory/products', body),
  update: (id, body) => api.put(`/api/inventory/products/${id}`, body),
  remove: (id) => api.del(`/api/inventory/products/${id}`),
  movements: (id, params) => api.get(`/api/inventory/products/${id}/movements`, { params }),
  /* carico: multipart (la fattura è un file facoltativo) */
  load: (id, form) => api.postForm(`/api/inventory/products/${id}/load`, form),
  unload: (id, body) => api.post(`/api/inventory/products/${id}/unload`, body),
  /* carico da CSV o da elenco incollato, righe `CsvRowIn` (contratto C7) */
  loadCsv: (body) => api.post('/api/inventory/load-csv', body),
  /* Tutto il catalogo, anche i prodotti disattivati, a pagine da 500.
   * Lo snapshot alimenta valore di magazzino, conteggio sottoscorta, elenco
   * brand, picker dello scarico manuale e i prezzi delle righe d'ordine: una
   * sola pagina da 500 con `count` ignorato faceva mentire tutte queste cifre su
   * un catalogo più grande, e i prodotti oltre il 500° sparivano dal picker
   * senza alcun avviso. Si pagina fino a `count`, con un tetto oltre il quale lo
   * snapshot si dichiara parziale. → { items, partial } */
  listAll: async () => {
    const items = [];
    let count = 0;
    for (let page = 0; page < PROD_MAX_PAGES; page++) {
      const res = await api.get('/api/inventory/products', {
        params: { limit: PROD_PAGE, offset: page * PROD_PAGE, include_inactive: true },
      });
      const batch = res?.items || [];
      items.push(...batch);
      count = Number(res?.count ?? items.length);
      if (!batch.length || items.length >= count) return { items, partial: false };
    }
    return { items, partial: items.length < count };
  },
};

export const productCategoriesApi = {
  list: () => api.get('/api/inventory/categories'),
  create: (body) => api.post('/api/inventory/categories', body),
  update: (id, body) => api.put(`/api/inventory/categories/${id}`, body),
  remove: (id) => api.del(`/api/inventory/categories/${id}`),
};

export const suppliersApi = {
  list: () => api.get('/api/inventory/suppliers'),
  create: (body) => api.post('/api/inventory/suppliers', body),
  update: (id, body) => api.put(`/api/inventory/suppliers/${id}`, body),
  remove: (id) => api.del(`/api/inventory/suppliers/${id}`),
};

export const movementsApi = {
  list: (params) => api.get('/api/inventory/movements', { params }),
};

export const ordersApi = {
  list: (params) => api.get('/api/inventory/orders', { params }),
  /* bozze dai prodotti sotto soglia: POST senza corpo */
  generate: () => api.post('/api/inventory/orders/generate'),
  update: (id, body) => api.put(`/api/inventory/orders/${id}`, body),
  send: (id, body) => api.post(`/api/inventory/orders/${id}/send`, body),
  receive: (id, body) => api.post(`/api/inventory/orders/${id}/receive`, body),
};
