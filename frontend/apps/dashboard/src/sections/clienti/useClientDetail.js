// useClientDetail.js — la scheda cliente caricata e tenuta aggiornata
// (ClientProfile): il dettaglio (ClientDetailOut, con visite e speso), il
// ricarico quando cambia altrove, il segno «in lista d'attesa» e le modifiche
// in coda (updateClient), una alla volta e solo con i campi che cambiano.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toastApiError } from '@youty/shared';
import { useDash, useLive } from '../../ctx.jsx';
import { clientsApi } from '../../api/clients.js';
// la lista d'attesa è dell'agenda: il suo endpoint lo espone agendaApi
import { getWaitlist } from '../agenda/agendaApi.js';

/** → { c, setC, failed, onWaitlist, updateClient(patch, toast), toastErr } */
export function useClientDetail(clientId, onChanged) {
  const { t, fireToast, hasScope } = useDash();
  const [c, setC] = useState(null);
  const [failed, setFailed] = useState(false);
  const [onWaitlist, setOnWaitlist] = useState(false);

  const toastErr = useCallback((err) => toastApiError(err, fireToast, t), [fireToast, t]);

  /* detail (ClientDetailOut: + visits, total_spent, last_visit) */
  useEffect(() => {
    let dead = false;
    setC(null); setFailed(false);
    clientsApi.get(clientId)
      .then((res) => { if (!dead) setC(res); })
      .catch((err) => { if (!dead) { setFailed(true); toastErr(err); } });
    return () => { dead = true; };
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps
  // la scheda cambia altrove → ricarico in silenzio. Non solo `client.updated`
  // della dashboard: anche il consenso revocato dall'app (client.consent_updated),
  // la carta salvata, un import, e le vendite di questa cliente — senza, visite
  // e «Valore totale» restavano quelli dell'apertura dopo un incasso a un'altra
  // cassa (14-20) e la reception rimandava i consensi vecchi (14-05).
  useLive(/^(client|sale)\./, (events) => {
    if (events.some((e) => e.payload?.client_id === clientId || e.type === 'client.imported')) {
      clientsApi.get(clientId).then((res) => setC((prev) => (prev ? { ...prev, ...res } : res))).catch(() => {});
    }
  });

  /* waiting-list badge (needs agenda read scope; fail silently).
   * È un endpoint dell'agenda: resta una chiamata diretta ad `api`, perché
   * gli endpoint dell'agenda li raccoglie la sezione agenda, non src/api/. */
  useEffect(() => {
    let dead = false;
    if (!hasScope('agenda')) return undefined;
    getWaitlist()
      .then((rows) => { if (!dead) setOnWaitlist((rows || []).some((w) => w.client_id === clientId)); })
      .catch(() => {});
    return () => { dead = true; };
  }, [clientId, hasScope]);

  /* PUT helper — manda SOLO il campo che il pulsante cambia (C15, vedi
   * helpers.js): il resto della copia letta all'apertura può essere vecchio
   * (consensi revocati dall'app, lingua, promemoria) e non va rimandato. La
   * risposta è un ClientOut: si fonde sul dettaglio per tenere
   * visits/total_spent/last_visit.
   *
   * Due clic ravvicinati non devono annullarsi: «VIP» e poi «Colore» partivano
   * dalla stessa lista di etichette e la seconda PUT riscriveva la prima.
   *  - le chiamate si mettono in coda, una alla volta;
   *  - `patch` può essere una funzione (prev) => patch, valutata al momento
   *    dell'invio sull'ultimo stato noto (cRef), non su quello del render in
   *    cui è stato premuto il pulsante. */
  const cRef = useRef(c);
  cRef.current = c;
  const queue = useRef(Promise.resolve());

  const updateClient = (patch, toast) => {
    const run = queue.current.then(async () => {
      const prev = cRef.current;
      if (!prev) return false;
      const body = typeof patch === 'function' ? patch(prev) : patch;
      try {
        const res = await clientsApi.update(clientId, body);
        cRef.current = { ...prev, ...res };   // la prossima in coda parte da qui
        setC((cur) => (cur ? { ...cur, ...res } : res));
        if (toast) fireToast(toast);
        onChanged && onChanged();
        return true;
      } catch (err) { toastErr(err); return false; }
    });
    queue.current = run.catch(() => {});      // un errore non deve bloccare la coda
    return run;
  };

  return { c, setC, failed, onWaitlist, updateClient, toastErr };
}
