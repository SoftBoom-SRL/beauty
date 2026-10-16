// lib/appt.js — l'appuntamento dei payload di giorno e settimana: orari,
// nomi, importi e i blocchi per servizio in cui si disegna.
// Logica pura: la caricano anche i test con `node --test`.
import { fmtEur, minutesOfDay } from '@youty/shared';
import { addonGroups } from './addons.js';

/* ---- appointment helpers (day/week payload objects) ---- */
export const aStartMin = (a) => minutesOfDay(a.start);
export const aDur = (a) => a.total_duration_min ?? a.duration_min ?? 0;
export const aEndMin = (a) => aStartMin(a) + aDur(a);
export const svcLabel = (a) => (a.items || []).map((i) => i.service_name).join(' + ');
export const firstName = (full) => String(full || '').split(' ')[0];
export const lastName = (full) => String(full || '').trim().split(/\s+/).slice(1).join(' ');

/** Nome da mostrare in agenda: solo nome di battesimo; in caso di omonimia tra le
 *  operatrici (`firsts` = pool di nomi) aggiunge l'iniziale del cognome ("Giulia V.").
 *  Il nome completo resta per l'hover (title). */
export function opDisplay(first, last, firsts) {
  const f = String(first || '');
  const clash = (firsts || []).filter((x) => String(x || '').toLowerCase() === f.toLowerCase()).length > 1;
  return clash && last ? `${f} ${String(last)[0].toUpperCase()}.` : f;
}
export const initialsOf = (full) =>
  String(full || '').split(' ').filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** €-format that never says "Gratis" for zero sums.
 *  Lo zero si scrive con i suoi due decimali, come ogni altro importo: «€0»
 *  accanto a «€45,00» nello stesso riepilogo sembrava un dato troncato. */
export const fmtMoney = (n, lang) => (Number(n)
  ? fmtEur(Number(n), lang)
  : '€' + (0).toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Espande un appuntamento in blocchi per-servizio concatenati dallo `start`.
 *  Ogni servizio è un blocco nella colonna della sua operatrice, con orario e
 *  durata propri (la catena riflette chi fa cosa e quando). Gli aggiuntivi
 *  (voci a 0 minuti: la nail art durante la manicure) non sono blocchi: stanno
 *  in `addons` del servizio a cui si appoggiano, e lì si disegnano come
 *  etichetta. Come blocchi alti zero non si vedrebbero, ma trascinamento,
 *  «stacca» e conti degli slot li tratterebbero da servizi veri. `total` = i
 *  blocchi della visita. Ritorna:
 *  [{ item, addons, appt, apptId, startMin, dur, opId, order, index, total, isFirst, isLast }] */
export function itemBlocks(appt) {
  const base = aStartMin(appt);
  const items = [...(appt.items || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const groups = addonGroups(items);
  let cursor = base;
  return groups.map(({ item, addons }, i) => {
    const activeMin = item.duration_min || 0;   // fase attiva (operatrice al lavoro)
    const soakMin = item.soak_min || 0;          // fase di posa (operatrice non impegnata)
    const dur = activeMin + soakMin;             // durata totale per il cliente
    const block = {
      item, addons, appt, apptId: appt.id, startMin: cursor, dur, activeMin, soakMin,
      opId: item.operator_id, order: item.order ?? i, index: i, total: groups.length,
      isFirst: i === 0, isLast: i === groups.length - 1,
    };
    cursor += dur;
    return block;
  });
}

/** Fine di un appuntamento: l'ultimo servizio della catena, posa compresa. */
export const apptSpan = (a) => {
  const s = aStartMin(a);
  const blocks = itemBlocks(a);
  const e = blocks.length ? Math.max(...blocks.map((b) => b.startMin + b.dur)) : s + aDur(a);
  return [s, Math.max(e, s + 1)];
};

/** Incasso atteso nelle testate di giorno e settimana, con la regola del mese
 *  (agenda_range): il no-show non entra. Le testate lo contavano, e lo stesso
 *  giorno valeva un incasso in vista giorno e un altro nel mese. Si somma in
 *  centesimi: i prezzi arrivano come stringhe decimali ("45.10"). */
export function apptRevenue(list) {
  let cents = 0;
  for (const a of list || []) {
    if (a.status === 'no_show' || a.status === 'cancelled') continue;
    cents += Math.round(Number(a.total_price || 0) * 100);
  }
  return cents / 100;
}
