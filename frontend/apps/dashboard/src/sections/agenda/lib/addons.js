// lib/addons.js — gli aggiuntivi: servizi che si fanno DURANTE un altro (la
// nail art durante la manicure, il massaggio ai piedi durante la pedicure).
// Nella visita la loro voce dura 0 minuti, senza posa: aggiunge il prezzo, non
// il tempo, e si appoggia al servizio prima di lei (le regole sono quelle del
// server, apps/agenda/services/addons.py). Qui quello che serve per mostrarli
// e comporli: in griglia nessun blocco, ma un'etichetta «+ Nail art» dentro il
// blocco del suo servizio; nel dettaglio e nella nuova prenotazione sotto il
// servizio, mai da soli né in testa.
// Logica pura e SENZA import: la usa anche lanes.js, che non ne ha, e la
// caricano i test con `node --test`.

/** Una voce della visita senza tempo: un aggiuntivo. Lo 0 dev'essere un
 *  numero: '' è il campo della durata svuotato mentre si scrive. */
export const isAddonItem = (it) => !!it && it.duration_min === 0 && !(Number(it.soak_min) > 0);

/** Un servizio del listino che è un aggiuntivo. */
export const isAddonService = (s) => !!s?.is_addon;

/** Una riga di una bozza (pannello di dettaglio, nuova prenotazione): conta
 *  il segno `addon` messo quando la riga nasce. Dedotto dalla durata, un
 *  servizio di cui si riscrive la durata («0» battuto per sbaglio) diventerebbe
 *  un aggiuntivo a metà frase, e il campo sparirebbe sotto le dita. */
export const isAddonRow = (row) => !!row && (row.addon ?? isAddonItem(row));

/** Le voci con tempo, cioè quelle che in griglia sono un blocco. */
export const timedItems = (items) => (items || []).filter((it) => it && !isAddonItem(it));

/** Le voci in gruppi, nell'ordine della catena: [{ item, addons }], ogni
 *  servizio con gli aggiuntivi che gli vengono dietro. `isAddon` dice chi è un
 *  aggiuntivo (di serie: le voci senza tempo). Un aggiuntivo in testa (una
 *  visita che il server oggi non accetterebbe) va col primo servizio, per non
 *  sparire dalla vista. */
export function addonGroups(items, isAddon = isAddonItem) {
  const groups = [];
  const orphans = [];
  for (const it of items || []) {
    if (!it) continue;
    if (!isAddon(it)) groups.push({ item: it, addons: [] });
    else if (groups.length) groups[groups.length - 1].addons.push(it);
    else orphans.push(it);
  }
  if (groups.length && orphans.length) groups[0].addons.unshift(...orphans);
  return groups;
}

/* ---- righe di una bozza (pannello di dettaglio, nuova prenotazione) -------
 * Le righe stanno in fila come la catena: ogni servizio seguito dai suoi
 * aggiuntivi. Le funzioni qui sotto tengono quell'ordine, che è anche quello
 * che arriva al server (un aggiuntivo va dopo il servizio a cui si appoggia). */

/** Fine (esclusa) del pezzo che comincia alla riga `at`: lei e, se è un
 *  servizio, gli aggiuntivi subito dietro. */
function pieceEnd(rows, at) {
  let end = at + 1;
  if (!isAddonRow(rows[at])) while (end < rows.length && isAddonRow(rows[end])) end += 1;
  return end;
}

/** `row` (un aggiuntivo) dopo il servizio `parentKey` e gli aggiuntivi che ha
 *  già. Senza quel servizio le righe restano com'erano. */
export function insertAddonRow(rows, parentKey, row) {
  const at = (rows || []).findIndex((r) => r.key === parentKey);
  if (at < 0) return rows;
  const end = pieceEnd(rows, at);
  return [...rows.slice(0, end), { ...row, addon: true }, ...rows.slice(end)];
}

/** Toglie la riga `key`; se è un servizio, anche i suoi aggiuntivi: si fanno
 *  durante lui, e rimasti soli (o in testa) il server li rifiuterebbe. */
export function removeRowWithAddons(rows, key) {
  const at = (rows || []).findIndex((r) => r.key === key);
  if (at < 0) return rows;
  return [...rows.slice(0, at), ...rows.slice(pieceEnd(rows, at))];
}

/** Cambia chi fa la riga `key`. Se è un servizio, gli aggiuntivi che faceva
 *  la stessa persona la seguono, quando li sa fare (`canDo(serviceId, opId)`):
 *  la nail art la fa chi fa la manicure. Quelli che non sa fare restano a chi
 *  li aveva. */
export function setRowOperator(rows, key, opId, canDo = () => true) {
  const at = (rows || []).findIndex((r) => r.key === key);
  if (at < 0) return rows;
  const was = rows[at].operator_id ?? null;
  const out = rows.slice();
  out[at] = { ...rows[at], operator_id: opId };
  if (isAddonRow(rows[at])) return out;
  const end = pieceEnd(rows, at);
  for (let i = at + 1; i < end; i += 1) {
    const r = rows[i];
    if ((r.operator_id ?? null) === was && (opId == null || canDo(r.service_id, opId))) out[i] = { ...r, operator_id: opId };
  }
  return out;
}

/** Indice del servizio con tempo prima della riga `index` (-1 se nessuno):
 *  l'attesa prima di un servizio si scrive su di lui, non sulla nail art che
 *  sta in mezzo, che senza tempo deve restare. */
export function prevTimedIndex(rows, index) {
  for (let i = index - 1; i >= 0; i -= 1) if (!isAddonRow(rows[i])) return i;
  return -1;
}

/** Indice del servizio con tempo dopo la riga `index` (-1 se nessuno). */
export function nextTimedIndex(rows, index) {
  for (let i = index + 1; i < (rows || []).length; i += 1) if (!isAddonRow(rows[i])) return i;
  return -1;
}

/** Le righe di una prenotazione nuova da un elenco di servizi («Rifai la
 *  visita»): ogni aggiuntivo va dietro al servizio prima di lui; quelli in
 *  testa, senza un servizio a cui appoggiarsi, restano fuori. `mkRow(id)` fa
 *  la riga, `isAddon(id)` dice chi è un aggiuntivo. */
export function bookingRows(ids, isAddon, mkRow) {
  const rows = [];
  for (const id of ids || []) {
    if (!isAddon(id)) rows.push(mkRow(id));
    else if (rows.length) rows.push({ ...mkRow(id), addon: true });
  }
  return rows;
}
