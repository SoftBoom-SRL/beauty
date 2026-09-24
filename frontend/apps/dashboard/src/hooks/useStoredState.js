// hooks/useStoredState.js — uno stato che si ricorda sulla postazione
// (localStorage), come la sede attiva o il riepilogo incassi in agenda.
import { useCallback, useState } from 'react';

/**
 * [valore, imposta]: il valore parte da `read(localStorage[key])` e ogni
 * `imposta(v)` lo salva subito come `write(v)`. localStorage può mancare o
 * lanciare (navigazione privata, cookie bloccati): allora si parte da
 * `fallback` e il salvataggio si salta, senza errori.
 * `write` va definita fuori dal componente: se cambia a ogni render cambia
 * anche `imposta`.
 */
export function useStoredState(key, { read, write, fallback }) {
  const [value, setValue] = useState(() => {
    try { return read(localStorage.getItem(key)); } catch { return fallback; }
  });
  const set = useCallback((v) => {
    setValue(v);
    try { localStorage.setItem(key, write(v)); } catch { /* ignore */ }
  }, [key, write]);
  return [value, set];
}
