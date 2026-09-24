// lib.js — la facciata degli aiuti dell'agenda (griglie, appuntamenti, slot,
// lista d'attesa, anteprime). Il codice vive in lib/*.js, un modulo per
// argomento, e nei file accanto (constants.js, lanes.js); qui si riesporta
// tutto con i nomi di sempre: componenti e test importano da questo file, e
// spostare una funzione fra i moduli non tocca chi la usa.
// Solo logica pura: i moduli di lib/ non importano api (il sostituto di
// '@youty/shared' dei test non ce l'ha) né React.

export {
  DK_START, DK_END, PXM, ZOOM_STEPS, ZOOM_MIN, ZOOM_MAX, COLW, AGENDA_LIVE_RE,
} from './constants.js';

export {
  aStartMin, aDur, aEndMin, svcLabel, firstName, lastName, opDisplay, initialsOf, fmtMoney,
  itemBlocks, apptRevenue, opSegments,
} from './lib/appt.js';

export {
  MONTHS_IT, MONTHS_EN, DOW_IT, DOW_EN, hmToMin, mondayOf, addMonths, plausibleDate,
} from './lib/calendar.js';

export {
  clampZoom, zoomStep, weekLayout, GRID_LINE_STYLE, gridRange, dayGridRange, weekGridRange, openingFor, gridMarks,
} from './lib/grid.js';

export { moveIsNoop, ghostBlockAt, moveHereTarget, explainSlot } from './lib/slots.js';

export { prefLabel, apptOperatorIds, wlMatches, wlRank, wlDaysWaiting, wlWhatsAppMsg } from './lib/waitlist.js';

export { noShowSteps, lateCancel, cancelSteps } from './lib/flowSteps.js';

export { weekDayOps } from './lib/week.js';

/** "YYYY-MM-DD" + minuti → ISO8601 dell'istante, nel fuso del SALONE.
 *  Riesportato da @youty/shared: costruirlo con lo scarto del dispositivo
 *  faceva creare appuntamenti spostati di ore da una postazione su un altro
 *  fuso — si sceglievano le 10:00 e ne arrivavano al server altre. */
export { isoAtMin } from '@youty/shared';

// Geometria delle corsie e delle spine: sta in lanes.js, senza import, per
// poterla provare da sola (vedi apps/dashboard/test/lanes.test.js).
export { laneLayout, laneCss, visitSpines, serviceBands, COL_GUTTER } from './lanes.js';
