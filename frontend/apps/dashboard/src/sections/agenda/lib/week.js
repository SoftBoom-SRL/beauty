// lib/week.js — la vista settimana: i giorni pronti da disegnare (sotto-
// colonne delle operatrici, spostamento in corso), l'aggancio ai vicini, la
// richiesta di spostamento, l'ombra dell'appuntamento aperto.
// Logica pura: la caricano anche i test con `node --test`.
import { isoAtMin, minutesOfDay, parseISO, timeLabel } from '@youty/shared';
import { DOW_EN, DOW_IT } from './calendar.js';

/** Sotto-colonne di un giorno in vista settimana.
 *
 *  Le operatrici della sede attiva — chi non ha sede vale per tutte, la stessa
 *  regola della vista giorno — e in coda chi ha comunque appuntamenti quel
 *  giorno: di un'altra sede (col suo nome) o non più in team (`orphanName`).
 *  Prima c'erano le sotto-colonne delle operatrici di TUTTE le sedi: in
 *  settimana si prenotava a nome di chi lavora altrove.
 *  `appointments` = gli appuntamenti del giorno (payload /agenda/week). */
export function weekDayOps(operators, locationId, appointments, orphanName) {
  const all = operators || [];
  const base = all.filter((o) => !locationId || o.location_id == null || o.location_id === locationId);
  const known = new Set(base.map((o) => o.id));
  const extra = [];
  for (const a of appointments || []) {
    const id = a.operator_id;
    if (!id || known.has(id)) continue;
    known.add(id);
    extra.push(all.find((o) => o.id === id) || { id, first_name: orphanName, last_name: '', inactive: true });
  }
  return base.concat(extra);
}

/** I sette giorni del payload /agenda/week pronti da disegnare: `list` =
 *  appuntamenti con startMin/endMin, `dayOps` = sotto-colonne (weekDayOps).
 *  `pending` = { id, dayIdx, ns, nop } dello spostamento in POST: override
 *  ottimistico, l'appuntamento compare già nel giorno/operatrice/orario di
 *  arrivo. `orphanName` = il nome di chi non è più in team. `hidden` = gli id
 *  delle operatrici spente nel filtro «Team»: niente sotto-colonna, e i loro
 *  appuntamenti (in settimana una visita sta nella colonna dell'operatrice
 *  principale) non si contano nella testata del giorno. Senza filtro con
 *  cinque operatrici la domenica usciva dallo schermo. */
export function weekDays(days, pending, operators, locationId, orphanName, hidden = []) {
  const off = new Set(hidden);
  const pendingSrc = pending ? days.flatMap((d) => d.appointments).find((a) => a.id === pending.id) : null;
  return days.map((d, i) => {
    const src = pending ? d.appointments.filter((a) => a.id !== pending.id) : d.appointments;
    const list = src
      .filter((a) => !off.has(a.operator_id))
      .map((a) => { const s = minutesOfDay(a.start); return { ...a, startMin: s, endMin: s + (a.duration_min || 0) }; });
    if (pendingSrc && pending.dayIdx === i) {
      list.push({ ...pendingSrc, operator_id: pending.nop, startMin: pending.ns, endMin: pending.ns + (pendingSrc.duration_min || 0) });
    }
    // TUTTE le operatrici della sede attiva, ogni giorno, anche dove non hanno
    // niente in agenda: le sotto-colonne sono il posto dove si clicca per
    // prenotare, e disegnarle solo dove c'era già lavoro lasciava i giorni
    // liberi — quelli su cui si prenota di più — senza nulla da cliccare e
    // senza modo di dire a chi.
    // In coda restano le operatrici non più in elenco (disattivate) che hanno
    // ancora appuntamenti: altrimenti il giorno li CONTA ma non li mostra da
    // nessuna parte, e la cliente si presenta a un orario che in agenda non
    // esiste. Vedi weekDayOps. Tranne le spente nel filtro «Team».
    const dayOps = weekDayOps(operators, locationId, list, orphanName).filter((o) => !off.has(o.id));
    if (!off.size) return { ...d, list, dayOps };
    // con il filtro la testata del giorno conta quello che si vede
    const by_status = {};
    list.forEach((a) => { by_status[a.status] = (by_status[a.status] || 0) + 1; });
    return { ...d, list, dayOps, count: list.length, by_status };
  });
}

/* Aggancio al vicino, come in vista giorno: con trattamenti che non cadono
 * sulle fasce (venti minuti, venticinque) lo scatto alla griglia lasciava
 * sempre un ritaglio invendibile fra un appuntamento e l'altro. Qui i vicini
 * sono gli appuntamenti della sotto-colonna `opId` del giorno `day` (uno di
 * weekDays): ci si attacca sotto la loro fine o sopra il loro inizio.
 * `tol` = snapTolerance del passo (lib/drag.js). */
export function weekBestSnap(rawMin, day, opId, d, tol) {
  if (!day) return null;
  const span = Math.max(0, d.obj.endMin - d.obj.startMin);
  let best = null;
  const consider = (min, label) => {
    const dist = Math.abs(min - rawMin);
    if (dist > tol || (best && dist >= best.dist)) return;
    best = { min, dist, label };
  };
  for (const a of day.list) {
    if (a.id === d.id || a.operator_id !== opId) continue;
    consider(a.endMin, a.client_name);                 // ci si attacca sotto
    consider(a.startMin - span, a.client_name);        // ci si attacca sopra
  }
  return best;
}

/** Il rilascio cambia qualcosa: orario, giorno o operatrice. */
export const weekDropChanged = (d) => d.ns !== d.orig || d.dayIdx !== d.origDayIdx || d.nop !== d.origOp;

/** Il corpo di POST /api/agenda/appointments/{id}/move per il rilascio `d`
 *  sul giorno `day`: l'operatrice (con quella di partenza) solo se cambia,
 *  `force` solo quando si forza. */
export function weekMoveBody(day, d, force) {
  const body = { start: isoAtMin(day.date, d.ns) };
  if (d.nop != null && d.nop !== d.origOp) { body.operator_id = d.nop; body.from_operator_id = d.origOp; }
  if (force) body.force = true;
  return body;
}

/** «Gio 1 · Anna · 10:00»: dove è arrivato lo spostamento (avviso). */
export function whereLabel(dayData, operators, dayIdx, opId, ns, t) {
  const day = dayData[dayIdx];
  const op = operators.find((o) => o.id === opId);
  return `${day ? `${t(DOW_IT[dayIdx], DOW_EN[dayIdx])} ${parseISO(day.date).getDate()} · ` : ''}${op ? op.first_name + ' · ' : ''}${timeLabel(ns)}`;
}

/** Il blocco in trascinamento, già nel giorno/operatrice/orario di arrivo. */
export const movingBlock = (dg) => ({ ...dg.obj, operator_id: dg.nop, startMin: dg.ns, endMin: dg.ns + (dg.obj.endMin - dg.obj.startMin) });

/** I servizi dell'appuntamento aperto, in fila dalla sua ora: servono a
 *  disegnarne l'ombra sul giorno che si sta guardando. Nell'ordine in cui
 *  arrivano (itemBlocks invece li ordina per `order`), come sempre in
 *  settimana. */
export function weekGhostSpans(ghost) {
  if (!ghost) return [];
  let cursor = minutesOfDay(ghost.start);
  return (ghost.items || []).map((it, i) => {
    const dur = (it.duration_min || 0) + (it.soak_min || 0);
    const span = { key: it.id ?? i, opId: it.operator_id ?? ghost.operator_id, startMin: cursor, dur: Math.max(10, dur) };
    cursor += dur;
    return span;
  });
}

/* Il payload della settimana è più compatto di quello del giorno: qui si
 * riporta alla forma che la scheda di anteprima già sa leggere, così la
 * scheda resta una sola per le due viste. */
export const hoverShape = (a) => ({
  ...a,
  client: { full_name: a.client_name, phone: a.client_phone },
  total_duration_min: a.duration_min,
});
