// GridLines — le righe orarie di una colonna (ora piena, mezz'ora, quarti:
// vedi gridMarks), in giorno e settimana. z-index 1: sopra lo sfondo opaco
// delle colonne (prima le copriva), sotto i blocchi (z 2); pointer-events
// none per non disturbare trascinamento e clic. Rimpicciolendo, quarti e
// mezz'ore diventano un reticolo illeggibile: sotto una certa altezza restano
// solo le ore (visibleMarks).
import { GRID_LINE_STYLE, visibleMarks } from '../lib.js';

export default function GridLines({ marks, g0, pxm }) {
  return visibleMarks(marks, pxm)
    .map(({ m, kind }) => <div key={m} style={{ position: 'absolute', left: 0, right: 0, top: (m - g0) * pxm, zIndex: 1, pointerEvents: 'none', ...GRID_LINE_STYLE[kind] }} />);
}
