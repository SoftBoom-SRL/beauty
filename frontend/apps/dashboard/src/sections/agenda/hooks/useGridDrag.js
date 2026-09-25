// useGridDrag — il trascinamento comune a giorno e settimana: lo stato
// mutabile del gesto, Esc che lo annulla, la fine del gesto e il clic da
// sopprimere dopo un rilascio. Dove arriva il blocco e che cosa fa il
// rilascio restano alle viste (lib/drag.js, lib/week.js).
import { useEffect, useRef, useState } from 'react';
import { useLatest } from './useLatest.js';

/** `onStop(false)`: chiamato quando il gesto finisce o si annulla con Esc (la
 *  vista giorno spegne la striscia dei giorni). `windowUpRef`: la ref
 *  dell'ultimo onUp della vista; se c'è, pointerup e pointercancel si
 *  ascoltano anche su window, così il trascinamento non resta mai «appeso»
 *  quando la cattura del puntatore non è supportata o il rilascio avviene
 *  fuori dall'area (la passano giorno e settimana).
 *  Ritorna { drag, justDragged, force, otherPointer, endDrag, onCancel, markDropped }. */
export function useGridDrag({ onStop, windowUpRef = null } = {}) {
  /* Il gesto in corso è un oggetto MUTABILE (drag.current), aggiornato a ogni
   * movimento del puntatore, e `force` ridisegna: tenerlo nello stato
   * vorrebbe dire un oggetto nuovo per ogni pointermove. */
  const drag = useRef(null);
  const justDragged = useRef(false);   // sopprime il click che segue un rilascio
  const [, force] = useState(0);
  const onStopRef = useLatest(onStop);
  /* Un secondo dito sul tablet non prende il trascinamento in corso: prima lo
   * spostava e al primo sollevamento lo rilasciava. Si tiene il puntatore che
   * ha cominciato (pointerId) e i suoi soli eventi. */
  const otherPointer = (e) => {
    const d = drag.current;
    return !!(d && e && e.pointerId != null && d.pointerId != null && e.pointerId !== d.pointerId);
  };

  /* Smontata a metà gesto (un altro giorno o un'altra vista da tastiera, un
   * aggiornamento che rimonta la griglia): il gesto finisce anche per chi lo
   * guardava da fuori, o la striscia dei giorni restava accesa come bersaglio
   * di un trascinamento che non c'era più. */
  useEffect(() => () => {
    document.body.classList.remove('dk-dragging');
    if (drag.current) { drag.current = null; onStopRef.current?.(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* Esc annulla il drag in corso. `preventDefault` è il contratto di
   * ui/layers.js: quell'Esc è del trascinamento, e il pannello di dettaglio
   * aperto sotto non deve chiudersi insieme a lui. In cattura, così arriva
   * prima di chi ascolta su `window` e guarda `defaultPrevented` subito (il
   * drawer della prenotazione). Gli eventi di un altro dito non chiudono il
   * trascinamento (vedi otherPointer). */
  useEffect(() => {
    const cancel = () => {
      drag.current = null;
      document.body.classList.remove('dk-dragging');
      onStopRef.current?.(false);   // la striscia dei giorni torna normale
      force((x) => x + 1);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    if (!windowUpRef) return () => window.removeEventListener('keydown', onKey, true);
    const onWinUp = (e) => { if (drag.current && !otherPointer(e)) windowUpRef.current?.(e); };
    const onWinCancel = (e) => { if (drag.current && !otherPointer(e)) cancel(); };
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinCancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinCancel);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Il gesto finisce: si toglie e si ridisegna; ritorna quello che c'era. */
  function endDrag() {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('dk-dragging');
    onStop && onStop(false);
    force((x) => x + 1);
    return d;
  }
  function onCancel(e) { if (!otherPointer(e)) endDrag(); }
  /** Dopo un rilascio vero il click che segue non deve aprire niente. */
  function markDropped() {
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
  }
  return { drag, justDragged, force, otherPointer, endDrag, onCancel, markDropped };
}
