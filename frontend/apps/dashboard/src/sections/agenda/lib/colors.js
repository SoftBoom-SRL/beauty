// lib/colors.js — il testo leggibile sopra un colore scelto dal salone, e lo
// sfondo delle colonne delle operatrici (opColumnTint). I
// colori li sceglie il salone (operatrici e categorie, vedi seed_demo): con il
// testo sempre scuro, un blocco su un colore scuro (blu notte, bordeaux, o
// l'operatrice quando il servizio non ha categoria) non si leggeva.

import { OP_COLUMN_TINT } from '../constants.js';
import { inkOn } from '../../../ui/colorTools.js';

/** Lo sfondo della colonna di un'operatrice: il suo colore (OP_COLUMN_TINT %)
 *  su `base` — bianco in giorno, trasparente in settimana, dove sotto c'è la
 *  tinta di oggi. */
export const opColumnTint = (color, base = '#FFFFFF') => `color-mix(in srgb, ${color} ${OP_COLUMN_TINT}%, ${base})`;

// Il testo leggibile sopra un colore vale per tutta la dashboard: sta in
// ui/colorTools.js, qui si riesporta per l'agenda (lib.js) e i suoi test.
export { hexRgb, wantsLightText, inkOn } from '../../../ui/colorTools.js';

/** Una visita conclusa: il conto è chiuso, non è più lavoro da fare. */
export const isDone = (status) => status === 'closed';

/** Come si colora un blocco in agenda (giorno e settimana) col colore del
 *  suo servizio. Da fare: il colore pieno (all'82%) e il testo leggibile
 *  sopra (inkOn). Concluso: il colore appena accennato, il testo spento e un
 *  filo del colore intorno (`ring`), con la spunta che mette chi lo disegna.
 *  Prima una visita chiusa alle 10 e una da fare alle 15 erano identiche, e
 *  per capire che cosa restava della giornata bisognava aprirle (il
 *  titolare, 16/10). */
export function blockLook(color, status) {
  if (isDone(status)) {
    return {
      done: true,
      bg: `color-mix(in srgb, ${color} 20%, #FFFFFF)`,
      ink: { ink: 'var(--ink-2)', sub: 'var(--muted)', chip: 'rgba(17,24,39,0.06)' },
      ring: `inset 0 0 0 1px color-mix(in srgb, ${color} 55%, transparent)`,
    };
  }
  return { done: false, bg: `color-mix(in srgb, ${color} 82%, #FFFFFF)`, ink: inkOn(color, 0.82), ring: null };
}
