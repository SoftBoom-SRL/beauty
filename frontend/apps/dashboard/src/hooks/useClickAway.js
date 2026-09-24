// hooks/useClickAway.js — chiude un menu o un popover al clic fuori (e, se
// richiesto, con Esc).
import { useEffect } from 'react';

/**
 * Finché `open` è vero, un `event` (mousedown, o pointerdown) su un punto fuori
 * da `ref` chiama `onClose()`. Con `escape`, anche Esc: chiude il menu e
 * basta — `preventDefault()` dice alla pila dei livelli (ui/layers.js) di non
 * chiudere anche la finestra sotto — e un Esc già preso da altri si ignora.
 * `capture`: l'ascolto del clic in fase di cattura (la barra in alto: il
 * backdrop-filter di `.dk-top` confina i fondi `position: fixed`).
 * Gli ascoltatori si riregistrano quando cambia `onClose`: chi vuole
 * registrarli una volta per apertura passa una funzione stabile (useCallback).
 */
export function useClickAway(ref, open, onClose, { event = 'mousedown', capture = false, escape = false } = {}) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } };
    document.addEventListener(event, onDown, capture);
    if (escape) document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener(event, onDown, capture);
      if (escape) document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose, event, capture, escape]);
}
