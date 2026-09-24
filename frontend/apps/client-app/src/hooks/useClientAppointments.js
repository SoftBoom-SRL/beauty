// useClientAppointments.js — gli appuntamenti della cliente, sempre freschi.
import React from 'react';
import { getAppointments } from '../api/client.js';
import { useTodayKey } from './useTodayKey.js';

/** Fetch the client's own appointments ({upcoming, past}).
 *
 *  Si ricarica da sola quando cambia il giorno del salone e quando l'app torna
 *  in primo piano. Caricata una volta sola, la Home lasciata aperta la sera
 *  diceva ancora «Domani alle 10:00» la mattina dopo, per un appuntamento che
 *  era oggi, e una visita già rilasciata per caparra non versata restava lì
 *  col suo «Paga ora» (16-05). */
export function useClientAppointments() {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState(null);
  const seq = React.useRef(0);
  const loaded = React.useRef(false);
  const reload = React.useCallback(() => {
    // Conta solo l'ultima richiesta: al rientro possono partirne due insieme
    // (cambio di giorno e primo piano) e non devono arrivare fuori ordine.
    const n = ++seq.current;
    getAppointments()
      .then((d) => { if (n !== seq.current) return; loaded.current = true; setData(d); setError(null); })
      .catch((e) => {
        if (n !== seq.current) return;
        // Un aggiornamento fallito (rete assente al rientro) lascia a video
        // quello che c'era, senza un toast d'errore a ogni ritorno nell'app.
        if (!loaded.current) setError(e);
      });
  }, []);
  const todayKey = useTodayKey();
  React.useEffect(() => { reload(); }, [reload, todayKey]);
  React.useEffect(() => {
    let last = Date.now();
    const onFront = () => {
      if (document.visibilityState === 'hidden') return;
      // visibilitychange e focus arrivano insieme: una richiesta basta
      if (Date.now() - last < 5000) return;
      last = Date.now();
      reload();
    };
    document.addEventListener('visibilitychange', onFront);
    window.addEventListener('focus', onFront);
    return () => {
      document.removeEventListener('visibilitychange', onFront);
      window.removeEventListener('focus', onFront);
    };
  }, [reload]);
  return { data, error, reload };
}
