// api/insights.js — endpoint dell'analisi dati (/api/insights): KPI, serie dei
// ricavi, ricavi per categoria, occupazione per giorno, domande all'assistente.
// (Regole comuni ai moduli di api/: vedi l'intestazione di core.js.)
import { api } from '@youty/shared';

export const insightsApi = {
  kpis: (params) => api.get('/api/insights/kpis', { params }),
  revenueSeries: (params) => api.get('/api/insights/revenue-series', { params }),
  revenueByCategory: (params) => api.get('/api/insights/revenue-by-category', { params }),
  occupancyByWeekday: (params) => api.get('/api/insights/occupancy-by-weekday', { params }),
  ask: (body) => api.post('/api/insights/ask', body),
};
