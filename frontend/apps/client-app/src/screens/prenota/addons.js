// addons.js — gli aggiuntivi nella prenotazione della cliente: servizi che si
// fanno durante un altro (la nail art durante la manicure). Da soli non si
// prenotano (il server risponde 422): il listino non li mostra fra i servizi,
// e sotto ogni servizio scelto c'è «Aggiungi» con i suoi. Non allungano la
// visita e vanno, nella richiesta, subito dopo il servizio a cui si
// appoggiano — gli id scelti stanno in quella fila.
// Logica pura, senza React: la caricano anche i test con `node --test`.

/** Fine (esclusa) del gruppo che comincia a `at`: il servizio e gli
 *  aggiuntivi subito dietro. */
function groupEnd(ids, at, isAddon) {
  let end = at + 1;
  while (end < ids.length && isAddon(ids[end])) end += 1;
  return end;
}

/** Sceglie o toglie il servizio `id`; togliendolo se ne vanno anche i suoi
 *  aggiuntivi, che senza di lui resterebbero da soli o appoggiati a un altro. */
export function toggleMain(ids, id, isAddon) {
  const at = ids.indexOf(id);
  if (at < 0) return [...ids, id];
  return [...ids.slice(0, at), ...ids.slice(groupEnd(ids, at, isAddon))];
}

/** Gli aggiuntivi scelti per il servizio `mainId`. */
export function addonsOf(ids, mainId, isAddon) {
  const at = ids.indexOf(mainId);
  return at < 0 ? [] : ids.slice(at + 1, groupEnd(ids, at, isAddon));
}

/** Aggiunge o toglie l'aggiuntivo `addonId` sotto il servizio `mainId`. Una
 *  volta sola per visita: scelto sotto un altro servizio, si sposta qui. */
export function toggleAddon(ids, mainId, addonId, isAddon) {
  if (addonsOf(ids, mainId, isAddon).includes(addonId)) return ids.filter((x) => x !== addonId);
  const rest = ids.filter((x) => x !== addonId);
  const at = rest.indexOf(mainId);
  if (at < 0) return ids;
  const end = groupEnd(rest, at, isAddon);
  return [...rest.slice(0, end), addonId, ...rest.slice(end)];
}

/** Le voci della richiesta: l'operatrice scelta vale per i servizi; un
 *  aggiuntivo va «a chi fa il servizio, se lo sa fare» — lo decide il server
 *  —, così chi non fa la nail art resta prenotabile per la manicure. */
export function bookingItems(ids, operatorId, isAddon) {
  return ids.map((id) => ({ service_id: id, operator_id: isAddon(id) ? null : operatorId }));
}
