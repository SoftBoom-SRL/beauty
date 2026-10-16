// lib/grid.js — la geometria delle griglie di giorno e settimana: scala
// (zoom), fascia oraria, righe delle ore, corsie della settimana.
// Logica pura: la caricano anche i test con `node --test`.
import { minutesOfDay, parseISO } from '@youty/shared';
import { DEFAULT_SLOT_MIN, DK_END, DK_START, WIDTH_MAX, WIDTH_MIN, WIDTH_STEPS, ZOOM_MAX, ZOOM_MIN, ZOOM_STEPS } from '../constants.js';
import { aStartMin, apptSpan } from './appt.js';
import { dowIndex, hmToMin } from './calendar.js';

/** Granularità delle fasce orarie (Impostazioni → intervallo slot). */
export const slotStep = (settings) => settings?.slot_interval_min || DEFAULT_SLOT_MIN;

/** Appuntamento aperto nel pannello di dettaglio: il suo blocco resta
 *  cerchiato in agenda, così si vede sempre su cosa si sta intervenendo. */
export const openApptIdOf = (modal) => (modal?.name === 'apptdetail' ? (modal.props?.appointment?.id ?? null) : null);

/** Larghezza della scheda di anteprima (ApptHoverCard), con 10 px di stacco
 *  dal blocco e 10 di margine dal bordo della finestra. */
export const HOVER_CARD_W = 300;
const HOVER_ROOM = HOVER_CARD_W + 20;

/** Dove si apre l'anteprima di un appuntamento al passaggio del mouse: a
 *  destra se c'è posto, altrimenti a sinistra; in alto alla sua altezza, ma
 *  mai così in basso da lasciare sotto meno di `clear` px. `rect` =
 *  getBoundingClientRect() del blocco, `view` = la finestra.
 *  `avoid` = il riquadro degli appuntamenti collegati a quello indicato (le
 *  altre parti della visita, la permanenza: avoidRect): la scheda si apre
 *  fuori da lì. Accanto al blocco copriva proprio l'appuntamento collegato
 *  che l'agenda stava evidenziando, nella colonna dopo (il titolare, 16/10).
 *  Se il riquadro non lascia posto né a destra né a sinistra, si torna al
 *  blocco. */
export function hoverPlacement(rect, view, clear, avoid = null) {
  const y = Math.max(8, Math.min(rect.top, view.innerHeight - clear));
  for (const box of avoid ? [avoid, rect] : [rect]) {
    if (box.right + HOVER_ROOM < view.innerWidth) return { x: box.right + 10, y, side: 'right' };
    if (box.left - HOVER_ROOM > 0) return { x: box.left - 10, y, side: 'left' };
  }
  return { x: rect.left - 10, y, side: 'left' };
}

/** Il riquadro che contiene i blocchi degli appuntamenti `ids` dentro `root`
 *  (`[data-appt]`), tagliato alla parte visibile di `root`: un collegato
 *  fuori schermo non deve spingere la scheda fuori dalla finestra. null se
 *  non se ne vede nessuno. */
export function avoidRect(root, ids) {
  if (!root?.querySelectorAll || !ids?.size) return null;
  const clip = root.getBoundingClientRect?.();
  let box = null;
  for (const el of root.querySelectorAll('[data-appt]')) {
    if (!ids.has(Number(el.dataset?.appt))) continue;
    const r = el.getBoundingClientRect();
    const left = clip ? Math.max(r.left, clip.left) : r.left;
    const right = clip ? Math.min(r.right, clip.right) : r.right;
    const top = clip ? Math.max(r.top, clip.top) : r.top;
    const bottom = clip ? Math.min(r.bottom, clip.bottom) : r.bottom;
    if (right <= left || bottom <= top) continue;   // fuori dalla parte visibile
    box = box
      ? { left: Math.min(box.left, left), right: Math.max(box.right, right), top: Math.min(box.top, top), bottom: Math.max(box.bottom, bottom) }
      : { left, right, top, bottom };
  }
  return box;
}

/* Zoom: vedi ZOOM_STEPS in constants.js. */
export const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1));
/** Passo successivo (dir +1) o precedente (dir −1) a partire da un valore libero. */
export function zoomStep(current, dir) {
  const z = clampZoom(current);
  if (dir > 0) return clampZoom(ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_MAX);
  return clampZoom([...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_MIN);
}

/* Larghezza delle colonne: vedi WIDTH_STEPS in constants.js. */
export const clampWidth = (w) => Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(w) || 1));
/** Passo di larghezza successivo (dir +1, più larghe) o precedente (−1). */
export function widthStep(current, dir) {
  const w = clampWidth(current);
  if (dir > 0) return clampWidth(WIDTH_STEPS.find((s) => s > w + 0.001) ?? WIDTH_MAX);
  return clampWidth([...WIDTH_STEPS].reverse().find((s) => s < w - 0.001) ?? WIDTH_MIN);
}

/** La larghezza che fa stare `n` colonne larghe `base` px (a larghezza 1),
 *  separate da `gap` px, in `avail` px: «tutte in vista», senza scorrere di
 *  lato. Mai oltre 1: se ci stanno già, le colonne si allargano da sole fino
 *  a riempire lo spazio. */
export function fitColumns(avail, n, base, gap = 0) {
  if (!(n > 0) || !(base > 0) || !(avail > 0)) return 1;
  return clampWidth(Math.min(1, (avail - gap * (n - 1)) / (n * base)));
}

/** Corsie della vista settimana, per i blocchi sovrapposti di una
 *  sotto-colonna (ognuno con startMin/endMin): `_lane`, `_laneCount` e
 *  `_span`, le corsie che il blocco occupa verso destra.
 *  - I servizi della stessa visita uno dopo l'altro (le parti attaccate, vedi
 *    weekParts) stanno nella stessa corsia, segnati `_joinTop`/`_joinBottom`:
 *    si disegnano attaccati, come una visita sola.
 *  - Un blocco si allarga sulle corsie alla sua destra che nel suo orario sono
 *    libere. Prima tutti i blocchi di un gruppo di sovrapposti avevano la
 *    larghezza di una corsia, anche quello delle 11 che non toccava più
 *    nessuno: nelle sotto-colonne strette restava una striscia senza nome
 *    (il titolare, 16/10). */
export function weekLayout(list) {
  const units = [];
  for (const b of list.map((a) => ({ ...a })).sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin)) {
    const u = units.find((v) => v.id === b.id && v.endMin === b.startMin && b.id != null);
    if (u) { u.members.push(b); u.endMin = b.endMin; } else units.push({ id: b.id, startMin: b.startMin, endMin: b.endMin, members: [b] });
  }
  units.sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    cluster.forEach((u) => {
      let l = laneEnds.findIndex((e) => e <= u.startMin);
      if (l === -1) { l = laneEnds.length; laneEnds.push(u.endMin); } else laneEnds[l] = u.endMin;
      u.lane = l;
    });
    const lc = Math.max(1, laneEnds.length);
    cluster.forEach((u) => {
      let span = 1;
      while (u.lane + span < lc && !cluster.some((v) => v.lane === u.lane + span && v.startMin < u.endMin && v.endMin > u.startMin)) span += 1;
      u.members.forEach((a, k) => {
        Object.assign(a, { _lane: u.lane, _laneCount: lc, _span: span, _joinTop: k > 0, _joinBottom: k < u.members.length - 1 });
        out.push(a);
      });
    });
    cluster = [];
  };
  units.forEach((u) => {
    if (cluster.length && u.startMin >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(u);
    clusterEnd = Math.max(clusterEnd, u.endMin);
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
 * Le griglie coprono la giornata INTERA, 00:00–24:00 (GRID_DAY), come i
 * calendari che si usano tutti i giorni: le ore fuori orario sono tratteggiate
 * e si aprono sulla giornata di lavoro (firstScrollMin). Prima la griglia era
 * stretta sulla giornata di lavoro: tolta la barra alta dell'agenda, ci stava
 * tutta nello schermo e non scorreva più — soprattutto nei giorni senza
 * appuntamenti — e prima delle 9 o dopo le 19 non si poteva né cliccare né
 * trascinare niente. Ancora prima era fissa 08:00–20:00: la sposa forzata
 * alle 07:00 non compariva, e con i turni fino alle 21 la fascia 20–21 non si
 * usava. */
export const GRID_DAY = { start: 0, end: 24 * 60 };

/* La giornata di LAVORO: orari del centro e turni, allargata a ore piene per
 * gli appuntamenti e le pause che ci sono davvero; senza orari né turni le
 * 08–20 di sempre. Dice dove si apre la griglia e che cosa riempie lo
 * schermo con «Adatta».
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

/** Il minuto da mettere in cima alla griglia la prima volta che si apre:
 *  oggi, se la giornata di lavoro `work` ({ start, end }) è in corso, un'ora
 *  prima di adesso (aprendo alle 16 si vedeva la mattina già passata);
 *  altrimenti mezz'ora prima che cominci — non la mezzanotte, ora che la
 *  griglia copre tutte le 24 ore. `nowMin` = null se non è oggi. */
export function firstScrollMin(work, nowMin = null) {
  if (nowMin != null && nowMin >= work.start && nowMin < work.end) return Math.max(0, nowMin - 60);
  return Math.max(0, work.start - 30);
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
  return week[String(dowIndex(parseISO(dateStr)))] || [];
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

/** I segni che si disegnano davvero alla scala `pxm`: rimpicciolendo, quarti
 *  e mezz'ore diventano un reticolo illeggibile, e sotto una certa altezza
 *  restano solo le ore. */
export const visibleMarks = (marks, pxm) =>
  marks.filter(({ kind }) => (kind === 'hour') || (kind === 'half' && 30 * pxm > 12) || (kind === 'quarter' && 15 * pxm > 12));

/* closed (off-shift) intervals within the grid (`g0`–`g1`, minuti), from API windows [["09:00","13:00"],...] */
export function closedIntervals(windows, g0 = DK_START, g1 = DK_END) {
  const win = (windows || []).map(([a, b]) => [hmToMin(a), hmToMin(b)]).sort((x, y) => x[0] - y[0]);
  const out = [];
  let cursor = g0;
  win.forEach(([s, e]) => {
    if (s > cursor) out.push([cursor, Math.min(s, g1)]);
    cursor = Math.max(cursor, e);
  });
  if (cursor < g1) out.push([cursor, g1]);
  return out.filter(([s, e]) => e > s);
}
