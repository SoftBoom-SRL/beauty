// monthLib.js — funzioni pure della vista mensile: griglia del mese, soglie di
// occupazione, filtro per operatrice e riepilogo. Nessun React: facile da testare.
import { minutesOfDay, parseISO, toDateStr } from '@youty/shared';
import { mondayOf } from './lib.js';

/** Soglie di occupazione (minuti prenotati / minuti di turno). Sotto il 60% la
 *  giornata respira, tra 60 e 85 è carica, oltre è di fatto piena: sono le tre
 *  fasce che il titolare vuole leggere a colpo d'occhio. */
export const LOAD_WARN = 0.6;
export const LOAD_FULL = 0.85;

export const LOAD_TONES = {
  off:  { color: 'var(--faint)', tint: 'var(--paper-2)' },
  ok:   { color: 'var(--ok)',    tint: 'var(--ok-tint)' },
  warn: { color: 'var(--warn)',  tint: 'var(--warn-tint)' },
  full: { color: 'var(--clay)',  tint: 'var(--clay-tint)' },
};

/** Rapporto prenotato/capacità; null senza turno (capacità 0). Può superare 1
 *  (prenotazioni forzate fuori turno): chi disegna la barra lo tronca, l'etichetta no. */
export function loadRatio(booked, capacity) {
  if (!capacity) return null;
  return (Number(booked) || 0) / capacity;
}

export function loadTone(ratio) {
  if (ratio == null) return 'off';
  if (ratio > LOAD_FULL) return 'full';
  if (ratio >= LOAD_WARN) return 'warn';
  return 'ok';
}

export const pctLabel = (ratio) => Math.round((ratio || 0) * 100) + '%';

/** Griglia del mese: dal lunedì della prima settimana alla domenica dell'ultima
 *  (5 o 6 settimane, sempre ≤ 42 giorni: il limite dell'endpoint /range).
 *  Ritorna { year, month, start, end, weeks: [[iso × 7], …] }. */
export function monthGrid(anchor) {
  const d0 = parseISO(anchor);
  const year = d0.getFullYear(), month = d0.getMonth();
  const lastDay = new Date(year, month + 1, 0);
  const cur = mondayOf(new Date(year, month, 1));
  const weeks = [];
  while (cur <= lastDay) {
    const w = [];
    for (let i = 0; i < 7; i++) { w.push(toDateStr(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(w);
  }
  return { year, month, start: weeks[0][0], end: weeks[weeks.length - 1][6], weeks };
}

export const EMPTY_DAY = { count: 0, by_status: {}, capacity_min: 0, booked_min: 0, revenue: 0, operators: [], appointments: [] };

/** Restringe un giorno del payload /range alle operatrici selezionate (Set di
 *  id; vuoto = tutte, ritorna l'oggetto originale). I totali seguono le regole
 *  del backend: il no-show non entra nell'incasso e l'appuntamento appartiene
 *  alla sua operatrice principale. */
export function filterDay(day, sel) {
  if (!sel || !sel.size) return day;
  const operators = (day.operators || []).filter((o) => sel.has(o.operator_id));
  const appointments = (day.appointments || []).filter((a) => sel.has(a.operator_id));
  const by_status = {};
  let revenue = 0;
  appointments.forEach((a) => {
    by_status[a.status] = (by_status[a.status] || 0) + 1;
    if (a.status !== 'no_show') revenue += Number(a.total_price || 0);
  });
  return {
    ...day, operators, appointments, by_status, revenue,
    count: appointments.length,
    capacity_min: operators.reduce((s, o) => s + (o.capacity_min || 0), 0),
    booked_min: operators.reduce((s, o) => s + (o.booked_min || 0), 0),
  };
}

/** Riepilogo dei giorni passati (solo quelli del mese, non il riempimento):
 *  totale appuntamenti, occupazione media PESATA (Σ prenotato / Σ capacità,
 *  non la media delle percentuali: un sabato pieno pesa più di un lunedì corto),
 *  incasso atteso e giorno più pieno. */
export function monthSummary(days) {
  let total = 0, capacity = 0, booked = 0, revenue = 0, busiest = null;
  days.forEach((d) => {
    total += d.count || 0;
    capacity += d.capacity_min || 0;
    booked += d.booked_min || 0;
    revenue += Number(d.revenue || 0);
    const r = loadRatio(d.booked_min, d.capacity_min);
    if (r != null && r > 0 && (busiest == null || r > busiest.ratio)) busiest = { date: d.date, ratio: r, count: d.count || 0 };
  });
  return { total, capacity, booked, revenue, ratio: capacity ? booked / capacity : null, busiest };
}

/** Ordine di lettura degli stati: come scorre la giornata, no-show in coda. */
export const STATUS_ORDER = ['confirmed', 'checked_in', 'in_progress', 'closed', 'no_show'];

/** by_status → [[status, n], …] nell'ordine canonico, solo voci > 0. */
export function statusCounts(byStatus) {
  const m = byStatus || {};
  const known = STATUS_ORDER.filter((s) => m[s] > 0).map((s) => [s, m[s]]);
  const extra = Object.entries(m).filter(([s, n]) => n > 0 && !STATUS_ORDER.includes(s));
  return [...known, ...extra];
}

export const sortByStart = (list) => [...(list || [])].sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start));

/** Righe operatrice da mostrare: chi è in turno o ha comunque prenotazioni,
 *  nell'ordine dello staff (`order` del contesto), non in quello del payload. */
export function operatorRows(day, orderIndex) {
  return (day.operators || [])
    .filter((o) => o.capacity_min > 0 || o.booked_min > 0)
    .sort((a, b) => (orderIndex[a.operator_id] ?? 999) - (orderIndex[b.operator_id] ?? 999));
}

/** Data lunga per aria-label e popover ("giovedì 17 settembre" / "Thursday 17 September"). */
export function dayLabel(iso, lang) {
  return parseISO(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}
