// useGiftCards — le gift card «a trattamento» attive e pagate della cliente
// scelta nel drawer «Nuova prenotazione». Compaiono accanto ai servizi
// coperti, così chi prenota vede subito che il trattamento è già pagato —
// un regalo, un pagamento in anticipo, le sedute di un pacchetto — e il
// checkout lo userà: per questo la regola è quella del server
// (usableGiftCards = gift_index).
import { useEffect, useState } from 'react';
import * as agendaApi from '../agendaApi.js';
import { usableGiftCards } from '../modals/rules.js';
import { giverName } from '../../fedelta/credits.js';

/** Ritorna `giftFor(serviceId)`: la gift card che copre quel servizio, o null.
 *  La carta porta `from_name` come quella dell'agenda: chi l'ha regalata, se
 *  non è la cliente stessa. */
export function useGiftCards(clientId) {
  const [gifts, setGifts] = useState([]);
  useEffect(() => {
    if (!clientId) { setGifts([]); return undefined; }
    let alive = true;
    agendaApi.getClientGiftCards(clientId)
      .then((r) => {
        if (!alive) return;
        setGifts(usableGiftCards(r.items, clientId).map((g) => ({ ...g, from_name: giverName(g, clientId) })));
      })
      .catch(() => { if (alive) setGifts([]); });
    return () => { alive = false; };
  }, [clientId]);
  return (serviceId) => gifts.find((g) => g.gift_service_id === serviceId) || null;
}
