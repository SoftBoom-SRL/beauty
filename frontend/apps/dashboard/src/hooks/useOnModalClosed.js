// hooks/useOnModalClosed.js — fare qualcosa quando si chiude uno dei modali
// globali (ctx.openModal): la sezione che ha aperto «Nuovo cliente» o una
// scheda tecnica ricarica i suoi dati, che il modale ha cambiato per conto suo.
import { useEffect, useRef } from 'react';

/** `fn()` quando `modal` (ctx.modal) passa da uno di `names` a nessun modale.
 *  Si legge sempre l'ultima `fn`. */
export function useOnModalClosed(modal, names, fn) {
  const prev = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const was = prev.current;
    prev.current = modal;
    if (was && !modal && names.includes(was.name)) fnRef.current();
  }, [modal]); // eslint-disable-line react-hooks/exhaustive-deps -- `names` è una lista scritta nel chiamante
}
