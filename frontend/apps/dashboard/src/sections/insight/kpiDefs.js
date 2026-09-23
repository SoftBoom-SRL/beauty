// kpiDefs.js — maps GET /api/insights/kpis fields onto the prototype's customizable
// 4-of-N KPI band (`ALL_KPIS` in desktop-insight.jsx). Favorites persist to localStorage.
import { todayStr } from '@youty/shared';

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

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1…12

/**
 * Intervalli per le frecce «vs prec.»: il periodo in corso fino a oggi e lo
 * STESSO TRATTO del periodo precedente (date incluse, per date_from/date_to).
 *
 * Il confronto era col periodo precedente intero: il 22/9 incasso, vendite e
 * appuntamenti dell'1–22 settembre contro tutto agosto, frecce rosse a −25/−30 %
 * a ritmo invariato quasi ogni giorno (08-07). E «oggi» veniva dall'orologio del
 * dispositivo: a cavallo del mese, da un fuso diverso, il periodo era sbagliato.
 * Ora «oggi» è il giorno del salone e il tratto è lo stesso: 1–22 set contro
 * 1–22 ago; nel trimestre, stesso mese e giorno del trimestre precedente;
 * nell'anno, stesso giorno dell'anno prima (il 29/2 diventa il 28).
 */
export function comparisonRanges(period, today = todayStr()) {
  const [y, m, d] = String(today).slice(0, 10).split('-').map(Number);
  let startM = m;
  let prevY = y;
  let prevM;
  if (period === 'quarter') {
    startM = Math.floor((m - 1) / 3) * 3 + 1;
    prevM = startM - 3;
  } else if (period === 'year') {
    startM = 1;
    prevM = 1;
    prevY = y - 1;
  } else {
    prevM = m - 1;
  }
  if (prevM < 1) { prevM += 12; prevY -= 1; }
  let endY = prevY;
  let endM = prevM + (m - startM);
  if (endM > 12) { endM -= 12; endY += 1; }
  return {
    current: { date_from: ymd(y, startM, 1), date_to: ymd(y, m, d) },
    previous: { date_from: ymd(prevY, prevM, 1), date_to: ymd(endY, endM, Math.min(d, daysIn(endY, endM))) },
  };
}

function pctDelta(cur, prev) {
  if (cur == null || prev == null || !isFinite(prev) || prev === 0) return null;
  const d = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  return isFinite(d) ? d : null;
}

/** Build the ALL_KPIS map from real KpisOut payloads. `prev` (optional) is the
 * same shape for the previous period — enables Delta arrows; null hides them.
 * `curCmp` (optional) is the current period up to today: the arrows compare it
 * with `prev` like for like (see comparisonRanges), the values shown stay `cur`. */
export function buildAllKpis(cur, prev, t, lang, eur, curCmp) {
  if (!cur) return {};
  const pct = (n) => Math.round((n || 0) * 100);
  const cc = curCmp || cur;
  return {
    revenue: {
      label: t('Incasso', 'Revenue'), value: eur(cur.revenue),
      delta: pctDelta(Number(cc.revenue), prev && Number(prev.revenue)),
    },
    sales_count: {
      label: t('Vendite', 'Sales'), value: String(cur.sales_count),
      delta: pctDelta(cc.sales_count, prev?.sales_count),
    },
    avg_ticket: {
      label: t('Scontrino medio', 'Avg ticket'), value: eur(cur.avg_ticket),
      delta: pctDelta(Number(cc.avg_ticket), prev && Number(prev.avg_ticket)),
    },
    retail_revenue: {
      label: t('Vendita prodotti', 'Retail sales'), value: eur(cur.retail_revenue),
      delta: pctDelta(Number(cc.retail_revenue), prev && Number(prev.retail_revenue)),
      sub: Number(cur.revenue) > 0
        ? Math.round(Number(cur.retail_revenue) / Number(cur.revenue) * 100) + '% ' + t('del totale', 'of total')
        : null,
    },
    appointments_count: {
      label: t('Appuntamenti completati', 'Completed appts'), value: String(cur.appointments_count),
      delta: pctDelta(cc.appointments_count, prev?.appointments_count),
    },
    occupancy_pct: {
      label: t('Occupazione', 'Occupancy'), value: Math.round(cur.occupancy_pct) + '%',
      delta: pctDelta(cc.occupancy_pct, prev?.occupancy_pct),
    },
    return_rate: {
      label: t('Tasso di ritorno', 'Return rate'), value: pct(cur.return_rate) + '%',
      delta: pctDelta(cc.return_rate, prev?.return_rate),
    },
    rebooking_rate: {
      label: t('Rebooking', 'Rebooking'), value: pct(cur.rebooking_rate) + '%',
      delta: pctDelta(cc.rebooking_rate, prev?.rebooking_rate),
    },
    noshow_rate: {
      label: t('No-show', 'No-show'), value: pct(cur.noshow_rate) + '%',
      delta: pctDelta(cc.noshow_rate, prev?.noshow_rate), invert: true,
    },
    cancel_rate: {
      label: t('Cancellazioni', 'Cancellations'), value: pct(cur.cancel_rate) + '%',
      delta: pctDelta(cc.cancel_rate, prev?.cancel_rate), invert: true,
    },
    new_clients: {
      label: t('Nuovi clienti', 'New clients'), value: String(cur.new_clients),
      delta: pctDelta(cc.new_clients, prev?.new_clients),
    },
    returning_clients: {
      label: t('Clienti di ritorno', 'Returning clients'), value: String(cur.returning_clients),
      delta: pctDelta(cc.returning_clients, prev?.returning_clients),
    },
    avg_frequency: {
      label: t('Frequenza media', 'Avg frequency'),
      value: Number(cur.avg_frequency).toFixed(1) + ' ' + t('visite/cliente', 'visits/client'),
      delta: pctDelta(cc.avg_frequency, prev?.avg_frequency),
    },
  };
}
