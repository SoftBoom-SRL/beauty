// hooks/useResource.js — un dato letto dal server all'apertura e di nuovo a
// ogni cambio delle `deps` (filtri, pagina, un contatore di ricarico): la
// richiesta, il segno «sto caricando» e la risposta arrivata tardi scartata
// (quella di una richiesta già superata o di un componente già chiuso).
import { useEffect, useState } from 'react';

/**
 * → { data, setData, loading }
 * `load()` restituisce la promessa della richiesta. Riparte, rimettendo
 * `loading`, a ogni cambio di `deps` o di `enabled`; con `enabled` falso non
 * chiede niente e `loading` parte falso. Se la richiesta fallisce `data`
 * diventa `fallback`, quando è dato (altrimenti resta com'era), e si chiama
 * `onError(err)`. `load`, `fallback` e `onError` sono quelli del render che
 * ha fatto partire la richiesta, come in un useEffect scritto a mano.
 */
export function useResource(load, deps, opts = {}) {
  const { initial = null, enabled = true } = opts;
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    setLoading(true);
    load()
      .then((r) => { if (!dead) setData(r); })
      .catch((err) => {
        if (dead) return;
        if ('fallback' in opts) setData(opts.fallback);
        opts.onError?.(err);
      })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [enabled, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps -- le dipendenze le sceglie il chiamante
  return { data, setData, loading };
}
