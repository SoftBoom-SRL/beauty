// lib/week.js — la vista settimana: i giorni pronti da disegnare (sotto-
// colonne delle operatrici, spostamento in corso), l'aggancio ai vicini, la
// richiesta di spostamento, l'ombra dell'appuntamento aperto.
// Logica pura: la caricano anche i test con `node --test`.
import { isoAtMin, minutesOfDay, parseISO, timeLabel } from '@youty/shared';
import { timedItems } from './addons.js';
import { DOW_EN, DOW_IT, hmToMin } from './calendar.js';
import { weekLayout } from './grid.js';

/** Sotto-colonne di un giorno in vista settimana.
 *
 *  Le operatrici della sede attiva — chi non ha sede vale per tutte, la stessa
 *  regola della vista giorno — e in coda chi ha comunque appuntamenti quel
 *  giorno: di un'altra sede o disattivata, col suo nome. La dashboard elenca
 *  solo le attive: il nome di una disattivata arriva dal giorno
 *  (`extra_operators` del payload, qui `extraOps`), e la colonna si chiamava
 *  «Non più in team»; `orphanName` resta per chi non è in nessuno dei due.
 *  Prima c'erano le sotto-colonne delle operatrici di TUTTE le sedi: in
 *  settimana si prenotava a nome di chi lavora altrove.
 *  `appointments` = gli appuntamenti del giorno (payload /agenda/week). */
export function weekDayOps(operators, locationId, appointments, orphanName, extraOps = []) {
  const all = operators || [];
  const base = all.filter((o) => !locationId || o.location_id == null || o.location_id === locationId);
  const known = new Set(base.map((o) => o.id));
  const extra = [];
  for (const a of appointments || []) {
    const id = a.operator_id;
    if (!id || known.has(id)) continue;
    known.add(id);
    const named = extraOps.find((o) => o.id === id);
    extra.push(all.find((o) => o.id === id) || (named && { ...named, inactive: !!named.inactive }) || { id, first_name: orphanName, last_name: '', inactive: true, unknown: true });
  }
  return base.concat(extra);
}

/** La sotto-colonna dove si disegna una visita, col filtro «Team» che spegne
 *  gli id di `off`: quella della principale se è accesa, altrimenti quella
 *  della prima operatrice accesa fra i servizi; null se sono tutte spente.
 *  Scartandola solo per la principale, spegnere Anna faceva sparire anche la
 *  piega di Giulia dentro la visita di Anna (la vista giorno lo evita apposta:
 *  il filtro decide le colonne, non i dati). */
export function weekColumnFor(a, off, known = null) {
  if (!off.has(a.operator_id)) return a.operator_id;
  const others = (a.items || []).map((it) => it.operator_id).filter((id) => id != null && !off.has(id));
  // prima una collega della sede, che la sua colonna ce l'ha già; poi le
  // altre (di un'altra sede, non più in team), che ne ricevono una in coda
  return (known && others.find((id) => known.has(id))) ?? others[0] ?? null;
}

/** La sotto-colonna in cui una visita (o una sua parte) è disegnata. */
export const weekColOf = (a) => a.colOp ?? a.operator_id;

/** Le parti di una visita, una per servizio con tempo (con i suoi
 *  aggiuntivi, che restano col servizio prima): [{ opId, startMin, endMin,
 *  items }], in ordine di catena. Una visita con un servizio solo è una parte
 *  sola.
 *
 *  In settimana una visita con più colleghe era UN blocco nella colonna della
 *  prima: la piega di Giulia dentro la visita di Anna si leggeva sotto Anna, e
 *  si spostava solo tutta insieme (il titolare, 15/10). Poi una parte per
 *  operatrice; ma i servizi accorpati della stessa operatrice (le visite
 *  importate da AreaBeauty, per esempio) restavano un blocco solo, e
 *  trascinandolo si spostava sempre tutta la visita (il titolare, 16/10). Ora
 *  ogni servizio è una parte, nella colonna di chi lo fa, come in vista
 *  giorno: il corpo sposta quel servizio, la barra scura tutta la visita. */
export function weekParts(a) {
  const runs = [];
  let cursor = minutesOfDay(a.start);
  for (const it of a.items || []) {
    const dur = (it.duration_min || 0) + (it.soak_min || 0);
    if (!runs.length || dur > 0) {
      runs.push({ opId: it.operator_id ?? a.operator_id, startMin: cursor, endMin: cursor, items: [] });
    }
    const run = runs[runs.length - 1];
    run.items.push(it);
    cursor += dur;
    run.endMin = cursor;
  }
  return runs;
}

/** I minuti di posa (o di attesa) in fondo a un blocco: quelli del suo
 *  servizio con tempo. In settimana non si vedevano, e la visita sembrava
 *  occupare l'operatrice anche mentre il colore è in posa. */
const soakOf = (items) => timedItems(items).reduce((sum, it) => sum + (it.soak_min || 0), 0);

/** I blocchi da disegnare per la visita `a` del giorno: la visita intera se
 *  ha un servizio solo (nella colonna di weekColumnFor), altrimenti una
 *  parte per servizio (weekParts), saltando quelle delle operatrici spente.
 *  Una parte tiene l'id e l'operatrice principale della visita (servono a
 *  spostarla e ad aprirla), e porta `key`, `part`/`parts`, i suoi servizi in
 *  `items` e quelli di tutta la visita in `visitItems`. `soakMin` = la posa
 *  in fondo al blocco. */
function visitBlocks(a, off, known) {
  const s = minutesOfDay(a.start);
  const runs = weekParts(a);
  if (runs.length < 2) {
    const col = weekColumnFor(a, off, known);
    if (col == null) return [];                         // nessuna delle sue operatrici è accesa
    return [{ ...a, ...(col !== a.operator_id ? { colOp: col } : {}), startMin: s, endMin: s + (a.duration_min || 0), soakMin: soakOf(a.items) }];
  }
  return runs.flatMap((run, k) => (off.has(run.opId) ? [] : [{
    ...a,
    ...(run.opId !== a.operator_id ? { colOp: run.opId } : {}),
    key: `${a.id}:${k}`, part: k + 1, parts: runs.length,
    items: run.items, visitItems: a.items,
    startMin: run.startMin, endMin: run.endMin, soakMin: soakOf(run.items),
  }]));
}

/** La visita spostata in attesa della risposta (`pending` di weekDays), già
 *  al suo inizio nuovo e con i servizi della colonna di partenza passati a
 *  quella d'arrivo, come li scriverà il server. */
function movedVisit(src, pending, date) {
  const from = pending.fromOp ?? src.operator_id;
  const hand = (op) => (op === from && pending.nop != null ? pending.nop : op);
  return {
    ...src,
    start: isoAtMin(date, pending.ns),
    operator_id: hand(src.operator_id),
    ...(src.items ? { items: src.items.map((it) => ({ ...it, operator_id: hand(it.operator_id) })) } : {}),
  };
}

/** I sette giorni del payload /agenda/week pronti da disegnare: `list` =
 *  appuntamenti con startMin/endMin, `dayOps` = sotto-colonne (weekDayOps).
 *  `pending` = { id, dayIdx, ns, nop } dello spostamento in POST: override
 *  ottimistico, l'appuntamento compare già nel giorno/operatrice/orario di
 *  arrivo. `orphanName` = il nome di chi non è più in team. `hidden` = gli id
 *  delle operatrici spente nel filtro «Team»: niente sotto-colonna; una
 *  visita resta finché una delle sue operatrici è accesa, disegnata nella
 *  colonna di quella (`colOp`, solo per il disegno: `operator_id` resta la
 *  principale), e la testata del giorno conta quello che si vede. Senza
 *  filtro con cinque operatrici la domenica usciva dallo schermo. */
export function weekDays(days, pending, operators, locationId, orphanName, hidden = []) {
  const off = new Set(hidden);
  /* I turni (`shifts` del payload): se in settimana qualcuna ha un turno, il
   * salone li usa e ogni sotto-colonna ha il suo (`shift`, null se il server
   * non lo dice); chi quel giorno non ne ha è a riposo o assente. Senza turni
   * in tutta la settimana valgono gli orari del centro, come prima: un salone
   * che i turni non li imposta non deve vedere tutte le colonne «a riposo». */
  const usesShifts = days.some((d) => (d.shifts || []).some((sh) => (sh.windows || []).length > 0));
  // le operatrici della sede attiva: le sotto-colonne che ci sono comunque (weekDayOps)
  const known = new Set((operators || []).filter((o) => !locationId || o.location_id == null || o.location_id === locationId).map((o) => o.id));
  const pendingSrc = pending ? days.flatMap((d) => d.appointments).find((a) => a.id === pending.id) : null;
  return days.map((d, i) => {
    const src = pending ? d.appointments.filter((a) => a.id !== pending.id) : d.appointments;
    const list = src.flatMap((a) => visitBlocks(a, off, known));
    if (pendingSrc && pending.dayIdx === i) {
      list.push(...visitBlocks(movedVisit(pendingSrc, pending, d.date), off, known));
    }
    // una visita a più parti è più blocchi ma un appuntamento solo: le
    // testate contano (e sommano l'incasso de) le visite, non i blocchi
    const seen = new Set();
    const visits = list.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
    // TUTTE le operatrici della sede attiva, ogni giorno, anche dove non hanno
    // niente in agenda: le sotto-colonne sono il posto dove si clicca per
    // prenotare, e disegnarle solo dove c'era già lavoro lasciava i giorni
    // liberi — quelli su cui si prenota di più — senza nulla da cliccare e
    // senza modo di dire a chi.
    // In coda restano le operatrici non più in elenco (disattivate) che hanno
    // ancora appuntamenti: altrimenti il giorno li CONTA ma non li mostra da
    // nessuna parte, e la cliente si presenta a un orario che in agenda non
    // esiste. Vedi weekDayOps. Tranne le spente nel filtro «Team». Le colonne
    // in coda si contano sulla colonna di DISEGNO (weekColOf), non sulla
    // principale: una visita spostata dal filtro su una collega di un'altra
    // sede o non più in team finiva in una colonna che non c'era, contata
    // nella testata e invisibile.
    const shiftOf = new Map((d.shifts || []).map((sh) => [sh.operator_id, { windows: sh.windows || [], absence: sh.absence || null, out: sh.out_of_team || null }]));
    const dayOps = weekDayOps(operators, locationId, list.map((a) => ({ operator_id: weekColOf(a) })), orphanName, d.extra_operators || [])
      .filter((o) => !off.has(o.id))
      .map((o) => {
        const shift = usesShifts ? shiftOf.get(o.id) ?? null : null;
        return { ...o, shift, weight: subcolWeight(list.filter((a) => weekColOf(a) === o.id), !!shift && !shift.windows.length) };
      });
    if (!off.size) return { ...d, list, visits, dayOps, usesShifts };
    // con il filtro la testata del giorno conta quello che si vede
    const by_status = {};
    visits.forEach((a) => { by_status[a.status] = (by_status[a.status] || 0) + 1; });
    return { ...d, list, visits, dayOps, usesShifts, count: visits.length, by_status };
  });
}

/** Quanto si allarga la sotto-colonna di un'operatrice rispetto alle altre
 *  del giorno (flex-grow): 1 se quel giorno non ha appuntamenti, altrimenti
 *  1 + 2 per corsia. Tutte larghe uguali, con nove operatrici e due sole al
 *  lavoro gli appuntamenti stavano in 44 px e i sovrapposti in strisce da
 *  dieci, senza nome, accanto a sette colonne vuote (il titolare, 16/10). Una
 *  colonna vuota resta larga abbastanza per cliccarci e prenotare; in una
 *  giornata piena sono tutte uguali, come prima. Chi quel giorno non lavora
 *  (`resting`: riposo, ferie) e non ha niente in agenda lascia ancora più
 *  posto: lì non si prenota. */
export function subcolWeight(blocks, resting = false) {
  if (!blocks?.length) return resting ? 0.6 : 1;
  const lanes = Math.max(1, ...weekLayout(blocks).map((a) => a._laneCount || 1));
  return 1 + 2 * lanes;
}

/** Colonne fisse (preferenza «Fissa», ViewPrefs): tutte le sotto-colonne
 *  larghe uguali ogni giorno, qualunque sia il lavoro. */
export const fixedColumns = (days) => days.map((d) => ({ ...d, dayOps: d.dayOps.map((o) => ({ ...o, weight: 1 })) }));

/** Chi quel giorno non lavora: un turno senza orari (riposo, ferie…). */
const offShift = (o) => !!o.shift && !o.shift.windows.length;

/** Le preferenze «Chi non è in turno» e «Giorni di chiusura» (ViewPrefs)
 *  sui giorni di weekDays. Con nove operatrici e tre a riposo, le colonne
 *  spente e la domenica chiusa si prendevano lo spazio di chi lavora (il
 *  titolare, 16/10).
 *  - `hideResting`: via le sotto-colonne di chi quel giorno non lavora e
 *    non ha niente in agenda (con i turni, come «Solo chi lavora oggi» in
 *    vista giorno). Restano in `offOps`: l'avviso dello spostamento le
 *    conosce ancora, la testata le conta.
 *  - `hideClosed`: un giorno chiuso (`closedByHours(date)`: gli orari del
 *    centro non hanno fasce; o, con i turni, nessuna in turno) e senza
 *    appuntamenti è `hidden`. Non si disegna ma resta al suo posto
 *    nell'elenco: indici del trascinamento, `data-daycol` e nomi dei giorni
 *    restano quelli dei sette giorni. Se fossero chiusi tutti, si vedono
 *    tutti: una settimana vuota non direbbe niente.
 *  `keep(date)` = gli id delle operatrici che quel giorno restano comunque:
 *  quelle dell'ombra dell'appuntamento aperto, che deve avere dove cadere.
 *  Ogni giorno porta anche `closedHours` e `nobody` per la testata. */
export function trimWeek(days, { hideResting = false, hideClosed = false, closedByHours = () => false, keep = () => [] } = {}) {
  const out = days.map((d) => {
    const kept = new Set(keep(d.date));
    const nobody = !!d.usesShifts && d.dayOps.length > 0 && d.dayOps.every(offShift);
    const closedHours = !!closedByHours(d.date);
    const hidden = hideClosed && (closedHours || nobody) && !d.list.length && !kept.size;
    if (!hideResting || !d.usesShifts) return { ...d, closedHours, nobody, hidden, offOps: [] };
    const busy = new Set(d.list.map(weekColOf));
    const offOps = d.dayOps.filter((o) => offShift(o) && !busy.has(o.id) && !kept.has(o.id));
    const dayOps = offOps.length ? d.dayOps.filter((o) => !offOps.includes(o)) : d.dayOps;
    return { ...d, dayOps, closedHours, nobody, hidden, offOps };
  });
  return out.every((d) => d.hidden) ? out.map((d) => ({ ...d, hidden: false })) : out;
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
  // se stessi: la visita intera, o solo la parte che si sta staccando
  const self = (a) => (d.isPart && !d.whole ? (a.key ?? a.id) === d.key : a.id === d.id);
  for (const a of day.list) {
    if (self(a) || weekColOf(a) !== opId) continue;
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
  // trascinando una parte per la sua barra si sposta tutta la visita: il suo
  // inizio scala di quanto si è mossa la parte
  const body = { start: isoAtMin(day.date, d.isPart ? d.apptStart + (d.ns - d.orig) : d.ns) };
  if (d.nop != null && d.nop !== d.origOp) { body.operator_id = d.nop; body.from_operator_id = d.origOp; }
  if (force) body.force = true;
  return body;
}

/** Il corpo di POST /api/agenda/appointments/{id}/split per una parte
 *  trascinata da sola: i suoi servizi con tempo (gli aggiuntivi li porta il
 *  server), il primo come `item_id`; l'operatrice solo se cambia. null se il
 *  payload non ha gli id dei servizi (allora si sposta la visita). */
export function weekSplitBody(day, d, force) {
  const ids = timedItems(d.obj.items).map((it) => it.id).filter((id) => id != null);
  if (!ids.length) return null;
  const body = { item_id: ids[0], item_ids: ids, start: isoAtMin(day.date, d.ns) };
  if (d.nop != null && d.nop !== d.origOp) body.operator_id = d.nop;
  if (force) body.force = true;
  return body;
}

/** Il motivo per cui un'operatrice quel giorno non lavora, detto in
 *  colonna: le assenze con le parole del pannello Staff (AVAIL_META di
 *  staff/lib.js), «Assente» per «Altro», che in agenda non direbbe niente.
 *  Prima di «nel team dal» e dopo «fino al» (`out`) non è riposo: lo dice. */
export function offLabel(shift, t) {
  if (shift?.out === 'before') return t('Non ancora in team', 'Not on the team yet');
  if (shift?.out === 'after') return t('Non più in team', 'No longer on the team');
  if (shift?.absence === 'vacation') return t('Ferie', 'Vacation');
  if (shift?.absence === 'holiday') return t('Festività', 'Holiday');
  if (shift?.absence) return t('Assente', 'Away');
  return t('Riposo', 'Day off');
}

/** «09:00–13:00 · 14:00–19:00», o il motivo dell'assenza: il turno nella
 *  testata della sotto-colonna. null se il turno non si sa. */
export function shiftText(shift, t) {
  if (!shift) return null;
  if (!shift.windows.length) return offLabel(shift, t);
  return shift.windows.map(([a, b]) => `${a}–${b}`).join(' · ');
}

/** L'avviso del badge quando i blocchi trascinati (movingBlocks) finiscono
 *  fuori dal turno della loro colonna d'arrivo: «Fuori turno», o perché
 *  quel giorno lei non c'è («Riposo», «Ferie»…). null se va bene o se il
 *  turno non si sa. Lo spostamento si fa lo stesso (il 409 si forza, come in
 *  vista giorno): l'avviso c'è perché non lo si faccia senza accorgersene. */
export function weekShiftWarning(blocks, day, t) {
  if (!day?.usesShifts) return null;
  // anche chi a riposo non ha la colonna (trimWeek): il suo turno si sa
  const ops = day.offOps?.length ? day.dayOps.concat(day.offOps) : day.dayOps;
  for (const b of blocks || []) {
    const shift = ops.find((o) => o.id === weekColOf(b))?.shift;
    if (!shift) continue;
    if (!shift.windows.length) return offLabel(shift, t);
    const inside = shift.windows.some(([a, z]) => hmToMin(a) <= b.startMin && b.endMin <= hmToMin(z));
    if (!inside) return t('Fuori turno', 'Off shift');
  }
  return null;
}

/** «Gio 1 · Anna · 10:00»: dove è arrivato lo spostamento (avviso). */
export function whereLabel(dayData, operators, dayIdx, opId, ns, t) {
  const day = dayData[dayIdx];
  const op = operators.find((o) => o.id === opId);
  return `${day ? `${t(DOW_IT[dayIdx], DOW_EN[dayIdx])} ${parseISO(day.date).getDate()} · ` : ''}${op ? op.first_name + ' · ' : ''}${timeLabel(ns)}`;
}

/** Il blocco in trascinamento, già nel giorno/operatrice/orario di arrivo.
 *  Da solo: non è attaccato a niente (`_join…` vengono dalla corsia di
 *  partenza). */
export const movingBlock = (dg) => {
  // la copia si disegna nella colonna d'arrivo
  const { colOp, _joinTop, _joinBottom, ...obj } = dg.obj;
  return { ...obj, operator_id: dg.nop, startMin: dg.ns, endMin: dg.ns + (dg.obj.endMin - dg.obj.startMin) };
};

/** I blocchi che seguono il puntatore: quello premuto o, trascinando la
 *  barra di una visita a più parti, tutte le sue parti, spostate di quanto
 *  si è mossa quella premuta. Le parti della colonna di partenza passano a
 *  quella d'arrivo (come farà il server con `from_operator_id`), le altre
 *  restano alla loro operatrice. Prima viaggiava solo la parte premuta, e
 *  sembrava di spostare un servizio solo. `dayData` = i giorni di weekDays. */
export function movingBlocks(dg, dayData) {
  if (!(dg.whole && dg.isPart)) return [movingBlock(dg)];
  const delta = dg.ns - dg.orig;
  const parts = (dayData[dg.origDayIdx]?.list || []).filter((a) => a.id === dg.id);
  if (!parts.length) return [movingBlock(dg)];
  const moved = parts.map((p) => {
    const col = weekColOf(p);
    return { ...p, colOp: col === dg.origOp ? dg.nop : col, startMin: p.startMin + delta, endMin: p.endMin + delta };
  });
  // attaccate come a riposo: il servizio prima, nella stessa colonna, finisce dove comincia questo
  const touches = (x, y) => x.colOp === y.colOp && x.endMin === y.startMin;
  return moved.map((p) => ({ ...p, _joinTop: moved.some((q) => touches(q, p)), _joinBottom: moved.some((q) => touches(p, q)) }));
}

/** I servizi dell'appuntamento aperto, in fila dalla sua ora: servono a
 *  disegnarne l'ombra sul giorno che si sta guardando. Nell'ordine in cui
 *  arrivano (itemBlocks invece li ordina per `order`), come sempre in
 *  settimana. Gli aggiuntivi no: senza tempo, col minimo di dieci minuti
 *  sarebbero un'ombra di un servizio che non occupa niente. */
export function weekGhostSpans(ghost) {
  if (!ghost) return [];
  let cursor = minutesOfDay(ghost.start);
  return timedItems(ghost.items).map((it, i) => {
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
  // di una parte si mostra tutta la visita, col servizio indicato in evidenza
  ...(a.visitItems ? { items: a.visitItems, focus_item_ids: (a.items || []).map((it) => it.id).filter((id) => id != null) } : {}),
  client: { full_name: a.client_name, phone: a.client_phone },
  total_duration_min: a.duration_min,
});
