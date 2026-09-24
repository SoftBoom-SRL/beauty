// labels.js — etichette bilingui condivise dalle due app: il nome di un
// oggetto del catalogo nella lingua dell'interfaccia.
// Logica pura, senza React: la caricano anche i test con `node --test`.

/** Il nome di un oggetto bilingue ({ name_it, name_en }: servizi, categorie,
 *  pacchetti) nella lingua dell'interfaccia: l'inglese se c'è, altrimenti
 *  l'italiano, anche quando manca (undefined resta undefined).
 *  L'oggetto deve esserci: con null è un TypeError, come nelle copie che
 *  sostituisce. Chi deve reggere l'oggetto mancante scrive
 *  `obj ? nameIn(obj, lang) : ''`. */
export function nameIn(obj, lang) {
  return lang === 'en' && obj.name_en ? obj.name_en : obj.name_it;
}
