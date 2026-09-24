// useBookingSlots — gli orari liberi del drawer «Nuova prenotazione» e
// l'orario scelto (vedi nextSelection): si ricaricano col giorno, i servizi,
// le operatrici, la sede e gli eventi live (`liveTick`); un ricarico sullo
// stesso elenco non mostra lo scheletro, e l'orario scelto che non è più
// libero si toglie dicendolo (tranne dopo un 409, che lo ha già detto
// l'avviso: `quietDrop`).
import { useEffect, useRef, useState } from 'react';
import { toastApiError, timeLabel, minutesOfDay } from '@youty/shared';
import * as agendaApi from '../agendaApi.js';
import { nextSelection } from '../modals/rules.js';

/** `req` = l'orario cliccato in agenda; `setForceCreate` è del drawer (l'orario
 *  scelto va forzato). Ritorna { slots (null = caricamento), selStart,
 *  showAll, setShowAll, choose(start, src, force), quietDrop }. */
export function useBookingSlots({ items, date, locationId, req, liveTick, initialShowAll, setForceCreate, t, fireToast }) {
  const [slots, setSlots] = useState([]);         // null = caricamento
  const [selStart, setSelStart] = useState(null); // ISO dello slot scelto
  const [showAll, setShowAll] = useState(initialShowAll);
  /* Orario scelto e da dove viene (vedi nextSelection): 'req' cliccato in
   * agenda, 'slot' fra i liberi, 'manual' scritto a mano, 'dropped' tolto
   * perché non era più libero. */
  const selRef = useRef({ start: null, src: null, force: false });
  const choose = (start, src, force) => {
    selRef.current = { start, src, force: !!force };
    setSelStart(start);
    setForceCreate(!!force);
  };
  const itemsKey = JSON.stringify(items.map((i) => [i.service_id, i.operator_id]));
  const availKey = JSON.stringify([date, itemsKey, locationId]);
  const lastAvailKey = useRef(null);
  const quietDrop = useRef(false);   // il ricarico dopo un 409 lo ha già spiegato l'avviso
  useEffect(() => {
    if (!items.length || !date) { lastAvailKey.current = null; setSlots([]); choose(null, null, false); return undefined; }
    let alive = true;
    // Stesso elenco ricaricato (evento live, 409): niente scheletro, gli orari
    // restano a video finché arrivano quelli nuovi.
    const refreshed = lastAvailKey.current === availKey;
    if (!refreshed) setSlots(null);
    lastAvailKey.current = availKey;
    agendaApi.getAvailability({ date, location_id: locationId, items: items.map((i) => ({ service_id: i.service_id, operator_id: i.operator_id })) })
      .then((res) => {
        if (!alive) return;
        setSlots(res);
        // L'orario cliccato in agenda si prende anche fuori turno o sopra
        // un'altra cliente (forzato); quello scelto fra le alternative o scritto
        // a mano resta com'è — prima tornava all'orario cliccato (13-18).
        const cur = selRef.current;
        const next = nextSelection({ prev: cur.start, src: cur.src, prevForced: cur.force, slots: res, reqStartMin: req?.startMin, date, refreshed });
        choose(next.start, next.src, next.force);
        if (next.dropped && !quietDrop.current) {
          const hh = timeLabel(minutesOfDay(next.dropped));
          fireToast({ msg: t(`Le ${hh} non sono più libere per questa prenotazione: scegli un altro orario`, `${hh} is no longer free for this booking: pick another time`), icon: 'alert' });
        }
        quietDrop.current = false;
      })
      .catch((err) => { if (alive) { setSlots([]); toastApiError(err, fireToast, t); } });
    return () => { alive = false; };
  }, [availKey, req?.startMin, liveTick]); // eslint-disable-line react-hooks/exhaustive-deps

  return { slots, selStart, showAll, setShowAll, choose, quietDrop };
}
