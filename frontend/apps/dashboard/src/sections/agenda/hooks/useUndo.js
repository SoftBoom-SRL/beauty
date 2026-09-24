// useUndo — il «torna indietro» dell'agenda.
// Un gesto sbagliato si disfa da qui: il server rimette i dati com'erano e,
// se il messaggio alla cliente non è ancora partito, lo ferma. Non chiede
// conferme (in agenda non se ne chiedono): se non si può più tornare
// indietro lo dice il server, e l'avviso riporta il suo motivo.
import { useCallback, useRef, useState } from 'react';
import { ApiError, toastApiError } from '@youty/shared';
import * as agendaApi from '../agendaApi.js';
import { nothingToUndoText, undoneText } from '../lib/toastText.js';
import { useLatest } from './useLatest.js';

/** Ritorna { undoing, undoLast(entryId?), undoMark(), undoAfter(mark, onDone?) }.
 *  `dateRef`/`setDate`: il giorno a video, su cui si salta se l'annullamento
 *  riporta l'appuntamento altrove; `refetchAllRef`, `fetchUndo`, `undoStack`:
 *  da useAgendaData. */
export function useUndo({ canWrite, noWrite, fireToast, t, toastProps, dateRef, setDate, refetchAllRef, fetchUndo, undoStack }) {
  const [undoing, setUndoing] = useState(false);
  /* Guardia in una ref, non nello stato: l'«Annulla» di un avviso tiene la
   * funzione di quando è comparso, con `undoing` ancora falso. Premendo
   * «Indietro» (o ⌘Z) e poi «Annulla» durante la richiesta partiva un secondo
   * POST /undo senza id, che annullava anche il gesto di prima o rispondeva
   * con un 409 falso. All'avvio si chiude anche l'avviso: non deve restare lì
   * a offrire di annullare una cosa che si sta già annullando. */
  const undoingRef = useRef(false);
  const toastDoneRef = useLatest(toastProps?.onDone);
  // `setDate` arriva da useAgendaNav: letto da una ref, `undoLast` resta la
  // stessa funzione finché non cambiano permessi, avvisi e lingua, come prima.
  const setDateRef = useLatest(setDate);
  const undoLast = useCallback(async (entryId) => {
    if (!canWrite) { noWrite(); return; }
    if (undoingRef.current) return;
    undoingRef.current = true;
    setUndoing(true);
    toastDoneRef.current?.();
    try {
      const res = await agendaApi.undoGesture(entryId);
      // Il gesto può aver riportato l'appuntamento su un altro giorno: senza
      // questo salto si annullava «a vuoto», con la griglia ferma dov'era.
      if (res.date && res.date !== dateRef.current) setDateRef.current(res.date);
      fireToast({ msg: undoneText(t, res.label), icon: 'undo' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) fireToast({ msg: nothingToUndoText(t), icon: 'info' });
      else toastApiError(err, fireToast, t);
    } finally {
      undoingRef.current = false;
      setUndoing(false);
      refetchAllRef.current();
    }
  }, [canWrite, noWrite, fireToast, t, toastDoneRef, dateRef, setDateRef, refetchAllRef]);   // le ref sono stabili
  const undoLastRef = useLatest(undoLast);

  /* «Annulla» nell'avviso di un gesto: annulla QUEL gesto, non l'ultima voce
   * di chi guarda. Le risposte di spostamenti e pause non dicono quale voce
   * hanno scritto, quindi si segna la voce più recente nota PRIMA del gesto
   * (`undoMark`) e dopo si rilegge la pila: la voce nuova è quella del gesto.
   * Se non la si trova (pila non riletta), si ripiega sull'ultima voce come
   * prima. `onDone`: chi ha fatto il gesto ricarica anche la sua vista. */
  const undoStackRef = useLatest(undoStack);
  const undoMark = useCallback(() => undoStackRef.current.reduce((m, e) => Math.max(m, e?.id || 0), 0), [undoStackRef]);
  const undoAfter = useCallback((mark, onDone) => {
    const entry = fetchUndo().then((list) => (list || []).find((e) => e.id > mark)?.id ?? null);
    return () => entry.then((id) => undoLastRef.current(id ?? undefined)).then(() => onDone?.());
  }, [fetchUndo, undoLastRef]);

  return { undoing, undoLast, undoMark, undoAfter };
}
