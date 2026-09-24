// useStoredFlag — un sì/no che resta su questa postazione (localStorage):
// «1»/«0» sotto `key`. Finché non lo si tocca vale `initial` (acceso, se non
// si dice altro). Senza localStorage (navigazione privata, permessi) vale
// `initial` e non si salva.
import { useState } from 'react';

export function useStoredFlag(key, initial = true) {
  const [on, setOnRaw] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v !== '0';
    } catch { return initial; }
  });
  const setOn = (v) => {
    setOnRaw(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
  };
  return [on, setOn];
}
