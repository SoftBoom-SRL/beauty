// lib/team.js — quali colonne disegna la vista giorno: le operatrici scelte nel
// filtro «Team» e, con «Solo chi lavora oggi», quelle che oggi hanno qualcosa
// in agenda. Con nove operatrici in salone e tre di riposo, le colonne vuote
// si prendevano un terzo della larghezza e la griglia scorreva di lato.

/** Le operatrici che il giorno lavorano: un turno, una pausa o un servizio
 *  loro, anche dentro la visita di una collega. Il payload elenca una visita
 *  una volta sola, nella riga dell'operatrice principale: guardando solo le
 *  righe, la colonna di chi fa la piega dentro la visita di un'altra spariva, e
 *  con lei il blocco. */
export function workingOperatorIds(rows) {
  const ids = new Set();
  for (const r of rows || []) {
    const own = r.operator?.id;
    if ((r.windows || []).length) ids.add(own);
    for (const p of r.pauses || []) ids.add(p.operator_id ?? own);
    for (const a of r.appointments || []) {
      if (a.status === 'cancelled') continue;
      ids.add(a.operator_id ?? own);
      for (const it of a.items || []) if (it.operator_id != null) ids.add(it.operator_id);
    }
  }
  return ids;
}

/** Le righe da disegnare. `vis` = { id: false } per le spente nel filtro (un
 *  id che manca è acceso); `onlyWorking` nasconde chi oggi non lavora, tranne
 *  gli id di `keep` (l'operatrice dell'appuntamento aperto nel pannello: la
 *  sua ombra deve avere una colonna dove cadere). */
export function visibleDayRows(rows, vis, { onlyWorking = false, keep = [] } = {}) {
  const working = onlyWorking ? workingOperatorIds(rows) : null;
  if (working) keep.forEach((id) => working.add(id));
  return (rows || []).filter((r) => (vis || {})[r.operator.id] !== false && (!working || working.has(r.operator.id)));
}

/** Le operatrici che il filtro «Solo chi lavora oggi» sta nascondendo (fra
 *  quelle accese a mano): il filtro le segna «a riposo» e le conta, perché
 *  una colonna che manca non sembri un errore. */
export function restingIds(rows, vis, keep = []) {
  const working = workingOperatorIds(rows);
  keep.forEach((id) => working.add(id));
  return (rows || []).filter((r) => (vis || {})[r.operator.id] !== false && !working.has(r.operator.id)).map((r) => r.operator.id);
}
