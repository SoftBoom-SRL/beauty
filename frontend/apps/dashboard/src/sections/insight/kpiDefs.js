// kpiDefs.js — maps GET /api/insights/kpis fields onto the prototype's customizable
// 4-of-N KPI band (`ALL_KPIS` in desktop-insight.jsx). Favorites persist to localStorage.
import { toDateStr } from '@youty/shared';

export const KPI_FAVS_KEY = 'dk-insight-kpi-favs';
export const DEFAULT_FAVS = ['revenue', 'appointments_count', 'avg_ticket', 'occupancy_pct'];

// Order shown in the "Personalizza" picker.
export const KPI_ORDER = [
  'revenue', 'sales_count', 'avg_ticket', 'retail_revenue',
  'appointments_count', 'occupancy_pct', 'return_rate', 'rebooking_rate',
  'noshow_rate', 'cancel_rate', 'new_clients', 'returning_clients', 'avg_frequency',
];

export function loadFavs() {
  try {
    const raw = localStorage.getItem(KPI_FAVS_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length ? arr.filter((k) => KPI_ORDER.includes(k)) : DEFAULT_FAVS;
  } catch {
    return DEFAULT_FAVS;
  }
}

export function saveFavs(favs) {
  try { localStorage.setItem(KPI_FAVS_KEY, JSON.stringify(favs)); } catch { /* private mode etc. */ }
}

/** anchor date (YYYY-MM-DD) that falls inside the period immediately BEFORE the
 * current one — used to fetch a comparison KpisOut for the Delta arrows. */
export function prevPeriodAnchor(period) {
  const now = new Date();
  let firstOfCurrent;
  if (period === 'quarter') {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    firstOfCurrent = new Date(now.getFullYear(), qStartMonth, 1);
  } else if (period === 'year') {
    firstOfCurrent = new Date(now.getFullYear(), 0, 1);
  } else {
    firstOfCurrent = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  const lastOfPrev = new Date(firstOfCurrent.getTime() - 86400000);
  return toDateStr(lastOfPrev);
}

function pctDelta(cur, prev) {
  if (cur == null || prev == null || !isFinite(prev) || prev === 0) return null;
  const d = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  return isFinite(d) ? d : null;
}

/** Build the ALL_KPIS map from real KpisOut payloads. `prev` (optional) is the
 * same shape for the previous period — enables Delta arrows; null hides them. */
export function buildAllKpis(cur, prev, t, lang, eur) {
  if (!cur) return {};
  const pct = (n) => Math.round((n || 0) * 100);
  return {
    revenue: {
      label: t('Incasso', 'Revenue'), value: eur(cur.revenue),
      delta: pctDelta(Number(cur.revenue), prev && Number(prev.revenue)),
    },
    sales_count: {
      label: t('Vendite', 'Sales'), value: String(cur.sales_count),
      delta: pctDelta(cur.sales_count, prev?.sales_count),
    },
    avg_ticket: {
      label: t('Scontrino medio', 'Avg ticket'), value: eur(cur.avg_ticket),
      delta: pctDelta(Number(cur.avg_ticket), prev && Number(prev.avg_ticket)),
    },
    retail_revenue: {
      label: t('Vendita prodotti', 'Retail sales'), value: eur(cur.retail_revenue),
      delta: pctDelta(Number(cur.retail_revenue), prev && Number(prev.retail_revenue)),
      sub: Number(cur.revenue) > 0
        ? Math.round(Number(cur.retail_revenue) / Number(cur.revenue) * 100) + '% ' + t('del totale', 'of total')
        : null,
    },
    appointments_count: {
      label: t('Appuntamenti completati', 'Completed appts'), value: String(cur.appointments_count),
      delta: pctDelta(cur.appointments_count, prev?.appointments_count),
    },
    occupancy_pct: {
      label: t('Occupazione', 'Occupancy'), value: Math.round(cur.occupancy_pct) + '%',
      delta: pctDelta(cur.occupancy_pct, prev?.occupancy_pct),
    },
    return_rate: {
      label: t('Tasso di ritorno', 'Return rate'), value: pct(cur.return_rate) + '%',
      delta: pctDelta(cur.return_rate, prev?.return_rate),
    },
    rebooking_rate: {
      label: t('Rebooking', 'Rebooking'), value: pct(cur.rebooking_rate) + '%',
      delta: pctDelta(cur.rebooking_rate, prev?.rebooking_rate),
    },
    noshow_rate: {
      label: t('No-show', 'No-show'), value: pct(cur.noshow_rate) + '%',
      delta: pctDelta(cur.noshow_rate, prev?.noshow_rate), invert: true,
    },
    cancel_rate: {
      label: t('Cancellazioni', 'Cancellations'), value: pct(cur.cancel_rate) + '%',
      delta: pctDelta(cur.cancel_rate, prev?.cancel_rate), invert: true,
    },
    new_clients: {
      label: t('Nuovi clienti', 'New clients'), value: String(cur.new_clients),
      delta: pctDelta(cur.new_clients, prev?.new_clients),
    },
    returning_clients: {
      label: t('Clienti di ritorno', 'Returning clients'), value: String(cur.returning_clients),
      delta: pctDelta(cur.returning_clients, prev?.returning_clients),
    },
    avg_frequency: {
      label: t('Frequenza media', 'Avg frequency'),
      value: Number(cur.avg_frequency).toFixed(1) + ' ' + t('visite/cliente', 'visits/client'),
      delta: pctDelta(cur.avg_frequency, prev?.avg_frequency),
    },
  };
}
