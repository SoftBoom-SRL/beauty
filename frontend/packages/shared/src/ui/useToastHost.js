// useToastHost.js — one hook powers both Toast (mobile) and DkToast (desktop).
//   const { fireToast, toastProps } = useToastHost();
//   <DkToast {...toastProps} />   or   <Toast {...toastProps} />
//   fireToast({ msg: 'Salvato', icon: 'check', undo: 'Annulla', undoFn: () => {...} })
import { useCallback, useRef, useState } from 'react';

export function useToastHost() {
  const [toast, setToast] = useState(null);
  const undoRef = useRef(null);

  const fireToast = useCallback((o) => {
    undoRef.current = o.undoFn || null;
    setToast(o);
  }, []);

  const onUndo = useCallback(() => {
    if (undoRef.current) undoRef.current();
    setToast(null);
  }, []);

  const onDone = useCallback(() => setToast(null), []);

  return { toast, fireToast, toastProps: { toast, onUndo, onDone } };
}
