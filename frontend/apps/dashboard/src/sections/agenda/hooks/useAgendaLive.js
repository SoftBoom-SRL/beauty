// useAgendaLive — quando un'altra postazione tocca l'agenda, si ricarica
// (una volta per raffica di eventi: `delayMs` dopo l'ultimo).
// Il cleanup NON deve annullare il debounce: `live` cambia identità a ogni
// evento ricevuto e la consegna aggiorna lo stato PRIMA di chiamare gli
// ascoltatori, quindi l'effetto si smontava subito dopo aver programmato il
// timer e lo cancellava — il ricarico non partiva MAI e la griglia restava
// ferma sui dati di quando si era aperto il giorno. Il timer vive in una ref
// e si spegne solo allo smontaggio.
// Gli eventi sono quelli di AGENDA_LIVE_RE (constants.js).
import { useEffect, useRef } from 'react';
import { AGENDA_LIVE_RE } from '../constants.js';

/** `onEvents()` parte `delayMs` dopo l'ultimo evento che conta; ci si
 *  riscrive quando cambia `live` o `onEvents` (chi chiama lo tiene stabile
 *  con useCallback, sulle stesse dipendenze di sempre). */
export function useAgendaLive(live, onEvents, delayMs) {
  const timer = useRef(null);
  useEffect(() => {
    if (!live?.subscribe) return undefined;
    return live.subscribe(({ events }) => {
      if (!events.some((e) => AGENDA_LIVE_RE.test(e.type))) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => onEvents(), delayMs);
    });
  }, [live, onEvents, delayMs]);
  useEffect(() => () => clearTimeout(timer.current), []);
}
