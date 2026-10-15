// lib/stay.js — la «permanenza» di una cliente: i suoi appuntamenti dello
// stesso giorno, uno dopo l'altro (al più STAY_GAP_MIN minuti fra la fine
// di uno e l'inizio del seguente). Mani alle 10 con Sole e piedi alle 11 con
// Mara sono due appuntamenti, ma per la cliente è una visita e il conto è
// uno: l'agenda li lega (segno e evidenza) e la cassa li mette già insieme
// nel conto. Stessa regola del server (apps/agenda/services/stay.py).
// Logica pura: la caricano anche i test con `node --test`.
import { minutesOfDay, timeLabel } from '@youty/shared';

export const STAY_GAP_MIN = 30;
const INACTIVE = new Set(['cancelled', 'no_show']);

/** Le permanenze degli appuntamenti `list` (di un giorno): Map id → { ids,
 *  index, size } solo per chi ne ha almeno un altro. `clientOf`, `startOf` e
 *  `endOf` (minuti del giorno) leggono l'appuntamento nella forma del payload. */
export function stayIndex(list, { clientOf, startOf, endOf }) {
  const byClient = new Map();
  const seen = new Set();
  for (const a of list || []) {
    if (!a || INACTIVE.has(a.status) || seen.has(a.id)) continue;   // le parti della settimana: una volta
    seen.add(a.id);
    const c = clientOf(a);
    if (c == null) continue;
    if (!byClient.has(c)) byClient.set(c, []);
    byClient.get(c).push(a);
  }
  const out = new Map();
  for (const arr of byClient.values()) {
    arr.sort((x, y) => startOf(x) - startOf(y) || x.id - y.id);
    let cluster = [];
    let end = -Infinity;
    const flush = () => {
      if (cluster.length < 2) return;
      const ids = cluster.map((c) => c.id);
      cluster.forEach((c, index) => out.set(c.id, { ids, index, size: cluster.length }));
    };
    for (const a of arr) {
      if (cluster.length && startOf(a) <= end + STAY_GAP_MIN) {
        cluster.push(a);
        end = Math.max(end, endOf(a));
      } else {
        flush();
        cluster = [a];
        end = endOf(a);
      }
    }
    flush();
  }
  return out;
}

const startMin = (a) => minutesOfDay(a.start);
const endMin = (a) => minutesOfDay(a.start) + (a.total_duration_min ?? a.duration_min ?? 0);

/** Gli appuntamenti della vista giorno (AppointmentOut, con `client.id`) o
 *  della settimana (payload compatto, con `client_id`). */
export const dayStays = (list) => stayIndex(list, {
  clientOf: (a) => a.client?.id ?? a.client_id ?? null,
  startOf: startMin,
  endOf: endMin,
});

/** Le altre visite (della stessa cliente, dello stesso giorno: «other-visits»
 *  della cassa) nella stessa permanenza di `main`: la cassa le mette già nel
 *  conto unico. */
export function stayMateIds(main, others) {
  if (!main) return [];
  const index = stayIndex([main, ...(others || [])], { clientOf: () => 'cliente', startOf: startMin, endOf: endMin });
  const mine = index.get(main.id);
  return mine ? mine.ids.filter((id) => id !== main.id) : [];
}

/** Le altre visite della permanenza di `id`, da leggere nell'anteprima:
 *  «11:00 Piega · Mara». `list` = gli appuntamenti (interi) del giorno o
 *  della settimana; `opNameOf(id)` il nome dell'operatrice quando la voce
 *  non lo porta (payload della settimana). */
export function stayMatesLabels(stays, list, id, opNameOf = () => '') {
  const mine = stays.get(id);
  if (!mine) return [];
  const byId = new Map();
  for (const a of list || []) if (!byId.has(a.id)) byId.set(a.id, a);
  return mine.ids.filter((x) => x !== id && byId.has(x)).map((x) => {
    const a = byId.get(x);
    const items = (a.visitItems ?? a.items ?? []).filter((it) => it.service_name);
    const services = items.map((it) => it.service_name).join(' + ');
    const ops = [...new Set(items.map((it) => (it.operator_name || opNameOf(it.operator_id) || '').split(' ')[0]).filter(Boolean))].join(', ');
    return `${timeLabel(minutesOfDay(a.start))} ${services}${ops ? ' · ' + ops : ''}`;
  });
}

/** Gli appuntamenti da evidenziare insieme: la permanenza di quello aperto e
 *  di quello sotto il puntatore. */
export const linkedIds = (stays, ...ids) => new Set(ids.flatMap((id) => (id != null && stays.get(id)?.ids) || []));
