// useStoredFlag — un sì/no che resta su questa postazione (localStorage),
// acceso finché non lo si spegne: «1»/«0» sotto `key`. Senza localStorage
// (navigazione privata, permessi) vale acceso e non si salva.
import { useState } from 'react';

export function useStoredFlag(key) {
  const [on, setOnRaw] = useState(() => {
    try { return localStorage.getItem(key) !== '0'; } catch { return true; }
  });
  const setOn = (v) => {
    setOnRaw(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
  };
  return [on, setOn];
}
