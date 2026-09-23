// useToastHost.js — one hook powers both Toast (mobile) and DkToast (desktop).
//   const { fireToast, toastProps } = useToastHost();
//   <DkToast {...toastProps} />   or   <Toast {...toastProps} />
//   fireToast({ msg: 'Salvato', icon: 'check', undo: 'Annulla', undoFn: () => {...} })
import { useCallback, useRef, useState } from 'react';

/** Il tocco sul pulsante del toast. Prima si chiude il toast, POI si esegue
 *  undoFn: se undoFn ne mostra uno suo («Link copiato»), il setToast(null)
 *  che veniva dopo lo cancellava nello stesso render e la conferma non
 *  compariva mai (13-25). Il ref si svuota subito, così un secondo tocco
 *  prima del nuovo render non esegue l'azione due volte. */
export function runUndo(undoRef, setToast) {
  const fn = undoRef.current;
  undoRef.current = null;
  setToast(null);
  if (fn) fn();
}

export function useToastHost() {
  const [toast, setToast] = useState(null);
  const undoRef = useRef(null);

  const fireToast = useCallback((o) => {
    undoRef.current = o.undoFn || null;
    setToast(o);
  }, []);

  const onUndo = useCallback(() => runUndo(undoRef, setToast), []);

  const onDone = useCallback(() => setToast(null), []);

  return { toast, fireToast, toastProps: { toast, onUndo, onDone } };
}
