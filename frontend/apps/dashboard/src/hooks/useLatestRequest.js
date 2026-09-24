// hooks/useLatestRequest.js — il «biglietto» della richiesta in corso, per le
// liste che si ricaricano mentre una richiesta è ancora in volo (filtro
// cambiato, «Carica altre», evento dal vivo): ogni fetch ne prende uno con
// begin() e al ritorno applica la risposta solo se isLatest() dice che nel
// frattempo non ne è partita un'altra. Senza, vince chi risponde per ultimo.
import { useRef } from 'react';

/** → { begin() → n, isLatest(n) }, lo stesso oggetto per tutta la vita del
 *  componente (si può mettere fra le dipendenze senza effetti). */
export function useLatestRequest() {
  const ref = useRef(null);
  if (!ref.current) {
    let last = 0;
    ref.current = { begin: () => ++last, isLatest: (n) => n === last };
  }
  return ref.current;
}
