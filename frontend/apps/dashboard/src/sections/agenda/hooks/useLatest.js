// useLatest — una ref che a ogni render tiene l'ultimo valore.
// Serve a chi vive più a lungo del render che l'ha creato: ascoltatori
// registrati una volta sola (Esc, pointerup su window), timer, promesse in
// volo, callback date ai modali. Leggendo dalla ref vedono lo stato di
// adesso, non quello di quando sono partiti. È lo stesso
// `const r = useRef(v); r.current = v;` che l'agenda scriveva a mano.
import { useRef } from 'react';

export function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
