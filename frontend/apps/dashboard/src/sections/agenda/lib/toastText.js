// lib/toastText.js — i testi degli avvisi dopo un gesto in agenda
// (spostamenti, stacco, pause, ripristino, «torna indietro»). Erano
// composti dentro i gesti, fra una chiamata e l'altra, e lo stesso «giorno,
// ora» era riscritto a ogni avviso: qui si leggono e si provano da soli.
// Icona, «Annulla» e momento dell'avviso restano a chi lo manda.
// Logica pura: la caricano anche i test con `node --test`.
import { fmtDateIt, timeLabel } from '@youty/shared';
import { firstName } from './appt.js';
import { dayTimeLabel } from './calendar.js';

/** Spostamento in vista giorno (anche «Sposta qui» e il rilascio su un altro
 *  giorno della striscia): dove è arrivata la visita. `opName` = chi la
 *  prende, se cambia (`reassigned`); `date` = il giorno d'arrivo. */
export function movedText(t, { opName, reassigned, otherDay, date, startMin }) {
  // Su un altro giorno l'avviso lo dice: «Spostato alle 10:00» a chi ha
  // appena portato la cliente da martedì a giovedì non spiegava niente.
  const when = otherDay ? dayTimeLabel(date, startMin, t) : timeLabel(startMin);
  return reassigned
    ? t(`Spostato a ${opName}, ${when}`, `Moved to ${opName}, ${when}`)
    : otherDay
      ? t('Spostato a ' + when, 'Moved to ' + when)
      : t('Spostato alle ' + when, 'Moved to ' + when);
}

/** Stacco di un servizio (le forbici), anche su un altro giorno. */
export function splitText(t, serviceName, { otherDay, date, startMin }) {
  const when = otherDay ? dayTimeLabel(date, startMin, t) : timeLabel(startMin);
  return t(`${serviceName} staccato alle ${when}`, `${serviceName} detached at ${when}`);
}

export const pauseMovedText = (t, startMin) => t('Pausa spostata alle ' + timeLabel(startMin), 'Break moved to ' + timeLabel(startMin));

/** Pausa aggiunta dal menu dello slot; `opFirst` = il nome dell'operatrice. */
export const breakAddedText = (t, opFirst, startMin) =>
  t(`Pausa aggiunta · ${firstName(opFirst)} alle ${timeLabel(startMin)}`, `Break added · ${firstName(opFirst)} at ${timeLabel(startMin)}`);

/** Slot «da richiamare» rimesso in agenda. */
export const restoredText = (t, clientName) =>
  t(`Appuntamento di ${firstName(clientName)} ripristinato`, `${firstName(clientName)}'s appointment restored`);

/** Spostamento in vista settimana: `where` = whereLabel (lib/week.js). */
export const weekMovedText = (t, where) => t('Spostato · ', 'Moved · ') + where;

/** Spostamento dal pannello di dettaglio (ora, giorno o «Passa a»): il
 *  giorno si scrive solo se cambia. `who` = l'operatrice che la prende. */
export function panelMovedText(t, { reassigned, who, day, baseDate, target }) {
  const when = day === baseDate ? timeLabel(target) : `${fmtDateIt(day)} · ${timeLabel(target)}`;
  return reassigned
    ? t(`Passato a ${who?.first_name || ''}, ${when}`, `Moved to ${who?.first_name || ''}, ${when}`)
    : t(`Spostato · ${when}`, `Moved · ${when}`);
}

/* ---- «torna indietro» ---- */
/** `label` = la voce annullata, come la scrive il server. */
export const undoneText = (t, label) => t('Annullato · ' + label, 'Undone · ' + label);
/** Il server risponde 404: la voce non c'è più (già annullata, o scaduta). */
export const nothingToUndoText = (t) => t('Non c\'è più niente da annullare', 'Nothing left to undo');
