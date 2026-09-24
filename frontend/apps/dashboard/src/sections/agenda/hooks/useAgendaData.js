// useAgendaData — i dati della vista giorno e della colonna di destra: la
// giornata (GET /agenda/day), la lista d'attesa, il riepilogo di cassa, gli
// slot liberati «da richiamare» e la pila del «torna indietro».
import { useCallback, useEffect, useRef, useState } from 'react';
import { toastApiError } from '@youty/shared';
import * as agendaApi from '../agendaApi.js';
import { useLatest } from './useLatest.js';

/** Ritorna i dati (dayData null = primo caricamento → scheletro) e i ricarichi:
 *  fetchDay (solo la giornata; rifiuta se la GET fallisce), fetchUndo (rende
 *  anche la pila letta) e refetchAll, con la sua ref per chi vive più a lungo
 *  di un render. `dateRef` = il giorno a video, per le risposte in volo. */
export function useAgendaData({ date, locationId, t, fireToast }) {
  const [dayData, setDayData] = useState(null);   // null = first load → skeleton
  const [waitlist, setWaitlist] = useState([]);
  const [summary, setSummary] = useState(null);
  const [released, setReleased] = useState([]);   // slot liberati per caparra non pagata: «da richiamare»
  const [undoStack, setUndoStack] = useState([]); // gesti annullabili, dal più recente

  /* Numero di sequenza condiviso con l'effetto di caricamento: una risposta
   * lenta di un altro giorno non deve sovrascrivere quello che si sta guardando
   * (succedeva con i ricarichi live, e lo spostamento successivo finiva per
   * usare la data sbagliata). */
  const daySeq = useRef(0);
  /* Il numero di sequenza da solo non basta: un ricarico partito DOPO il
   * cambio giorno (l'attesa del POST di uno spostamento, per esempio) chiede
   * la data vecchia e prende il numero più alto, quindi vince — l'intestazione
   * diceva 19 settembre e la griglia mostrava il 18. Si confronta anche la
   * data, letta da una ref perché le funzioni in volo hanno in mano quella di
   * quando sono partite. */
  const dateRef = useLatest(date);
  const fetchDay = useCallback(async () => {
    const my = ++daySeq.current;
    const forDate = date;
    const rows = await agendaApi.getDay(forDate, locationId);
    if (my === daySeq.current && forDate === dateRef.current) setDayData(rows);
  }, [date, locationId, dateRef]);
  const fetchWaitlist = useCallback(() => agendaApi.getWaitlist().then(setWaitlist).catch(() => {}), []);
  /* «Torna indietro»: la pila dei gesti che CHI GUARDA può ancora annullare.
   * Arriva dal server perché l'annullamento è vero — rimette a posto i dati e
   * ferma i messaggi non ancora partiti — e perché deve rifiutarsi di
   * sovrascrivere quello che nel frattempo ha fatto un'altra postazione. */
  // restituisce anche la pila letta: serve a trovare la voce del gesto appena fatto (undoAfter)
  const fetchUndo = useCallback(() => agendaApi.getUndoStack().then((list) => { setUndoStack(list); return list; }).catch(() => null), []);
  const fetchSummary = useCallback(() => agendaApi.getTodaySummary().then(setSummary).catch(() => {}), []);
  const fetchReleased = useCallback(() => agendaApi.getReleased().then(setReleased).catch(() => {}), []);
  const refetchAll = useCallback(() => { fetchDay().catch(() => {}); fetchWaitlist(); fetchSummary(); fetchReleased(); fetchUndo(); }, [fetchDay, fetchWaitlist, fetchSummary, fetchReleased, fetchUndo]);
  /* Le callback date ai modali (onMutate, onCreated) vivono quanto il modale,
   * ma `refetchAll` cambia a ogni giorno sfogliato: quella catturata
   * all'apertura ricaricava il giorno di allora, e la risposta veniva scartata
   * perché non era più quello a video. Passando dalla ref si ricarica sempre
   * il giorno che si ha davanti. */
  const refetchAllRef = useLatest(refetchAll);

  useEffect(() => {
    const my = ++daySeq.current;
    setDayData(null);
    agendaApi.getDay(date, locationId)
      .then((rows) => { if (my === daySeq.current) setDayData(rows); })
      .catch((err) => { if (my === daySeq.current) { setDayData([]); toastApiError(err, fireToast, t); } });
  }, [date, locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchWaitlist(); fetchSummary(); fetchReleased(); fetchUndo(); }, [fetchWaitlist, fetchSummary, fetchReleased, fetchUndo]);

  return { dayData, waitlist, summary, released, undoStack, dateRef, fetchDay, fetchUndo, refetchAll, refetchAllRef };
}
