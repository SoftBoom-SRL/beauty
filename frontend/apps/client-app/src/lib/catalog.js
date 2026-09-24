// catalog.js — il listino pubblico visto dalla cliente: nomi nella sua
// lingua, icona della categoria, durata di un servizio.
// Logica pura, senza React: la caricano anche i test con `node --test`.
import { nameIn } from '@youty/shared';

/** Bilingual name for public catalog objects ({name_it, name_en}); '' senza
 *  oggetto (nameIn da solo, con null, sarebbe un TypeError). */
export function svcLangName(obj, lang) {
  return obj ? nameIn(obj, lang) : '';
}

/** Icona della categoria dal nome: unghie, capelli, viso, il resto. */
export function catIcon(name = '') {
  const n = String(name).toLowerCase();
  if (/(unghi|nail|mani|pedic)/.test(n)) return 'sparkle';
  if (/(capell|hair|piega|taglio)/.test(n)) return 'scissors';
  if (/(viso|face|skin|pelle)/.test(n)) return 'drop';
  return 'star';
}

/** Minuti di un servizio del listino pubblico: lavoro + posa (contratto C4).
 *  L'app chiamava «Durata» il solo lavoro: colore 60' + 40' di posa si
 *  leggeva «1h», e l'agenda la teneva 1h 40' (09-07). Senza `soak_min` (backend
 *  vecchio) resta la sola durata. */
export function svcMinutes(sv) {
  return (Number(sv?.duration_min) || 0) + (Number(sv?.soak_min) || 0);
}
