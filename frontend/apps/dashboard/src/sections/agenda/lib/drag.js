// lib/drag.js — i conti del trascinamento in griglia: dove arriva il blocco
// (fasce, aggancio ai vicini, durata), che esito avrebbe il rilascio, che
// cosa si manda al padre e dove si disegna ogni blocco nel frattempo.
// Stavano dentro DayGrid e WeekView e leggevano le variabili del render: si
// potevano provare solo attraverso il DOM finto. Qui sono funzioni pure, con
// quello che serve passato per argomento; il DOM (rettangoli, puntatore,
// scroll) resta nei componenti.
// Logica pura: la caricano anche i test con `node --test`.
import { aStartMin, firstName, itemBlocks } from './appt.js';
import { hmToMin } from './calendar.js';
import { explainSlot } from './slots.js';

/* ---- comuni a giorno e settimana ------------------------------------------ */

/* ---- Aggancio ai vicini --------------------------------------------------
 * Le fasce dell'agenda sono di 15 minuti, i trattamenti no: un servizio da 20
 * finisce alle 09:20 e il blocco trascinato sotto si fermava alle 09:15 o alle
 * 09:30, lasciando ogni volta un buco che nessuno può vendere. Qui, oltre alla
 * griglia, si guardano i BORDI di quello che c'è nella colonna: la fine di ciò
 * che sta sopra (ci si attacca di testa), l'inizio di ciò che sta sotto (ci si
 * attacca di coda), la fine della fase attiva di un colore in posa — dove
 * l'operatrice è libera davvero — e gli estremi del turno. Se uno di questi è
 * più vicino della tolleranza, vince sulla griglia: il blocco si incastra.
 */
// Tolleranza un filo sotto la metà della fascia: abbastanza da "chiamare" il
// blocco, non tanto da rubare le posizioni normali della griglia.
export const snapTolerance = (step) => Math.min(8, Math.max(4, Math.floor(step / 2) - 1));  // minuti

/** Spostamento verticale del trascinamento: dal puntatore (d.cy) più quanto è
 *  scorsa la griglia da quando è cominciato (`scrollTop` = quello di adesso).
 *  Scorrendo con la rotella il puntatore sta fermo, ma sotto di lui passa un
 *  altro orario: senza lo scroll il blocco si staccava dal puntatore. */
export const dragDy = (d, scrollTop) => d.cy - d.startY + (scrollTop - (d.startScroll || 0));

/* ---- Scorrimento automatico ai bordi ---------------------------------------
 * Il puntatore catturato dalla griglia non fa scorrere niente da solo: per
 * portare un blocco alle 18 quando lo schermo arriva alle 17 bisognava
 * lasciarlo, scorrere e riprenderlo, e trascinandolo verso il fondo restava
 * mezzo fuori vista. Vicino al bordo (dentro la griglia, `zone` px) la griglia
 * scorre da sola, piano sul limite della fascia e più svelta verso il bordo. */
export const EDGE_ZONE = 48;      // px dal bordo in cui comincia a scorrere
export const EDGE_MAX = 16;       // px per fotogramma sul bordo
/* Fotogrammi (~200 ms) col puntatore fermo nella fascia prima di cominciare:
 * un blocco preso vicino al bordo alto faceva scorrere la griglia appena lo
 * si muoveva, e anche solo attraversando la fascia per arrivare alla
 * striscia dei giorni la giornata saltava di un'ora. */
export const EDGE_DELAY_FRAMES = 12;

/** Di quanti px scorrere in un fotogramma col puntatore in `p` (x o y), in
 *  un'area che va da `lo` a `hi`: negativo verso `lo`, positivo verso `hi`,
 *  0 lontano dai bordi. Fuori dall'area niente: lì il puntatore indica altro
 *  (l'intestazione, la striscia dei giorni sopra la griglia). */
export function edgeSpeed(p, lo, hi, zone = EDGE_ZONE, max = EDGE_MAX) {
  if (!(p >= lo && p <= hi)) return 0;
  const z = Math.min(zone, (hi - lo) / 4);   // in un'area bassa le due fasce non si toccano
  if (z <= 0) return 0;
  const pull = (dist) => Math.max(1, Math.round(max * ((z - dist) / z) ** 2));
  if (p < lo + z) return -pull(p - lo);
  if (p > hi - z) return pull(hi - p);
  return 0;
}

/** Dove sta il badge che segue il puntatore (cx, cy): in basso a destra, ma
 *  sopra il puntatore vicino al fondo della finestra e a sinistra vicino al
 *  bordo destro. Trascinando verso l'ultima ora sullo schermo — proprio dove
 *  la griglia scorre da sola — il badge finiva fuori dalla finestra, e con
 *  lui l'orario d'arrivo. `view` = { innerWidth, innerHeight }. */
export function badgeSpot(cx, cy, view) {
  const w = view?.innerWidth ?? Infinity, h = view?.innerHeight ?? Infinity;
  return {
    ...(cy + 18 + 44 > h ? { bottom: h - cy + 14 } : { top: cy + 18 }),
    ...(cx + 18 + 320 > w ? { right: w - cx + 14 } : { left: cx + 18 }),
  };
}

/** Orario d'arrivo di un blocco trascinato: la fascia più vicina a `rawMin`,
 *  oppure l'aggancio `snap` (vince sulla griglia), dentro la fascia oraria
 *  `g0`–`g1`. `head` e `tail` = quanto di quello che si muove sta prima e
 *  dopo l'inizio del blocco preso (vedi dragReach): tutto deve restare fra
 *  `g0` e `g1`. Ora che la griglia arriva a mezzanotte, una visita di un'ora
 *  e tre quarti portata in fondo finiva alle «25:30». Ritorna anche
 *  l'aggancio da mostrare nel badge: solo se sposta davvero il blocco
 *  rispetto alla fascia. */
export function snapStart(rawMin, step, snap, g0, g1, { head = 0, tail = step } = {}) {
  let ns = Math.round(rawMin / step) * step;
  const shown = snap && snap.min !== ns ? snap : null;
  if (snap) ns = snap.min;
  return { ns: Math.max(g0 + head, Math.min(g1 - Math.max(step, tail), ns)), snap: shown };
}

/** Quanto si muove insieme al blocco preso in vista giorno, prima (`head`) e
 *  dopo (`tail`) il suo inizio: il servizio staccato o la pausa da soli; la
 *  visita intera con tutti i suoi servizi, anche quelli delle colleghe, che
 *  slittano con lei. */
export function dragReach(d) {
  if (d.kind === 'pause') return { head: 0, tail: d.obj.duration_min || 0 };
  if (d.detach) return { head: 0, tail: d.block.dur || 0 };
  const blocks = itemBlocks(d.block.appt);
  if (!blocks.length) return { head: 0, tail: d.block.dur || 0 };
  return {
    head: Math.max(0, d.orig - Math.min(...blocks.map((b) => b.startMin))),
    tail: Math.max(...blocks.map((b) => b.startMin + b.dur)) - d.orig,
  };
}

/* Nessuno slot è vietato: fuori turno, sovrapposizione e fase di posa sono
 * AVVISI, non divieti. Chi sta al banco incastra dove vuole — il rilascio
 * «non valido» finisce in onInvalidDrop, che scrive lo stesso forzando — e il
 * rosso raccontava un blocco che non esiste. Il tono massimo è l'ambra. */
export const verdictTone = (v) => (!v ? '' : v.ok && v.code !== 'soak' ? 'ok' : 'warn');

/* ---- vista giorno ---------------------------------------------------------- */

/** Quello che i conti della vista giorno leggono: TUTTE le righe del giorno
 *  (`rows`, anche delle colonne spente dalle chip: un appuntamento è elencato
 *  una volta sola, nella riga della principale, ma i suoi servizi possono
 *  essere di altre), le operatrici con i loro servizi (`operators`, da
 *  useDash), il passo, l'ora attuale (solo oggi) e `t`. */
export function dayDragContext({ rows, operators, step, nowMin, t }) {
  return {
    rows, operators, step, nowMin, t,
    // tutti i blocchi-servizio del giorno (ogni appuntamento compare una volta nel payload)
    blocks: rows.flatMap((r) => r.appointments).flatMap((a) => itemBlocks(a)),
    pauses: rows.flatMap((r) => r.pauses),
    rowOf: (opId) => rows.find((r) => r.operator.id === opId),
    snapTol: snapTolerance(step),
  };
}

/** Nome di battesimo dell'operatrice della colonna `opId`. */
export const opFirstName = (ctx, opId) => firstName(ctx.rowOf(opId)?.operator?.name || '');

/* Abilitazione al servizio (Staff → servizi dell'operatrice). Il server
 * rifiuta con un 400 la riassegnazione a chi non è abilitata: meglio dirlo
 * durante il trascinamento, quando si può ancora scegliere un'altra colonna.
 * Se l'elenco manca (payload vecchio) non si blocca niente. */
export function canDo(operators, opId, serviceId) {
  const op = (operators || []).find((x) => x.id === opId);
  if (!op || !Array.isArray(op.service_ids) || !op.service_ids.length) return true;
  return op.service_ids.includes(serviceId);
}

export function skillVerdict(ctx, opId, blocks) {
  const { t } = ctx;
  const bad = blocks.find((b) => !canDo(ctx.operators, opId, b.item.service_id));
  if (!bad) return null;
  return {
    ok: false, code: 'skill',
    label: t(`${opFirstName(ctx, opId)} non fa ${bad.item.service_name}`, `${opFirstName(ctx, opId)} does not do ${bad.item.service_name}`),
    detail: t('Abilita il servizio in Staff', 'Enable the service in Staff'),
  };
}

/** I bordi della colonna `opId` a cui ci si può agganciare trascinando `d`
 *  (vedi snapTolerance): fine e inizio dei servizi (e della loro fase attiva,
 *  se c'è posa), delle pause e del turno. Quello che si sta trascinando non
 *  conta: il servizio staccato, la visita intera o la pausa. */
export function snapAnchors(ctx, opId, d) {
  const { t } = ctx;
  const out = [];
  const skip = (b) => (d.kind !== 'item' ? false : d.detach ? b.item.id === d.itemId : b.apptId === d.apptId);
  for (const b of ctx.blocks) {
    if (b.opId !== opId || skip(b)) continue;
    out.push({ min: b.startMin + b.dur, side: 'after', label: b.item.service_name });
    if (b.soakMin > 0) out.push({ min: b.startMin + b.activeMin, side: 'after', label: t(`posa di ${b.item.service_name}`, `${b.item.service_name} soak`) });
    out.push({ min: b.startMin, side: 'before', label: b.item.service_name });
  }
  for (const p of ctx.pauses) {
    if (p.operator_id !== opId || (d.kind === 'pause' && p.id === d.id)) continue;
    const ps = aStartMin(p);
    out.push({ min: ps + (p.duration_min || 0), side: 'after', label: t('pausa', 'break') });
    out.push({ min: ps, side: 'before', label: t('pausa', 'break') });
  }
  (ctx.rowOf(opId)?.windows || []).forEach(([a, b]) => {
    out.push({ min: hmToMin(a), side: 'after', label: t('inizio turno', 'shift start') });
    out.push({ min: hmToMin(b), side: 'before', label: t('fine turno', 'shift end') });
  });
  return out;
}

/** Quanto occupa, in colonna, quello che si sta trascinando. */
export function dragSpan(d) {
  if (d.kind === 'pause') return d.obj.duration_min || 0;
  if (d.detach) return d.block.dur || 0;
  const group = itemBlocks(d.block.appt).filter((b) => b.opId === d.origOp);
  if (!group.length) return d.block.dur || 0;
  return Math.max(...group.map((b) => b.startMin + b.dur)) - Math.min(...group.map((b) => b.startMin));
}

/** Fine agganciata più vicina a `rawEnd` (allungando un blocco): ci si ferma
 *  dove comincia quello che sta sotto, senza lasciare un ritaglio invendibile. */
export function bestSnapEnd(ctx, rawEnd, d, opId) {
  let best = null;
  for (const a of snapAnchors(ctx, opId, d)) {
    if (a.side !== 'before') continue;
    const dist = Math.abs(a.min - rawEnd);
    if (dist > ctx.snapTol || (best && dist >= best.dist)) continue;
    best = { min: a.min, dist, label: a.label, side: 'before' };
  }
  return best;
}

/** Inizio agganciato più vicino a `rawMin`, o null se nessuno è abbastanza vicino. */
export function bestSnap(ctx, rawMin, d, opId) {
  const span = dragSpan(d);
  let best = null;
  for (const a of snapAnchors(ctx, opId, d)) {
    const start = a.side === 'after' ? a.min : a.min - span;
    const dist = Math.abs(start - rawMin);
    if (dist > ctx.snapTol) continue;
    if (!best || dist < best.dist) best = { min: start, dist, label: a.label, side: a.side };
  }
  return best;
}

/* Esito dello spostamento di una visita intera: tutti i servizi slittano di
 * `delta` minuti e quelli della colonna `origOp` passano a `nop`. */
export function visitVerdict(ctx, appt, delta, origOp, nop) {
  const { t, nowMin } = ctx;
  // Cambio di colonna: cambiano mano i servizi della colonna di PARTENZA —
  // quelli che la spina tiene insieme lì — mentre quelli affidati ad altre
  // colleghe restano dove sono (stessa regola del server, from_operator_id).
  const moved = itemBlocks(appt).filter((b) => b.opId === origOp);
  if (nop !== origOp) {
    const skill = skillVerdict(ctx, nop, moved);
    if (skill) return skill;
  }
  let warn = null;
  for (const b of itemBlocks(appt)) {
    const opId = b.opId === origOp ? nop : b.opId;
    const row = ctx.rowOf(opId);
    if (!row) continue;
    // `nowMin` anche qui: senza, il badge del drag diceva «Disponibile» su un
    // orario già passato mentre il menu sullo stesso slot lo vietava.
    const r = explainSlot(row, b.startMin + delta, b.activeMin || b.dur, { excludeApptId: appt.id, sameClientId: appt.client?.id ?? null, nowMin, t, rows: ctx.rows });
    if (!r.ok) return r;
    if (r.code === 'soak') warn = r;
  }
  return warn || { ok: true, code: 'ok', label: t('Disponibile', 'Available'), detail: '' };
}

/* esito del rilascio, calcolato sui dati in pagina (stesse regole del backend) */
export function validateDrag(ctx, d) {
  const { t, nowMin } = ctx;
  if (!d || d.mode === 'resize') return null;
  if (d.kind === 'pause') {
    const row = ctx.rowOf(d.nop);
    return row ? explainSlot(row, d.ns, d.obj.duration_min, { excludePauseId: d.id, t, rows: ctx.rows }) : null;
  }
  const appt = d.block.appt;
  if (d.detach) {
    // Si muove solo questo servizio: validarlo come se si spostasse tutta la
    // visita dava un verdetto su uno spostamento che non sta avvenendo, e lo
    // stacco veniva rifiutato senza che succedesse niente.
    const row = ctx.rowOf(d.nop);
    if (!row) return null;
    if (d.nop !== d.origOp) {
      const skill = skillVerdict(ctx, d.nop, [d.block]);
      if (skill) return skill;
    }
    return explainSlot(row, d.ns, d.block.activeMin || d.block.dur, {
      excludeItemId: d.itemId, sameClientId: appt.client?.id ?? null, nowMin, t, rows: ctx.rows,
    });
  }
  return visitVerdict(ctx, appt, d.ns - d.orig, d.origOp, d.nop);
}

/** Ridimensionamento (bordo inferiore di un servizio o di una pausa): la
 *  durata nuova dal dy del puntatore (vedi dragDy), a passi di 5 minuti o
 *  agganciata al vicino. Ritorna { ndur, snap, moved } da scrivere nel
 *  trascinamento. */
export function resizeStep(ctx, d, dy, pxm) {
  const rawDur = d.origDur + dy / pxm;
  // Un tocco sulla maniglia non cambia niente: arrotondata ai 5 minuti (o
  // agganciata a un vicino) la durata cambiava senza che nessuno l'avesse
  // chiesto, e partiva il PUT.
  const still = Math.abs(rawDur - d.origDur) < 2.5;
  let nd = still ? d.origDur : Math.round(rawDur / 5) * 5;
  // anche allungando ci si attacca al vicino: la fine del blocco (posa
  // compresa) va a combaciare con l'inizio di quello che c'è sotto
  const soak = d.block?.soakMin || 0;
  // La pausa non ha `block`: leggere d.block.opId dava un TypeError a ogni
  // movimento, e la pausa pranzo non si allungava più.
  const opId = d.kind === 'pause' ? d.obj.operator_id : d.block.opId;
  const snap = still ? null : bestSnapEnd(ctx, d.orig + rawDur + soak, d, opId);
  let shown = null;
  if (snap) {
    const snapped = snap.min - d.orig - soak;
    if (snapped >= 5) { nd = snapped; shown = snap; }
  }
  // Nessun tetto alla fine della griglia: un servizio che finisce dopo la
  // griglia (salone aperto fino alle 21, incastro serale) veniva accorciato
  // fino al bordo — bastava toccare la maniglia. Il limite è la mezzanotte.
  nd = Math.max(5, Math.min(24 * 60 - d.orig - soak, nd));
  return { ndur: nd, snap: shown, moved: d.moved || Math.abs(dy) > 2 };
}

/* Rilascio dentro la griglia: spostamento, stacco o pausa. Intenzione di
 * spostamento, calcolata una volta sola: la usa il ramo valido e viene
 * passata anche al rilascio non valido, così il padre può offrire «Sposta
 * comunque» (POST con force) senza rifare i conti. null = niente si muove. */
export function dropIntent(d) {
  if (d.ns === d.orig && d.nop === d.origOp) return null;
  if (d.kind === 'item' && d.detach) {
    return { kind: 'split', appt: d.block.appt, item: d.block.item, startMin: d.ns, opId: d.nop };
  }
  if (d.kind === 'item') {
    // la visita si sposta così che il servizio trascinato finisca dove lasciato;
    // in un'altra colonna cambiano mano i servizi della colonna di partenza
    const appt = d.block.appt;
    const newApptStart = d.apptStart + (d.ns - d.orig);
    return { kind: 'appt', appt, newApptStart, opArg: d.nop, fromOp: d.origOp };
  }
  return { kind: 'pause', pause: d.obj, startMin: d.ns, opId: d.nop };
}

/* posizione: ghost del drag attivo > override ottimistico (pending) > valore server */
export function itemPosition(block, d, pending) {
  const phases = { activeMin: block.activeMin, soakMin: block.soakMin };
  if (d && d.kind === 'item' && d.apptId === block.apptId && d.mode !== 'resize' && d.moved) {
    if (d.detach) {
      // stacco: gli altri servizi della visita restano dove sono
      if (d.itemId !== block.item.id) return { startMin: block.startMin, opId: block.opId, ...phases };
      // `detach`: il servizio sta lasciando la visita (niente spina che lo leghi)
      return { startMin: d.ns, opId: d.nop, ...phases, dragging: true, detach: true, verdict: d.verdict };
    }
    // sposta tutti i blocchi della stessa visita del delta trascinato; quelli
    // della colonna di partenza seguono anche il cambio di operatrice
    const startMin = d.itemId === block.item.id ? d.ns : block.startMin + (d.ns - d.orig);
    const opId = block.opId === d.origOp ? d.nop : block.opId;
    return { startMin, opId, ...phases, dragging: true, verdict: d.verdict };
  }
  if (d && d.kind === 'item' && d.mode === 'resize' && d.apptId === block.apptId) {
    // durante il resize cambia SOLO il tempo attivo; la posa resta
    if (d.itemId === block.item.id) return { startMin: block.startMin, opId: block.opId, activeMin: d.ndur, soakMin: block.soakMin, resizing: true };
    // I servizi di una visita sono concatenati: allungando il primo, quelli
    // dopo slittano. Lasciandoli fermi l'anteprima mostrava una visita che il
    // server non avrebbe mai scritto (e una finta sovrapposizione).
    if (block.startMin > d.orig) return { startMin: block.startMin + (d.ndur - d.origDur), opId: block.opId, ...phases };
    return { startMin: block.startMin, opId: block.opId, ...phases };
  }
  if (pending && pending.kind === 'appt' && pending.id === block.apptId) {
    const opId = pending.fromOp != null && block.opId === pending.fromOp ? pending.opId : block.opId;
    return { startMin: pending.startMin + (block.startMin - aStartMin(block.appt)), opId, ...phases };
  }
  return { startMin: block.startMin, opId: block.opId, ...phases };
}

export function pausePosition(p, d, pending) {
  if (d && d.kind === 'pause' && d.id === p.id && d.mode !== 'resize' && d.moved) return { startMin: d.ns, opId: d.nop, dragging: true, verdict: d.verdict };
  if (d && d.kind === 'pause' && d.id === p.id && d.mode === 'resize') return { startMin: aStartMin(p), opId: p.operator_id, dur: d.ndur, resizing: true };
  if (pending && pending.kind === 'pause' && pending.id === p.id) return { startMin: pending.startMin, opId: pending.opId, dur: pending.dur };
  return { startMin: aStartMin(p), opId: p.operator_id };
}

/** Che cosa dice il badge che segue il cursore: durata, orario d'inizio e
 *  quanti servizi cambiano mano.
 *  Uno STACCO muove un servizio solo: durata della visita intera, orario
 *  d'inizio della visita e nome dell'operatrice di partenza annunciavano
 *  tutt'altro rispetto a quel che sarebbe arrivato al server («Anna
 *  13:15-14:45» per un 14:00-14:45 su Giulia). */
export function dragBadge(d) {
  const detach = d.kind === 'item' && !!d.detach;
  const durMin = d.kind === 'pause' ? d.obj.duration_min
    : detach ? d.block.dur
      : (d.block.appt.total_duration_min || d.block.dur);
  const start = (d.kind === 'pause' || detach) ? d.ns : d.apptStart + (d.ns - d.orig);
  // Quanti servizi cambiano mano: trascinando la spina di una visita
  // divisa fra due colleghe si muove il gruppo di QUESTA colonna, e senza
  // dirlo sembrava che partisse tutta la visita.
  const group = d.kind === 'item' && !detach
    ? itemBlocks(d.block.appt).filter((b) => b.opId === d.origOp).length
    : 1;
  const moving = d.kind === 'item' && !detach && group < (d.block.appt.items || []).length;
  return { detach, durMin, start, group, moving };
}
