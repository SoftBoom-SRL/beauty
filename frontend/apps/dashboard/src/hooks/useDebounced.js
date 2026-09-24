// hooks/useDebounced.js — un valore che segue un altro con un ritardo: la
// ricerca digitata arriva al server solo quando si smette di scrivere.
import { useEffect, useState } from 'react';

/** `value` dopo `ms` di quiete (parte da `value` stesso). */
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
