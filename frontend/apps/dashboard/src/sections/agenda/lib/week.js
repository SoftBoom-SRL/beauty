// lib/week.js — la vista settimana: sotto-colonne delle operatrici di ogni
// giorno.
// Logica pura: la caricano anche i test con `node --test`.

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
