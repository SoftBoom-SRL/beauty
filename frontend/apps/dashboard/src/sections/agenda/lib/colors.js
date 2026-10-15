// lib/colors.js — il testo leggibile sopra un colore scelto dal salone, e lo
// sfondo delle colonne delle operatrici (opColumnTint). I
// colori li sceglie il salone (operatrici e categorie, vedi seed_demo): con il
// testo sempre scuro, un blocco su un colore scuro (blu notte, bordeaux, o
// l'operatrice quando il servizio non ha categoria) non si leggeva.

import { OP_COLUMN_TINT } from '../constants.js';

/** Lo sfondo della colonna di un'operatrice: il suo colore (OP_COLUMN_TINT %)
 *  su `base` — bianco in giorno, trasparente in settimana, dove sotto c'è la
 *  tinta di oggi. */
export const opColumnTint = (color, base = '#FFFFFF') => `color-mix(in srgb, ${color} ${OP_COLUMN_TINT}%, ${base})`;

// Il testo leggibile sopra un colore vale per tutta la dashboard: sta in
// ui/colorTools.js, qui si riesporta per l'agenda (lib.js) e i suoi test.
export { hexRgb, wantsLightText, inkOn } from '../../../ui/colorTools.js';
