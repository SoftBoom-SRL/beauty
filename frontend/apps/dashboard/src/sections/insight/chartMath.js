// chartMath.js — calcoli dei grafici di Analisi dati (logica pura, provata con
// node --test).

/**
 * Occupazione per giorno della settimana: minimo, massimo e «giorno più
 * scarico» contati SOLO sui giorni aperti. Un giorno senza capacità (salone
 * chiuso, nessun turno) arriva con `occupancy_pct: null` (contratto C10): prima
 * era 0, indistinguibile da «aperto e vuoto», e il lunedì di chiusura risultava
 * sempre «il giorno più scarico» (15-14), spingendo a promuovere un giorno in
 * cui non si lavora.
 */
export function occupancyStats(rows) {
  const open = (rows || []).filter((r) => r.occupancy_pct != null);
  if (!open.length) return { lo: null, hi: null, quietest: null, open };
  const vals = open.map((r) => Number(r.occupancy_pct));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const quietest = open.reduce((a, r) => (Number(r.occupancy_pct) < Number(a.occupancy_pct) ? r : a), open[0]);
  return { lo, hi, quietest, open };
}
