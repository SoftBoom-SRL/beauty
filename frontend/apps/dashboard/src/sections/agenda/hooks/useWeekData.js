// useWeekData — la settimana da GET /api/agenda/week: caricamento a ogni
// cambio di settimana o di sede (con lo scheletro), ricarico silenzioso dopo
// uno spostamento o un evento live delle altre postazioni.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toastApiError } from '@youty/shared';
import { AGENDA_LIVE_RE } from '../constants.js';
import * as agendaApi from '../agendaApi.js';
import { useLatest } from './useLatest.js';

/** Ritorna { days (null = caricamento), refetchWeek, refetchWeekRef }. */
export function useWeekData({ weekStart, locationId, live, t, fireToast }) {
  const [days, setDays] = useState(null); // null = loading
  /* reusable refetch (no skeleton flash) — used after a move and passed to the detail modal.
   * Settimana e sede si leggono da una ref, e un numero di sequenza scarta le
   * risposte superate, come fa fetchDay in vista giorno. Il pannello teneva il
   * ricarico di quando si era aperto: sfogliata la settimana dopo, «Salva»
   * rileggeva la 21–27 e la mostrava sotto l'intestazione «28 set – 4 ott», e
   * clic e trascinamenti lavoravano sulle date vecchie. Stessa corsa fra un
   * evento live e un cambio di settimana. */
  const weekSeq = useRef(0);
  const weekRef = useLatest(weekStart);
  const locRef = useLatest(locationId);
  const refetchWeek = useCallback(() => {
    const my = ++weekSeq.current;
    const forWeek = weekRef.current, forLoc = locRef.current;
    return agendaApi.getWeek(forWeek, forLoc)
      .then((rows) => {
        if (my === weekSeq.current && forWeek === weekRef.current && forLoc === locRef.current) setDays(rows);
      })
      .catch((err) => {
        if (my !== weekSeq.current) return;
        toastApiError(err, fireToast, t);
        setDays((cur) => cur ?? []);   // mai uno scheletro senza fine
      });
  }, [t, fireToast, weekRef, locRef]);   // le due ref sono stabili: conta solo la lingua
  const refetchWeekRef = useLatest(refetchWeek);

  // live: modifiche dalle altre postazioni → ricarica la settimana senza
  // skeleton, subito (senza attesa: a ogni evento la sua lettura)
  useEffect(() => live.subscribe(({ events }) => {
    if (events.some((e) => AGENDA_LIVE_RE.test(e.type))) refetchWeek();
  }), [live, refetchWeek]);

  useEffect(() => {
    const my = ++weekSeq.current;
    setDays(null);
    agendaApi.getWeek(weekStart, locationId)
      .then((rows) => { if (my === weekSeq.current) setDays(rows); })
      .catch((err) => { if (my === weekSeq.current) { setDays([]); toastApiError(err, fireToast, t); } });
  }, [weekStart, locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // smontaggio: le risposte in volo non scrivono più niente
  useEffect(() => () => { weekSeq.current++; }, []);

  return { days, refetchWeek, refetchWeekRef };
}
