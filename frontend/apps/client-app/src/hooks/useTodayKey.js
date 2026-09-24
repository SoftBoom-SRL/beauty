// useTodayKey.js — il giorno di oggi in salone, che si aggiorna da solo.
import React from 'react';
import { todayStr } from '@youty/shared';

/** La data di oggi come 'YYYY-MM-DD', che cambia da sola a mezzanotte.
 *
 * Le schermate di prenotazione calcolavano la striscia dei giorni una volta
 * sola: un'app lasciata aperta la sera proponeva ancora ieri come primo giorno.
 * Si controlla anche al ritorno in primo piano, perché sul telefono i timer si
 * fermano quando l'app è in secondo piano.
 * Il giorno è quello del SALONE: è la mezzanotte della reception a far
 * scivolare la striscia, non quella del telefono di chi guarda. */
export function useTodayKey() {
  const [key, setKey] = React.useState(() => todayStr());
  React.useEffect(() => {
    const tick = () => setKey((k) => { const now = todayStr(); return now === k ? k : now; });
    const id = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return key;
}
