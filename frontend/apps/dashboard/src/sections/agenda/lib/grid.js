// lib/grid.js — la geometria delle griglie di giorno e settimana: scala
// (zoom), fascia oraria, righe delle ore, corsie della settimana.
// Logica pura: la caricano anche i test con `node --test`.
import { minutesOfDay, parseISO } from '@youty/shared';
import { DK_END, DK_START, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS } from '../constants.js';
import { aStartMin, apptSpan } from './appt.js';
import { hmToMin } from './calendar.js';

/* Zoom: vedi ZOOM_STEPS in constants.js. */
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1));
/** Passo successivo (dir +1) o precedente (dir −1) a partire da un valore libero. */
export function zoomStep(current, dir) {
  const z = clampZoom(current);
  if (dir > 0) return clampZoom(ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX);
  return clampZoom([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN);
}

/** pack overlapping blocks into side-by-side lanes (week view) — blocks need startMin/endMin */
export function weekLayout(list) {
  const sorted = list.map((a) => ({ ...a })).sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    cluster.forEach((a) => {
      let l = laneEnds.findIndex((e) => e <= a.startMin);
      if (l === -1) { l = laneEnds.length; laneEnds.push(a.endMin); } else laneEnds[l] = a.endMin;
      a._lane = l;
    });
    const lc = Math.max(1, laneEnds.length);
    cluster.forEach((a) => { a._laneCount = lc; out.push(a); });
    cluster = [];
  };
  sorted.forEach((a) => {
    if (cluster.length && a.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(a);
    clusterEnd = Math.max(clusterEnd, a.endMin);
  });
  flush();
  return out;
}

/* ---- Righe orarie delle griglie (vista giorno e settimana) -------------------
 * Il titolare vuole leggere l'ora «a colpo d'occhio»: ora piena marcata,
 * mezz'ora tratteggiata più chiara, quarti appena percettibili e SOLO se il
 * passo dell'agenda è 15' (con passo 30/60 sarebbero rumore). Le righe vanno
 * sempre sotto i blocchi (z-index basso) e non intercettano il puntatore, così
 * non interferiscono con drag e click sugli spazi vuoti. */
export const GRID_LINE_STYLE = {
  hour: { height: 1, background: 'color-mix(in srgb, var(--ink) 14%, transparent)' },
  half: { height: 0, borderTop: '1px dashed color-mix(in srgb, var(--ink) 10%, transparent)' },
  quarter: { height: 1, background: 'color-mix(in srgb, var(--ink) 4%, transparent)' },
};

/* ---- Fascia oraria delle griglie (vista giorno e settimana) -----------------
 * Era fissa, 08:00–20:00: la sposa forzata alle 07:00 non compariva né in
 * giorno né in settimana (il blocco finiva sotto l'intestazione), e con i turni
 * fino alle 21 la fascia 20–21 non si poteva cliccare e un trascinamento la
 * schiacciava alle 19:45. Ora la fascia è quella del giorno: orari del centro e
 * turni, allargata a ore piene per gli appuntamenti e le pause che ci sono
 * davvero. Senza orari né turni si parte dalle 08–20 di sempre.
 * `base` e `extra` = [[da, a], …] in minuti dalla mezzanotte. */
export function gridRange(base, extra = []) {
  const all = [...((base && base.length) ? base : [[DK_START, DK_END]]), ...(extra || [])];
  let lo = Infinity, hi = -Infinity;
  for (const [s, e] of all) {
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (s < lo) lo = s;
    if (e > hi) hi = e;
  }
  if (!Number.isFinite(lo)) return { start: DK_START, end: DK_END };
  const start = Math.max(0, Math.floor(lo / 60) * 60);
  const end = Math.min(24 * 60, Math.max(start + 60, Math.ceil(hi / 60) * 60));
  return { start, end };
}

/** Fascia della vista giorno. `rows` = righe di /agenda/day (turni,
 *  appuntamenti, pause), `opening` = fasce del centro di quel giorno
 *  [["09:00","19:00"], …], `ghost` = appuntamento aperto nel pannello, che su
 *  un altro giorno si disegna in trasparenza e deve restare visibile. */
export function dayGridRange(rows, opening, ghost = null) {
  const base = (opening || []).map(([a, b]) => [hmToMin(a), hmToMin(b)]);
  const extra = [];
  for (const r of rows || []) {
    for (const [a, b] of r.windows || []) base.push([hmToMin(a), hmToMin(b)]);
    for (const a of r.appointments || []) if (a.status !== 'cancelled') extra.push(apptSpan(a));
    for (const p of r.pauses || []) extra.push([aStartMin(p), aStartMin(p) + (p.duration_min || 0)]);
  }
  if (ghost) extra.push(apptSpan(ghost));
  return gridRange(base, extra);
}

/** Fascia della vista settimana: una sola scala per i sette giorni, dagli orari
 *  del centro di tutta la settimana (`openingWeek` = settings.opening_hours_week)
 *  e dagli appuntamenti del payload /agenda/week (`duration_min` = totale). */
export function weekGridRange(days, openingWeek, ghost = null) {
  const base = [];
  for (const ranges of Object.values(openingWeek || {})) {
    for (const [a, b] of ranges || []) base.push([hmToMin(a), hmToMin(b)]);
  }
  const extra = [];
  for (const d of days || []) {
    for (const a of d.appointments || []) {
      const s = minutesOfDay(a.start);
      extra.push([s, s + Math.max(a.duration_min || 0, 1)]);
    }
  }
  if (ghost) extra.push(apptSpan(ghost));
  return gridRange(base, extra);
}

/** Fasce del centro per il giorno "YYYY-MM-DD" (settings.opening_hours_week). */
export function openingFor(settings, dateStr) {
  const week = settings?.opening_hours_week;
  if (!week || !Object.keys(week).length || !dateStr) return [];
  return week[String((parseISO(dateStr).getDay() + 6) % 7)] || [];
}

/** Segni orari da disegnare: [{ m, kind }] con kind ∈ hour | half | quarter,
 *  dalla fascia `start`–`end` (minuti; di norma quella di gridRange). */
export function gridMarks(step, start = DK_START, end = DK_END) {
  const out = [];
  for (let m = start; m <= end; m += 15) {
    if (m % 60 === 0) out.push({ m, kind: 'hour' });
    else if (m % 30 === 0) out.push({ m, kind: 'half' });
    else if (step === 15) out.push({ m, kind: 'quarter' });
  }
  return out;
}
