// draft.js — la bozza del costruttore e le versioni nuove della regola che
// arrivano mentre la si modifica (logica pura, provata con node --test).
import { rebaseDraft, sameValue } from '../../ui/rebase.js';

// le condizioni hanno id locali (per le key React): nel confronto non contano
const stripIds = (conds) => (conds || []).map(({ id, ...r }) => r);

/** Confronto di un campo della bozza (condizioni senza gli id locali). */
export const sameDraftField = (a, b, k) => (k === 'conds' ? sameValue(stripIds(a), stripIds(b)) : sameValue(a, b));

/**
 * Fonde la bozza `cur` (partita da `oldBase`) con `newBase`, tutte nel formato
 * di initDraft. Vedi rebaseDraft: i campi non toccati seguono il server, quelli
 * in modifica restano, i conflitti si segnalano. Se le condizioni sono le stesse
 * si tengono le righe della bozza, così le loro key non cambiano.
 */
export function mergeRuleDraft(cur, oldBase, newBase) {
  const { draft, conflicts } = rebaseDraft(cur, oldBase, newBase, sameDraftField);
  if (sameDraftField(draft.conds, cur.conds, 'conds')) draft.conds = cur.conds;
  return { draft, conflicts };
}
