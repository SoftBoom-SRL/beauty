// useGiftCards — le gift card «a trattamento» attive e pagate della cliente
// scelta nel drawer «Nuova prenotazione». Compaiono accanto ai servizi
// coperti, così chi prenota vede subito che il trattamento è già pagato da
// qualcuno (e il checkout lo userà): per questo la regola è quella del server
// (usableGiftCards = gift_index).
import { useEffect, useState } from 'react';
import * as agendaApi from '../agendaApi.js';
import { usableGiftCards } from '../modals/rules.js';

/** Ritorna `giftFor(serviceId)`: la gift card che copre quel servizio, o null. */
export function useGiftCards(clientId) {
  const [gifts, setGifts] = useState([]);
  useEffect(() => {
    if (!clientId) { setGifts([]); return undefined; }
    let alive = true;
    agendaApi.getClientGiftCards(clientId)
      .then((r) => { if (alive) setGifts(usableGiftCards(r.items, clientId)); })
      .catch(() => { if (alive) setGifts([]); });
    return () => { alive = false; };
  }, [clientId]);
  return (serviceId) => gifts.find((g) => g.gift_service_id === serviceId) || null;
}
