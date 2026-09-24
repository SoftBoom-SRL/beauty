// useNowMinutes — l'ora attuale in minuti del salone, aggiornata ogni 30
// secondi: la riga rossa dell'ora e il velo sul passato in giorno e settimana.
import { useEffect, useState } from 'react';
import { nowMinutes } from '@youty/shared';

export function useNowMinutes() {
  const [nowMin, setNowMin] = useState(() => nowMinutes());
  useEffect(() => {
    const id = setInterval(() => setNowMin(nowMinutes()), 30000);
    return () => clearInterval(id);
  }, []);
  return nowMin;
}
