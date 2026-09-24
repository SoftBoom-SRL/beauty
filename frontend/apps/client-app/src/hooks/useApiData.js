// useApiData.js — i dati di una chiamata all'API fatta all'apertura dello
// schermo, con la guardia contro le risposte arrivate tardi.
import React from 'react';

/** { data, error, setData } di `load()` (una funzione che restituisce la
 *  Promise della chiamata), rifatta quando cambia qualcosa in `deps`.
 *
 *  La risposta di una chiamata superata — lo schermo chiuso prima che
 *  arrivasse, o le dipendenze cambiate nel frattempo — non si scrive più:
 *  arrivata fuori ordine avrebbe coperto quella giusta. È la guardia
 *  `let alive = true` che ogni schermo si scriveva da sé. `onError`
 *  (facoltativo) riceve l'errore dopo che è in `error`, e solo se la chiamata
 *  conta ancora: è il posto del toast. `setData` è per chi aggiorna i dati
 *  in modo ottimistico. `load` e `onError` sono quelli del render in cui
 *  parte la chiamata. */
export function useApiData(load, deps, { onError } = {}) {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    load()
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) { setError(e); if (onError) onError(e); } });
    return () => { alive = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps -- le dipendenze le dichiara chi chiama
  return { data, error, setData };
}
