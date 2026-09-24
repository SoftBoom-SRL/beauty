// labels.js — etichette bilingui condivise dalle due app: il nome di un
// oggetto del catalogo nella lingua dell'interfaccia, i nomi dei mesi e dei
// giorni della settimana.
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

/* ---- mesi e giorni ----
 * Mese 0 = gennaio (come Date.getMonth(); da salonDateParts: month - 1).
 * Giorno 0 = LUNEDÌ, come nell'API (weekday 0 = lunedì); da un Date:
 * (d.getDay() + 6) % 7. Le tabelle sono congelate: le condividono tutte le
 * sezioni, e una che ne modificasse una cambierebbe le etichette delle altre. */

/** «Gennaio» … «Dicembre», con la maiuscola (titoli del mese, calendari). */
export const MONTHS_LONG_IT = Object.freeze(['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre']);
export const MONTHS_LONG_EN = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);
/** «gen» … «dic», minuscoli come si scrivono dentro una data («3 set 2026»). */
export const MONTHS_SHORT_IT = Object.freeze(['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']);
export const MONTHS_SHORT_EN = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
/** «Lun» … «Dom», dal lunedì. */
export const WEEKDAYS_SHORT_IT = Object.freeze(['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom']);
export const WEEKDAYS_SHORT_EN = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
