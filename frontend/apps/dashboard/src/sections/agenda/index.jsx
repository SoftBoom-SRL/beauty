// Agenda — day/week/month calendar wired to /api/agenda/* (port of desktop-agenda.jsx)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, Avatar, Icon, fmtDateIt, minutesOfDay, nowMinutes, timeLabel, toDateStr, todayStr, parseISO, NumInput } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import {
  MONTHS_IT, MONTHS_EN, DOW_IT, DOW_EN,
  isoAtMin, mondayOf, addMonths, toastErr, firstName, opDisplay,
  DK_START, DK_END, PXM, ZOOM_MIN, ZOOM_MAX, clampZoom, zoomStep,
  moveIsNoop, moveHereTarget, AGENDA_LIVE_RE,
} from './lib.js';
import DayGrid, { ApptHoverCard } from './DayGrid.jsx';
import WeekView from './WeekView.jsx';
import MonthView from './MonthView.jsx';
import RightRail from './RightRail.jsx';
import GroupBookingDrawer from './modals/GroupBookingDrawer.jsx';

export default function AgendaSection() {
  const {
    t, lang, operators, services, serviceCategories, hasScope,
    openModal, modal, fireToast, opColors, setOpColor, opPalette,
    setTab, setDeepLink, showRevenue, live, setAgendaPick, setAgendaDate, settings, session, locationId,
  } = useDash();
  const canWrite = hasScope('agenda');
  const noWrite = useCallback(() => fireToast({ msg: t('Il tuo ruolo non ha il permesso “agenda”: puoi solo consultare', 'Your role lacks the “agenda” permission: read only'), icon: 'lock' }), [fireToast, t]);

  /* ---- navigation state ---- */
  const [date, setDate] = useState(todayStr());
  const [calView, setCalView] = useState('day'); // day | week | month
  const [jumpOpen, setJumpOpen] = useState(false);
  const [railOpen, setRailOpenRaw] = useState(() => {
    try { return localStorage.getItem('dk-agenda-rail') !== '0'; } catch { return true; }
  });
  const setRailOpen = (v) => {
    setRailOpenRaw(v);
    try { localStorage.setItem('dk-agenda-rail', v ? '1' : '0'); } catch { /* ignore */ }
  };

  /* ---- zoom delle viste giorno/settimana ----------------------------------
   * Preferenza della POSTAZIONE, non del salone: resta su questo computer e
   * non tocca l'intervallo di prenotazione (Impostazioni), che è una regola di
   * tutti. Come i calendari professionali: cursore personale su Fresha,
   * spaziatura righe e pinch su Vagaro, «quante ore per schermata» su Apple. */
  const [zoom, setZoomRaw] = useState(() => {
    try { return clampZoom(parseFloat(localStorage.getItem('dk-agenda-zoom')) || 1); } catch { return 1; }
  });
  /* Il valore precedente si legge dallo stato, non dalla chiusura: premendo due
   * volte «+» in fretta il secondo clic partiva dallo stesso numero del primo e
   * non faceva niente. */
  const setZoom = useCallback((z) => {
    setZoomRaw((prev) => clampZoom(typeof z === 'function' ? z(prev) : z));
  }, []);
  useEffect(() => {
    try { localStorage.setItem('dk-agenda-zoom', String(zoom)); } catch { /* ignore */ }
  }, [zoom]);
  /* «Adatta»: la giornata intera in una schermata, senza scorrere. Si misura
   * l'area visibile della griglia — è lei che detta quanto ci sta. */
  const fitZoom = useCallback(() => {
    const el = document.querySelector('.dk-tl-cols')?.closest('.scroll')
      || document.querySelector('[data-daycol]')?.closest('.scroll');
    if (!el) return;
    const body = el.querySelector('.dk-tl-cols')?.parentElement || el.querySelector('[data-daycol]')?.parentElement;
    const disponibile = el.clientHeight - (body ? body.offsetTop : 0) - 8;
    if (disponibile > 60) setZoom(disponibile / ((DK_END - DK_START) * PXM));
  }, [setZoom]);

  /* ---- real "now" (updated every 30s) ---- */
  const [nowMin, setNowMin] = useState(() => nowMinutes());
  useEffect(() => {
    const id = setInterval(() => setNowMin(nowMinutes()), 30000);
    return () => clearInterval(id);
  }, []);
  const isToday = date === todayStr();
  useEffect(() => { setAgendaDate(date); return () => setAgendaDate(null); }, [date, setAgendaDate]);

  /* ---- day data ---- */
  const [dayData, setDayData] = useState(null);   // null = first load → skeleton
  const [waitlist, setWaitlist] = useState([]);
  const [summary, setSummary] = useState(null);
  const [released, setReleased] = useState([]);   // slot liberati per caparra non pagata: «da richiamare»
  const [undoStack, setUndoStack] = useState([]); // gesti annullabili, dal più recente
  const [undoing, setUndoing] = useState(false);

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
  const dateRef = useRef(date);
  dateRef.current = date;
  const fetchDay = useCallback(async () => {
    const my = ++daySeq.current;
    const forDate = date;
    const rows = await api.get('/api/agenda/day', { params: { date: forDate, location_id: locationId } });
    if (my === daySeq.current && forDate === dateRef.current) setDayData(rows);
  }, [date, locationId]);
  const fetchWaitlist = useCallback(() => api.get('/api/agenda/waitlist').then(setWaitlist).catch(() => {}), []);
  /* «Torna indietro»: la pila dei gesti che CHI GUARDA può ancora annullare.
   * Arriva dal server perché l'annullamento è vero — rimette a posto i dati e
   * ferma i messaggi non ancora partiti — e perché deve rifiutarsi di
   * sovrascrivere quello che nel frattempo ha fatto un'altra postazione. */
  const fetchUndo = useCallback(() => api.get('/api/agenda/undo').then(setUndoStack).catch(() => {}), []);
  const fetchSummary = useCallback(() => api.get('/api/sales/today-summary').then(setSummary).catch(() => {}), []);
  const fetchReleased = useCallback(() => api.get('/api/agenda/released').then(setReleased).catch(() => {}), []);
  const refetchAll = useCallback(() => { fetchDay().catch(() => {}); fetchWaitlist(); fetchSummary(); fetchReleased(); fetchUndo(); }, [fetchDay, fetchWaitlist, fetchSummary, fetchReleased, fetchUndo]);
  /* Le callback date ai modali (onMutate, onCreated) vivono quanto il modale,
   * ma `refetchAll` cambia a ogni giorno sfogliato: quella catturata
   * all'apertura ricaricava il giorno di allora, e la risposta veniva scartata
   * perché non era più quello a video. Passando dalla ref si ricarica sempre
   * il giorno che si ha davanti. */
  const refetchAllRef = useRef(refetchAll);
  refetchAllRef.current = refetchAll;

  /* Copia fresca dell'appuntamento aperto nel pannello. Le props del modale
   * restano quelle dell'apertura, mentre il pannello salva e aggiorna solo il
   * proprio stato: dopo «Passa a Bea» l'ombra restava nella colonna di Anna e
   * «Sposta qui» mandava Anna come operatrice di partenza — il server non
   * trovava i suoi servizi, e l'appuntamento restava a Bea (se occupata,
   * forzato sopra la sua cliente) mentre l'avviso diceva «Spostato a Carla».
   * Si rilegge a ogni modifica segnalata dal pannello, legata all'id del modale
   * perché riaprendone un altro la copia vecchia non valga più. */
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const [apptFresh, setApptFresh] = useState(null);   // { modalId, appt }
  const freshSeq = useRef(0);
  const reloadOpenAppt = useCallback((id) => {
    const m = modalRef.current;
    if (!m || m.name !== 'apptdetail' || m.props?.appointment?.id !== id) return;
    const my = ++freshSeq.current;
    api.get(`/api/agenda/appointments/${id}`)
      .then((fresh) => {
        if (my === freshSeq.current && modalRef.current?.id === m.id) setApptFresh({ modalId: m.id, appt: fresh });
      })
      .catch(() => { /* resta la copia che c'è */ });
  }, []);

  useEffect(() => {
    const my = ++daySeq.current;
    setDayData(null);
    api.get('/api/agenda/day', { params: { date, location_id: locationId } })
      .then((rows) => { if (my === daySeq.current) setDayData(rows); })
      .catch((err) => { if (my === daySeq.current) { setDayData([]); toastErr(err, t, fireToast); } });
  }, [date, locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { fetchWaitlist(); fetchSummary(); fetchReleased(); fetchUndo(); }, [fetchWaitlist, fetchSummary, fetchReleased, fetchUndo]);

  /* live: quando un'altra postazione tocca l'agenda, ricarica (debounce breve) */
  /* Il cleanup NON deve annullare il debounce: `live` cambia identità a ogni
   * evento ricevuto e la consegna aggiorna lo stato PRIMA di chiamare gli
   * ascoltatori, quindi l'effetto si smontava subito dopo aver programmato il
   * timer e lo cancellava — il ricarico non partiva MAI e la griglia restava
   * ferma sui dati di quando si era aperto il giorno. Il timer vive in una ref
   * e si spegne solo allo smontaggio, come già fa MonthView.
   * `deposit.`: la caparra pagata online deve comparire da sola, senza che
   * nessuno ricarichi la pagina. `operator.` e `settings.` (turni, assenze,
   * orari del centro): vedi AGENDA_LIVE_RE.
   * Con il pannello aperto si rilegge anche il suo appuntamento, che può
   * essere stato cambiato altrove: l'ombra deve stare dove sta davvero. */
  const liveTimer = useRef(null);
  useEffect(() => {
    if (!live?.subscribe) return undefined;
    return live.subscribe(({ events }) => {
      if (!events.some((e) => AGENDA_LIVE_RE.test(e.type))) return;
      clearTimeout(liveTimer.current);
      liveTimer.current = setTimeout(() => {
        refetchAll();
        const m = modalRef.current;
        if (m?.name === 'apptdetail' && m.props?.appointment?.id) reloadOpenAppt(m.props.appointment.id);
      }, 250);
    });
  }, [live, refetchAll, reloadOpenAppt]);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  /* refetch after any modal closes — mutations happen inside modals, keep the grid fresh */
  const prevModal = useRef(modal);
  useEffect(() => {
    if (prevModal.current && !modal) refetchAll();
    prevModal.current = modal;
  }, [modal, refetchAll]);

  /* ---- operator visibility chips ---- */
  const [vis, setVis] = useState({});
  useEffect(() => {
    setVis((m) => {
      const next = { ...m };
      operators.forEach((o) => { if (next[o.id] === undefined) next[o.id] = true; });
      return next;
    });
  }, [operators]);
  const visCount = operators.filter((o) => vis[o.id]).length;
  const allOn = operators.every((o) => vis[o.id]);
  const opFirsts = operators.map((o) => o.first_name); // disambiguazione omonimie nelle chip
  const toggleVis = (id) => setVis((m) => ({ ...m, [id]: !m[id] }));
  const setAll = (on) => setVis(() => { const m = {}; operators.forEach((o) => { m[o.id] = on; }); return m; });

  const colorOf = useCallback((id) => opColors[id] || 'var(--clay)', [opColors]);
  const catColor = useCallback((catId) => {
    const c = (serviceCategories || []).find((x) => x.id === catId);
    return c ? c.color : null;
  }, [serviceCategories]);
  // colore per-servizio, dalla categoria del servizio (fallback: colore operatrice)
  const itemColor = useCallback((item) => {
    const s = (services || []).find((x) => x.id === item.service_id);
    const col = s ? catColor(s.category_id) : null;
    return col || colorOf(item.operator_id);
  }, [services, catColor, colorOf]);

  /* ---- interactions state ---- */
  const [hover, setHover] = useState(null);       // { a, x, y, side }
  const [slotMenu, setSlotMenu] = useState(null); // { opId, startMin, x, y, mode?, dur? }
  const [picker, setPicker] = useState(null);     // opId whose colour picker is open

  const onHover = (a, el) => {
    if (!a) { setHover(null); return; }
    const r = el.getBoundingClientRect();
    const right = r.right + 320 < window.innerWidth;
    setHover({ a, x: right ? r.right + 10 : r.left - 10, y: Math.min(r.top, window.innerHeight - 260), side: right ? 'right' : 'left' });
  };

  /* ---- nuova prenotazione: UN solo drawer (modale 'newappt'), da qualunque punto si parta ----
   * Mentre è aperto l'agenda è in "pick mode": un clic su uno slot libero
   * passa orario e operatrice al drawer invece di aprire il menu. */
  const [groupOpen, setGroupOpen] = useState(false);
  const pickMode = modal?.name === 'newappt';
  const openNewAppt = useCallback((prefill) => {
    if (!canWrite) { noWrite(); return; }
    openModal('newappt', { prefill: prefill || {}, onCreated: () => refetchAllRef.current() });
  }, [canWrite, noWrite, openModal]);
  /* Con la prenotazione aperta, un clic in griglia SCEGLIE l'orario: aprire un
   * altro drawer (vista settimana) o il dettaglio di un blocco sostituiva quello
   * in corso, e cliente, servizi e nota scritti al telefono sparivano. */
  const pickNewAppt = useCallback((prefill) => {
    if (pickMode) {
      if (!canWrite) { noWrite(); return; }
      setAgendaPick({ operatorId: prefill?.operatorId, start: prefill?.start, date: prefill?.date });
      return;
    }
    openNewAppt(prefill);
  }, [pickMode, canWrite, noWrite, setAgendaPick, openNewAppt]);

  /* Dettaglio di un appuntamento, da qualunque punto dell'agenda.
   * `extraMutate`: la vista settimana ricarica anche la sua griglia. */
  const openApptDetail = (a, extraMutate) => {
    if (!a) return;
    if (pickMode) {
      fireToast({ msg: t('Prenotazione in corso: scegli uno spazio libero, o chiudila per aprire questo appuntamento', 'Booking in progress: pick a free space, or close it to open this appointment'), icon: 'info' });
      return;
    }
    /* In settimana il giorno «scelto» non si vede: aprendo un appuntamento di
     * giovedì con la sezione ferma su lunedì, l'ombra compariva su lunedì, alla
     * stessa ora, senza niente che dicesse perché. Qui il giorno scelto diventa
     * quello dell'appuntamento: l'ombra compare solo quando si sfoglia davvero
     * un altro giorno dal pannello — che quel giorno lo mostra. */
    if (calView === 'week') {
      const day = toDateStr(a.start);
      if (day && day !== dateRef.current) setDate(day);
    }
    openModal('apptdetail', {
      appointment: a,
      onMutate: () => { refetchAllRef.current(); extraMutate?.(); reloadOpenAppt(a.id); },
      onShowDate: setDate,
    });
  };
  /* groupOpen sta fra le dipendenze: senza, l'handler registrato restava
   * quello di prima e vedeva il drawer di gruppo ancora chiuso — il tasto N ci
   * apriva sopra la prenotazione singola. */
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      // Zoom da tastiera senza modificatori: ⌘+ e ⌘− sono del browser e
      // ingrandirebbero tutta la pagina, che qui non è quello che serve.
      if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom((z) => zoomStep(z, 1)); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom((z) => zoomStep(z, -1)); return; }
      if (e.key === '0') { e.preventDefault(); setZoom(1); return; }
      if (e.key !== 'n' && e.key !== 'N') return;
      if (modal || groupOpen) return;   // il drawer di gruppo non è un modale del registry
      e.preventDefault();
      openNewAppt({ date });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNewAppt, date, modal, groupOpen, setZoom]);

  /* ---- torna indietro ----
   * Un gesto sbagliato si disfa da qui: il server rimette i dati com'erano e,
   * se il messaggio alla cliente non è ancora partito, lo ferma. Non chiede
   * conferme (in agenda non se ne chiedono): se non si può più tornare
   * indietro lo dice il server, e l'avviso riporta il suo motivo. */
  const undoLast = useCallback(async (entryId) => {
    if (!canWrite) { noWrite(); return; }
    if (undoing) return;
    setUndoing(true);
    try {
      const res = await api.post('/api/agenda/undo', entryId ? { entry_id: entryId } : {});
      // Il gesto può aver riportato l'appuntamento su un altro giorno: senza
      // questo salto si annullava «a vuoto», con la griglia ferma dov'era.
      if (res.date && res.date !== dateRef.current) setDate(res.date);
      fireToast({ msg: t('Annullato · ' + res.label, 'Undone · ' + res.label), icon: 'undo' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) fireToast({ msg: t('Non c\'è più niente da annullare', 'Nothing left to undo'), icon: 'info' });
      else toastErr(err, t, fireToast);
    } finally {
      setUndoing(false);
      refetchAll();
    }
  }, [canWrite, noWrite, undoing, fireToast, t, refetchAll]);

  /* ⌘Z / Ctrl+Z: la scorciatoia che tutti provano d'istinto. Non ruba il tasto
   * a chi sta scrivendo in un campo né a un modale aperto, dove annullerebbe
   * una cosa diversa da quella che si ha davanti. */
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if ((e.key || '').toLowerCase() !== 'z') return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      if (modal || groupOpen) return;
      e.preventDefault();
      undoLast();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undoLast, modal, groupOpen]);

  /* ---- mutations (drag & drop, pauses) ---- */
  const [pending, setPending] = useState(null); // optimistic override { kind, id, startMin, opId, dur }
  /* Forzatura: lo staff può andare oltre le regole (fuori turno, centro chiuso,
   * sovrapposizione) e non gli viene chiesto niente, mai. Chi lavora qui tutti
   * i giorni SA quando sta incastrando una cliente: ogni conferma era una
   * finestra da chiudere, non una protezione. Si scrive e basta, con
   * force=true, e resta l'avviso normale con «Annulla». */
  // Trascinamento in corso in vista giorno: accende i giorni in alto come
  // bersaglio, altrimenti nessuno immagina di poterci lasciare sopra un blocco.
  const [dragOn, setDragOn] = useState(false);

  /* Sposta la visita sul giorno a video, all'ora `startMin`, e con `opId` (se
   * diversa dalla colonna di partenza) passa di mano i servizi di quella
   * colonna. Ritorna true se il server ha scritto lo spostamento. */
  const moveAppt = async (a, startMin, opId, opts = {}) => {
    const fromMin = aMin(a.start);
    /* Colonna di PARTENZA del gesto: non è per forza quella dell'operatrice
     * principale. Una visita può avere i servizi divisi fra due colleghe, e
     * trascinando il gruppo di una devono cambiare mano i SUOI servizi — è
     * quello che dice `from_operator_id` al server. */
    const fromOp = opts.fromOp ?? a.operator_id;
    const toOp = opId ?? fromOp;
    const reassigned = toOp !== fromOp;
    // Il giorno di partenza conta quanto ora e colonna: vedi moveIsNoop.
    const fromDate = toDateStr(a.start);
    if (moveIsNoop(startMin, toOp, { startMin: fromMin, opId: fromOp, date: fromDate }, date)) return false;
    const otherDay = fromDate !== date;
    setPending({ kind: 'appt', id: a.id, startMin, opId: toOp, fromOp });
    try {
      await api.post(`/api/agenda/appointments/${a.id}/move`, {
        start: isoAtMin(date, startMin),
        // L'operatrice si manda solo se cambia davvero: mandarla sempre faceva
        // rivalidare l'idoneità anche a un semplice spostamento d'orario, e un
        // servizio tolto dall'elenco della collega bloccava il trascinamento.
        ...(reassigned ? { operator_id: toOp, from_operator_id: fromOp } : {}),
        force: !!opts.force,
      });
      const opName = firstName((operators.find((o) => o.id === toOp) || {}).first_name || '');
      // Su un altro giorno l'avviso lo dice: «Spostato alle 10:00» a chi ha
      // appena portato la cliente da martedì a giovedì non spiegava niente.
      const dd = parseISO(date);
      const when = otherDay
        ? t(`${DOW_IT[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(startMin)}`, `${DOW_EN[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(startMin)}`)
        : timeLabel(startMin);
      const where = reassigned
        ? t(`Spostato a ${opName}, ${when}`, `Moved to ${opName}, ${when}`)
        : otherDay
          ? t('Spostato a ' + when, 'Moved to ' + when)
          : t('Spostato alle ' + when, 'Moved to ' + when);
      fireToast({
        msg: where + (opts.warn ? ' · ' + opts.warn : ''),
        icon: opts.warn ? 'alert' : 'calendar',
        undo: opts.undo === false ? undefined : t('Annulla', 'Undo'),
        // Passa dal «torna indietro» del server, non da uno spostamento al
        // contrario: così l'orario torna quello di prima E il messaggio alla
        // cliente, se non è ancora partito, non parte affatto. Rifare la strada
        // al contrario ne avrebbe invece fatti partire due.
        undoFn: opts.undo === false ? undefined : () => undoLast(),
      });
      // lo spostamento è scritto: un ricarico andato male non lo rende fallito
      await fetchDay().catch(() => {});
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !opts.force && canWrite) {
        // Lo slot non è libero: si sposta comunque, senza fermare chi lavora.
        // `await` qui dentro: il `finally` deve aspettare il secondo tentativo.
        return await moveAppt(a, startMin, opId, { ...opts, force: true });
      }
      if (err instanceof ApiError && err.status === 409) fireToast({ msg: t('Spostamento rifiutato', 'Move refused'), icon: 'alert' });
      else toastErr(err, t, fireToast);
      await fetchDay().catch(() => {}); // revert to server truth
      return false;
    } finally { setPending(null); }
  };

  /* Stacco col trascinamento: il servizio esce dalla visita e diventa un
   * appuntamento a sé allo slot dove è stato lasciato. Come per lo spostamento,
   * uno slot occupato non ferma nessuno: si forza e lo si scrive nell'avviso.
   * Ma si prova PRIMA senza forzare, altrimenti ogni stacco su un orario libero
   * resterebbe marcato «forzato» in agenda senza motivo. */
  const splitItem = async (appt, item, startMin, opId, opts = {}) => {
    if (!canWrite) { noWrite(); return; }
    // `opts.dateIso`: lo stacco può finire su un altro giorno (forbici lasciate
    // sulla striscia in alto). Senza, la data era sempre quella a video e il
    // servizio restava qui.
    const iso = opts.dateIso || date;
    const otherDay = iso !== date;
    setPending({ kind: 'appt', id: appt.id, startMin: aMin(appt.start), opId: appt.operator_id });
    try {
      await api.post(`/api/agenda/appointments/${appt.id}/split`, {
        item_id: item.id,
        start: isoAtMin(iso, startMin),
        operator_id: opId && opId !== item.operator_id ? opId : null,
        force: !!opts.force,
      });
      const dd = parseISO(iso);
      const when = otherDay
        ? t(`${DOW_IT[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(startMin)}`, `${DOW_EN[(dd.getDay() + 6) % 7]} ${dd.getDate()}, ${timeLabel(startMin)}`)
        : timeLabel(startMin);
      fireToast({
        msg: t(`${item.service_name} staccato alle ${when}`, `${item.service_name} detached at ${when}`)
          + (opts.warn ? ' · ' + opts.warn : ''),
        icon: opts.warn ? 'alert' : 'scissors',
        undo: t('Annulla', 'Undo'),
        undoFn: () => undoLast(),
      });
      await fetchDay();
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !opts.force) {
        await splitItem(appt, item, startMin, opId, { ...opts, force: true });
        return;
      }
      toastErr(err, t, fireToast);
      await fetchDay().catch(() => {});
    } finally { setPending(null); }
  };

  /* Appuntamento aperto nel pannello: con quello a video, un clic su uno spazio
   * libero vuol dire «spostalo qui» — è il gesto della cliente che chiama per
   * spostare, e prima bisognava indovinare l'orario e scriverlo a mano. */
  // La copia più fresca che si ha: quella riletta dopo le modifiche del
  // pannello, altrimenti quella dell'apertura.
  const openAppt = modal?.name === 'apptdetail'
    ? ((apptFresh && apptFresh.modalId === modal.id && apptFresh.appt) || modal.props?.appointment || null)
    : null;
  /* Ombra dell'appuntamento aperto: mentre dal pannello si sfogliano i
   * giorni, si vede dove andrebbe a finire — alla sua ora, nella colonna di
   * chi lo fa. Sul suo giorno non serve: lì c'è il blocco vero, cerchiato. */
  const ghostAppt = openAppt && toDateStr(openAppt.start) !== date ? openAppt : null;
  /* `slot` = il menu dello slot: { opId, startMin, ghostHit }. Clic sull'ombra
   * = stessa ora e stesse operatrici su questo giorno; clic su uno spazio
   * libero = quell'ora, con la colonna cliccata (vedi moveHereTarget). */
  const moveOpenApptHere = async (a, slot) => {
    setSlotMenu(null);
    if (!canWrite) { noWrite(); return; }
    // Si parte dall'appuntamento com'è ADESSO sul server: ora, giorno e
    // operatrice di partenza devono essere quelli veri, non quelli di quando
    // si è aperto il pannello (lì può essere cambiato, o altrove).
    let cur = a;
    try { cur = await api.get(`/api/agenda/appointments/${a.id}`); } catch { /* si prova con la copia che c'è */ }
    const target = moveHereTarget(cur, slot);
    const from = { startMin: aMin(cur.start), opId: target.fromOp, date: toDateStr(cur.start) };
    if (moveIsNoop(target.startMin, target.opId ?? target.fromOp, from, date)) {
      // niente da mandare: lo si dice, invece di riaprire il pannello come
      // se lo spostamento fosse avvenuto
      fireToast({ msg: t('È già qui', 'Already here'), icon: 'info' });
      return;
    }
    await moveAppt(cur, target.startMin, target.opId, { fromOp: target.fromOp });
    try {
      // il pannello si riapre sui dati freschi, altrimenti resterebbe a mostrare
      // l'orario di prima mentre in griglia il blocco è già altrove
      const fresh = await api.get(`/api/agenda/appointments/${a.id}`);
      openApptDetail(fresh);
    } catch { /* il pannello resta com'è: la griglia è comunque aggiornata */ }
  };

  /* Rilascio sopra un giorno della striscia: stesso orario, giorno nuovo. */
  const moveApptToDate = async (a, iso, startMin, opts = {}) => {
    if (!canWrite) { noWrite(); return; }
    if (iso === date) { moveAppt(a, startMin, a.operator_id); return; }
    try {
      // Come per gli spostamenti in griglia: prima senza forzare, così un giorno
      // libero non lascia l'appuntamento marcato «forzato» senza motivo.
      await api.post(`/api/agenda/appointments/${a.id}/move`, { start: isoAtMin(iso, startMin), force: !!opts.force });
      const d = parseISO(iso);
      fireToast({
        msg: t(`Spostato a ${DOW_IT[(d.getDay() + 6) % 7]} ${d.getDate()}, ${timeLabel(startMin)}`, `Moved to ${DOW_EN[(d.getDay() + 6) % 7]} ${d.getDate()}, ${timeLabel(startMin)}`)
          + (opts.warn ? ' · ' + opts.warn : ''),
        icon: opts.warn ? 'alert' : 'calendar',
        undo: t('Annulla', 'Undo'),
        undoFn: () => undoLast(),
      });
      refetchAll();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !opts.force) {
        await moveApptToDate(a, iso, startMin, { force: true });
        return;
      }
      toastErr(err, t, fireToast);
      refetchAll();
    }
  };

  /* Rilascio fuori dalle regole (fuori turno, sopra un'altra cliente): il
   * blocco va dove è stato lasciato, punto. L'avviso raccontava ogni volta che
   * si stava «forzando» qualcosa — al banco lo sanno già, e il toast copriva
   * l'agenda nel momento di punta. Resta l'avviso normale dello spostamento,
   * con «Annulla». */
  const onInvalidDrop = (verdict, d, intent) => {
    // L'idoneità non si forza: il server rifiuta comunque (400) e forzare qui
    // voleva dire una chiamata sicuramente persa. Si dice perché, e basta.
    if (verdict.code === 'skill' || !canWrite || !intent) {
      fireToast({ msg: verdict.label + (verdict.detail ? ' · ' + verdict.detail : ''), icon: 'alert' });
      return;
    }
    if (intent.kind === 'split') {
      // Senza questo ramo lo stacco su uno slot non valido non faceva NULLA: il
      // blocco tornava al suo posto e non succedeva niente.
      splitItem(intent.appt, intent.item, intent.startMin, intent.opId, { force: true });
    } else if (intent.kind === 'appt') {
      moveAppt(intent.appt, intent.newApptStart, intent.opArg, { force: true, fromOp: intent.fromOp });
    } else if (intent.kind === 'pause') {
      movePause(intent.pause, intent.startMin, intent.opId);
    }
  };

  /* «da richiamare»: ripristino di uno slot liberato per caparra non pagata */
  const restoreReleased = async (a, force = false) => {
    try {
      await api.post(`/api/agenda/appointments/${a.id}/restore`, { force });
      fireToast({ msg: t(`Appuntamento di ${firstName(a.client?.full_name)} ripristinato`, `${firstName(a.client?.full_name)}'s appointment restored`), icon: 'check' });
      refetchAll();
    } catch (err) {
      // Lo slot nel frattempo si è riempito: si rimette comunque dov'era. Chi
      // preme «ripristina» ha già deciso, e la barra di conferma era l'ennesima
      // finestra da chiudere.
      if (err instanceof ApiError && err.status === 409 && !force) { restoreReleased(a, true); return; }
      toastErr(err, t, fireToast);
    }
  };

  const movePause = async (p, startMin, opId, opts = {}) => {
    setPending({ kind: 'pause', id: p.id, startMin, opId });
    try {
      await api.put(`/api/agenda/pauses/${p.id}`, { operator_id: opId, start: isoAtMin(date, startMin), duration_min: p.duration_min, note: p.note || '' });
      if (opts.undo !== false) {
        fireToast({
          msg: t('Pausa spostata alle ' + timeLabel(startMin), 'Break moved to ' + timeLabel(startMin)) + (opts.warn ? ' · ' + opts.warn : ''),
          icon: opts.warn ? 'alert' : 'clock',
          undo: t('Annulla', 'Undo'),
          undoFn: () => undoLast(),
        });
      }
      await fetchDay();
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) { toastErr(err, t, fireToast); await fetchDay().catch(() => {}); }
    finally { setPending(null); }
  };

  const resizePause = async (p, dur) => {
    if (dur === p.duration_min) return;
    setPending({ kind: 'pause', id: p.id, startMin: aMin(p.start), opId: p.operator_id, dur });
    try {
      await api.put(`/api/agenda/pauses/${p.id}`, { operator_id: p.operator_id, start: p.start, duration_min: dur, note: p.note || '' });
      await fetchDay();
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) { toastErr(err, t, fireToast); await fetchDay().catch(() => {}); }
    finally { setPending(null); }
  };

  const deletePause = async (p) => {
    try {
      await api.del(`/api/agenda/pauses/${p.id}`);
      fireToast({ msg: t('Pausa rimossa', 'Break removed'), icon: 'x', undo: t('Annulla', 'Undo'), undoFn: () => undoLast() });
      await fetchDay();
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) { toastErr(err, t, fireToast); }
  };

  // #1 — resize del bordo inferiore di un blocco = nuova durata di QUEL servizio.
  // Invia l'intera lista item (il backend onora duration_min per item e non ritocca la caparra).
  const resizeItem = async (appt, item, newDur, opts = {}) => {
    if (!newDur || newDur === item.duration_min) return;
    try {
      const items = (appt.items || []).map((it) => ({
        id: it.id, service_id: it.service_id, operator_id: it.operator_id,
        duration_min: it.id === item.id ? newDur : it.duration_min,
      }));
      await api.put(`/api/agenda/appointments/${appt.id}`, { items, force: !!opts.force });
      fireToast({ msg: t('Durata aggiornata', 'Duration updated'), icon: 'check' });
      await fetchDay();
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) {
      // Allungare un trattamento mentre accanto c'è un'altra cliente (o oltre
      // l'orario di chiusura) rispondeva «Orario non più disponibile» e il
      // blocco tornava com'era: al banco si allunga e basta, come per gli
      // spostamenti. Si riprova forzando, una volta sola.
      if (err instanceof ApiError && err.status === 409 && !opts.force && canWrite) {
        await resizeItem(appt, item, newDur, { force: true });
        return;
      }
      toastErr(err, t, fireToast);
      await fetchDay().catch(() => {});
    }
  };

  const addBreak = async (opId, startMin, dur) => {
    setSlotMenu(null);
    try {
      await api.post('/api/agenda/pauses', { operator_id: opId, start: isoAtMin(date, startMin), duration_min: dur || 60 });
      const o = operators.find((x) => x.id === opId);
      fireToast({
        msg: t(`Pausa aggiunta · ${firstName(o?.first_name)} alle ${timeLabel(startMin)}`, `Break added · ${firstName(o?.first_name)} at ${timeLabel(startMin)}`),
        icon: 'clock',
      });
      await fetchDay();
      fetchUndo();   // la pila di «torna indietro» segue ogni gesto
    } catch (err) { toastErr(err, t, fireToast); }
  };

  /* ---- toolbar helpers ---- */
  const MONTHS = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const cur = parseISO(date);
  const navPrev = () => {
    if (calView === 'day') { const d = parseISO(date); d.setDate(d.getDate() - 1); setDate(toDateStr(d)); }
    else if (calView === 'week') { const d = parseISO(date); d.setDate(d.getDate() - 7); setDate(toDateStr(d)); }
    else setDate(addMonths(date, -1));
  };
  const navNext = () => {
    if (calView === 'day') { const d = parseISO(date); d.setDate(d.getDate() + 1); setDate(toDateStr(d)); }
    else if (calView === 'week') { const d = parseISO(date); d.setDate(d.getDate() + 7); setDate(toDateStr(d)); }
    else setDate(addMonths(date, 1));
  };
  const jumpToMonth = (m, y) => { setCalView('month'); setDate(toDateStr(new Date(y, m, 1))); setJumpOpen(false); };
  const jumpToDate = (iso) => { if (!iso) return; setDate(iso); setCalView('day'); setJumpOpen(false); };

  const monday = mondayOf(date);
  const weekDays = [...Array(7)].map((_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    return d;
  });
  const periodLabel = () => {
    if (calView === 'month') return MONTHS[cur.getMonth()] + ' ' + cur.getFullYear();
    const s = weekDays[0], e = weekDays[6];
    return s.getMonth() === e.getMonth()
      ? `${s.getDate()}–${e.getDate()} ${MONTHS[e.getMonth()]} ${e.getFullYear()}`
      : `${s.getDate()} ${MONTHS[s.getMonth()].slice(0, 3)} – ${e.getDate()} ${MONTHS[e.getMonth()].slice(0, 3)} ${e.getFullYear()}`;
  };

  const openDay = (iso) => { setDate(iso); setCalView('day'); };
  // Nessun fallback "mostra tutte": spegnendo tutte le chip la griglia deve
  // restare vuota (lo stato vuoto è già previsto), non riaccendere tutto.
  /* Le chip decidono quali COLONNE si disegnano, non quali dati esistono: il
   * payload elenca ogni appuntamento una volta sola, nella riga dell'operatrice
   * principale, ma i suoi servizi possono essere di altre. Filtrando anche i
   * dati, spegnere una chip faceva sparire il lavoro delle colleghe rimaste e
   * dichiarava «Disponibile» uno slot occupato davvero. */
  const allRows = dayData || [];
  const visibleRows = allRows.filter((r) => vis[r.operator.id] !== false);

  // Prenotazione aperta: un clic sulla griglia (giorno o settimana) sceglie
  // l'orario. Stava solo in vista giorno, e in settimana il clic apriva un
  // drawer nuovo sopra quello in corso.
  const pickBanner = pickMode ? (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 26px', background: 'var(--clay-tint)', borderBottom: '1px solid var(--hair)', color: 'var(--clay-ink)', fontSize: 13, fontWeight: 600 }}>
      <Icon name="target" size={15} color="var(--clay-ink)" />
      {t('Scelta orario: clicca uno spazio libero per impostare orario e operatrice nella prenotazione', 'Pick a time: click a free space to set time and stylist in the booking')}
    </div>
  ) : null;

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* timeline column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* sub toolbar */}
        {/* va a capo quando lo spazio non basta: prima il selettore vista (Giorno/
          * Settimana/Mese) veniva tagliato dal pannello laterale aperto. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, rowGap: 10, padding: '16px 26px', borderBottom: '1px solid var(--hair)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <button className="dk-iconbtn" style={{ width: 38, height: 38 }} onClick={navPrev}><Icon name="chevL" size={18} /></button>
            <button className="dk-iconbtn" style={{ width: 38, height: 38 }} onClick={navNext}><Icon name="chevR" size={18} /></button>
          </div>
          {calView === 'day' ? (
            <React.Fragment>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setJumpOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap' }}>
                  {MONTHS[cur.getMonth()] + ' ' + cur.getFullYear()}
                  <Icon name="chevD" size={15} color="var(--muted)" style={{ transform: jumpOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
                </button>
                {jumpOpen && <JumpPopover t={t} MONTHS={MONTHS} curM={cur.getMonth()} curY={cur.getFullYear()} onClose={() => setJumpOpen(false)} onMonth={jumpToMonth} onDate={jumpToDate} />}
              </div>
              {/* week day strip — real dates */}
              {/* Durante un trascinamento la striscia diventa un bersaglio: si può
                  lasciare un appuntamento su un giorno per spostarlo lì. */}
              <div style={{ display: 'flex', gap: 4, background: dragOn ? 'var(--clay-tint)' : 'var(--surface)', border: '1px solid ' + (dragOn ? 'var(--clay)' : 'var(--hair)'), borderRadius: 14, padding: 4, transition: 'background 150ms, border-color 150ms' }}>
                {weekDays.map((d, i) => {
                  const iso = toDateStr(d);
                  const sel = iso === date;
                  const dropTarget = dragOn && !sel;
                  return (
                    <button key={i} onClick={() => setDate(iso)} data-daydrop={iso}
                      title={dragOn ? t('Lascia qui per spostare a questo giorno', 'Drop here to move to this day') : undefined}
                      // L'evidenza NON deve usare il bordo: aggiungerlo allarga le
                      // pillole, la striscia si sposta sotto il cursore e il
                      // rilascio finisce nel vuoto fra una e l'altra. `outline`
                      // non occupa spazio.
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '6px 13px', borderRadius: 10, cursor: 'pointer', background: sel ? 'var(--ink)' : dropTarget ? 'var(--surface)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', border: 'none', outline: dropTarget ? '1.5px dashed var(--clay)' : 'none', outlineOffset: -2, transition: 'background 150ms' }}>
                      <span style={{ fontSize: 10.5, fontWeight: 600, opacity: sel ? 0.7 : 0.5 }}>{t(DOW_IT[i], DOW_EN[i])}</span>
                      <span className="t-num" style={{ fontSize: 17, color: sel ? '#fff' : 'var(--ink)' }}>{d.getDate()}</span>
                    </button>
                  );
                })}
              </div>
              {!isToday && <button className="dk-btn dk-btn--soft" style={{ height: 40 }} onClick={() => setDate(todayStr())}>{t('Oggi', 'Today')}</button>}
            </React.Fragment>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ position: 'relative' }}>
                <button onClick={() => setJumpOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer', background: 'transparent', border: 'none', fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 500, color: 'var(--ink)' }}>
                  {periodLabel()}
                  <Icon name="chevD" size={16} color="var(--muted)" style={{ transform: jumpOpen ? 'rotate(180deg)' : 'none', transition: 'transform 140ms' }} />
                </button>
                {jumpOpen && <JumpPopover t={t} MONTHS={MONTHS} curM={cur.getMonth()} curY={cur.getFullYear()} onClose={() => setJumpOpen(false)} onMonth={jumpToMonth} onDate={jumpToDate} />}
              </div>
              {!isToday && <button className="dk-btn dk-btn--soft" style={{ height: 36 }} onClick={() => setDate(todayStr())}>{t('Oggi', 'Today')}</button>}
            </div>
          )}
          <SalonHoursChip settings={settings} date={date} t={t} isOwner={!!session?.is_owner} onOpen={() => { setDeepLink && setDeepLink('hours'); setTab('impostazioni'); }} />
          <div style={{ flex: 1, minWidth: 0 }} />
          {canWrite && (
            <React.Fragment>
              {/* Torna indietro. Sta qui, sempre allo stesso posto, e non compare
                * e scompare: chi ha appena sbagliato un gesto deve trovarlo dove
                * si aspetta, non cercarlo. Spento quando non c'è niente da
                * annullare, con l'ultima azione scritta nel suggerimento. */}
              <button
                className="dk-btn dk-btn--soft"
                style={{ height: 40, flexShrink: 0, opacity: undoStack.length && !undoing ? 1 : 0.4, cursor: undoStack.length && !undoing ? 'pointer' : 'default' }}
                disabled={!undoStack.length || undoing}
                onClick={() => undoLast(undoStack[0]?.id)}
                aria-label={t('Torna indietro', 'Undo')}
                title={(undoStack[0]
                  ? t(`Torna indietro · ${undoStack[0].label}`, `Undo · ${undoStack[0].label}`)
                  : t('Niente da annullare', 'Nothing to undo')) + '  (⌘Z)'}
              >
                <Icon name="undo" size={16} />{t('Indietro', 'Undo')}
              </button>
              <button className="dk-btn dk-btn--soft" style={{ height: 40, flexShrink: 0 }} onClick={() => setGroupOpen(true)} title={t('Prenota più clienti insieme', 'Book several clients together')}>
                <Icon name="clients" size={16} />{t('Gruppo', 'Group')}
              </button>
            </React.Fragment>
          )}
          {/* Zoom: quanto è alta un'ora sullo schermo. Sta accanto al selettore
              di vista perché è la stessa famiglia di gesti — «quanto ne vedo».
              Nel mese non ha senso: lì non c'è una linea del tempo da stirare,
              e il comando sparisce invece di restare lì a non fare niente. */}
          {calView !== 'month' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 17, fontWeight: 700, lineHeight: 1 }} disabled={zoom <= ZOOM_MIN + 0.001}
                onClick={() => setZoom((z) => zoomStep(z, -1))} title={t('Rimpicciolisci: più ore sullo schermo (tasto −, o ⌘ e rotella)', 'Zoom out: more hours on screen (− key, or ⌘ and wheel)')} aria-label={t('Rimpicciolisci', 'Zoom out')}>−</button>
              <button onClick={() => setZoom(1)} title={t('Torna alla scala normale (0)', 'Back to normal scale (0)')}
                className="tabnum" style={{ minWidth: 44, padding: '0 4px', height: 30, borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: Math.abs(zoom - 1) < 0.01 ? 'var(--muted)' : 'var(--ink)' }}>
                {Math.round(zoom * 100)}%
              </button>
              <button className="dk-iconbtn" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 17, fontWeight: 700, lineHeight: 1 }} disabled={zoom >= ZOOM_MAX - 0.001}
                onClick={() => setZoom((z) => zoomStep(z, 1))} title={t('Ingrandisci: ore più alte, si leggono i quarti (tasto +, o ⌘ e rotella)', 'Zoom in: taller hours, quarters readable (+ key, or ⌘ and wheel)')} aria-label={t('Ingrandisci', 'Zoom in')}>+</button>
              <button onClick={fitZoom} style={{ height: 30, padding: '0 9px', borderRadius: 9, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: 'var(--ink-2)' }}
                title={t('Adatta: tutta la giornata in una schermata, senza scorrere', 'Fit: the whole day in one screen, no scrolling')}>{t('Adatta', 'Fit')}</button>
            </div>
          )}
          {/* view selector: Giorno / Settimana / Mese */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 12, padding: 4, flexShrink: 0 }}>
            {[['day', 'Giorno', 'Day'], ['week', 'Settimana', 'Week'], ['month', 'Mese', 'Month']].map(([v, it, en]) => {
              const sel = calView === v;
              return <button key={v} onClick={() => setCalView(v)} style={{ padding: '8px 15px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: 'none', background: sel ? 'var(--ink)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', transition: 'all 140ms' }}>{t(it, en)}</button>;
            })}
          </div>
        </div>

        {/* body — day / week / month */}
        {calView === 'week' ? (
          <React.Fragment>
            {pickBanner}
            <WeekView weekStart={toDateStr(monday)} operators={operators} colorOf={colorOf} itemColor={itemColor} nowMin={isTodayInWeek(weekDays) ? nowMin : null} onOpenDay={openDay} onNewAppt={pickNewAppt} onOpenAppt={openApptDetail} pickMode={pickMode} onShowDate={setDate} ghost={ghostAppt} ghostDate={date} zoom={zoom} onZoom={setZoom} />
          </React.Fragment>
        ) : calView === 'month' ? (
          <MonthView anchor={date} onOpenDay={openDay} />
        ) : (
          <React.Fragment>
            {/* staff visibility filter chips */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 26px', borderBottom: '1px solid var(--hair)', overflowX: 'auto' }}>
              <span className="t-meta" style={{ flexShrink: 0 }}>{t('Calendari', 'Calendars')}</span>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'nowrap' }}>
                {operators.map((o) => {
                  const on = vis[o.id] !== false;
                  const col = colorOf(o.id);
                  return (
                    <button key={o.id} onClick={() => toggleVis(o.id)} aria-pressed={on} title={`${o.first_name} ${o.last_name}`.trim() + (o.role_title ? ' · ' + o.role_title : '') + ' · ' + (on ? t('visibile', 'shown') : t('nascosta', 'hidden'))} className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : ' dk-pill--muted')} style={{ '--pill-c': col, padding: '4px 11px 4px 5px', flexShrink: 0 }}>
                      <Avatar initials={o.initials} size={24} color={col} ring={on} />
                      <span>{opDisplay(o.first_name, o.last_name, opFirsts)}</span>
                      <Icon name={on ? 'check' : 'plus'} size={13} stroke={2.6} color={on ? 'var(--ink)' : 'var(--muted-2)'} />
                    </button>
                  );
                })}
              </div>
              <div style={{ flex: 1, minWidth: 8 }} />
              <span className="t-sm tabnum" style={{ color: 'var(--muted)', fontWeight: 600, flexShrink: 0 }}>{visCount}/{operators.length}</span>
              <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5, flexShrink: 0 }} onClick={() => setAll(!allOn)}>{allOn ? t('Deseleziona', 'Clear') : t('Tutte', 'All')}</button>
            </div>

            {pickBanner}
            {dayData === null ? (
              <DaySkeleton />
            ) : (
              <DayGrid
                rows={visibleRows}
                ghost={ghostAppt}
                zoom={zoom}
                onZoom={setZoom}
                allRows={allRows}
                date={date}
                pickMode={pickMode}
                nowMin={isToday ? nowMin : null}
                colorOf={colorOf}
                itemColor={itemColor}
                pending={pending}
                canWrite={canWrite}
                showRevenue={showRevenue}
                picker={picker}
                setPicker={setPicker}
                setOpColor={setOpColor}
                opPalette={opPalette}
                onHover={onHover}
                onLeave={() => setHover(null)}
                onOpenAppt={(a) => openApptDetail(a)}
                onInvalidDrop={onInvalidDrop}
                onDropOnDate={moveApptToDate}
                onDragChange={setDragOn}
                onSplitItem={splitItem}
                onSlotMenu={(opId, startMin, x, y, verdict, extra) => {
                  if (!canWrite) { noWrite(); return; }
                  if (pickMode) { setAgendaPick({ operatorId: opId, start: isoAtMin(date, startMin), date }); return; }
                  // `ghostHit`: il clic è caduto sull'ombra dell'appuntamento aperto
                  setSlotMenu({ opId, startMin, x, y, verdict, ghostHit: !!extra?.ghostHit });
                }}
                onMoveAppt={moveAppt}
                onResizeItem={resizeItem}
                onMovePause={movePause}
                onResizePause={resizePause}
                onDeletePause={deletePause}
              />
            )}
          </React.Fragment>
        )}
      </div>

      {/* right rail — collapsible */}
      {railOpen ? (
        <aside className="dk-rail" style={{ width: 'var(--rail-w)', flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', overflowY: 'auto', padding: '14px 22px 22px' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button className="dk-rail-toggle" onClick={() => setRailOpen(false)} title={t('Comprimi pannello', 'Collapse panel')} style={{ width: 30, height: 30, border: 'none' }}><Icon name="chevR" size={16} /></button>
          </div>
          <RightRail
            summary={summary}
            waitlist={waitlist}
            released={released}
            onRestore={(a) => restoreReleased(a)}
            onRebook={(a) => openNewAppt({ clientId: a.client?.id, clientName: a.client?.full_name, serviceIds: (a.items || []).map((i) => i.service_id), date })}
            onOpenAppt={(a) => openApptDetail(a)}
            onOpenLog={() => { setDeepLink && setDeepLink('log-today'); setTab('impostazioni'); }}
            onOpenWaitlist={() => openModal('waitlist')}
            onOpenOpportunity={() => openModal('opportunity')}
          />
        </aside>
      ) : (
        <aside style={{ width: 52, flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 4 }}>
          <button className="dk-rail-toggle" onClick={() => setRailOpen(true)} title={t('Espandi pannello', 'Expand panel')} style={{ width: 30, height: 30, border: 'none' }}><Icon name="chevL" size={16} /></button>
          <Icon name="calendar" size={18} color="var(--muted-2)" style={{ marginTop: 10 }} />
        </aside>
      )}

      {hover && <ApptHoverCard hover={hover} t={t} lang={lang} operators={operators} colorOf={colorOf} />}

      {/* slot menu — new appointment / add break */}
      {slotMenu && (
        <React.Fragment>
          <div onClick={() => setSlotMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 95 }} />
          <div className="dk-card" style={{ position: 'fixed', boxSizing: 'border-box', top: Math.min(slotMenu.y, window.innerHeight - (slotMenu.mode === 'break' ? 300 : 130)), left: Math.min(slotMenu.x, window.innerWidth - 246), zIndex: 96, width: 234, padding: 6, boxShadow: 'var(--sh-pop)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 10px 6px' }}>
              <div className="t-meta">{firstName((operators.find((o) => o.id === slotMenu.opId) || {}).first_name)} · {timeLabel(slotMenu.startMin)}</div>
              {/* Lo slot «non libero» resta prenotabile: qui si avvisa in ambra,
                  non si vieta in rosso. */}
              {slotMenu.verdict && (() => {
                const free = slotMenu.verdict.ok && slotMenu.verdict.code !== 'soak';
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 12.5, fontWeight: 700, color: free ? 'var(--ok)' : 'var(--warn)' }}>
                    <Icon name={free ? 'check' : 'alert'} size={13} stroke={2.6} color="currentColor" />
                    <span>{slotMenu.verdict.label}</span>
                  </div>
                );
              })()}
              {slotMenu.verdict?.detail && <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, fontSize: 12 }}>{slotMenu.verdict.detail}</div>}
            </div>
            {slotMenu.mode === 'break' ? (
              <div style={{ padding: '4px 8px 8px' }}>
                <div className="t-sm" style={{ fontWeight: 700, color: 'var(--muted)', margin: '4px 2px 8px' }}>{t('Durata pausa', 'Break duration')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
                  {[15, 30, 45, 60, 90, 120].map((d) => {
                    const on = (slotMenu.dur || 60) === d;
                    return (
                      <button key={d} onClick={() => setSlotMenu((m) => ({ ...m, dur: d }))} style={{ padding: '8px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)', color: on ? 'var(--clay-ink)' : 'var(--ink-2)' }}>{d < 60 ? d + ' min' : (d / 60) + ' h'}</button>
                    );
                  })}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '0 2px' }}>
                  <span className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>{t('Personalizzata', 'Custom')}</span>
                  <NumInput integer min={5} value={slotMenu.dur || 60} onChange={(dur) => setSlotMenu((m) => ({ ...m, dur }))} style={{ width: 64, textAlign: 'right', border: '1px solid var(--hair)', borderRadius: 8, padding: '6px 8px', fontSize: 13, fontWeight: 700, fontFamily: 'var(--mono, monospace)', outline: 'none' }} />
                  <span className="t-sm" style={{ color: 'var(--muted-2)' }}>min</span>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10, padding: '0 2px' }}>{timeLabel(slotMenu.startMin)}–{timeLabel(slotMenu.startMin + (slotMenu.dur || 60))}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="dk-btn dk-btn--ghost" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => setSlotMenu((m) => ({ ...m, mode: null }))}>{t('Indietro', 'Back')}</button>
                  <button className="dk-btn dk-btn--clay" style={{ flex: 1, minWidth: 0, height: 36, padding: '0 6px', boxSizing: 'border-box' }} onClick={() => addBreak(slotMenu.opId, slotMenu.startMin, slotMenu.dur || 60)}><Icon name="check" size={15} color="#fff" />{t('Aggiungi', 'Add')}</button>
                </div>
              </div>
            ) : (
              <React.Fragment>
                {/* Col dettaglio aperto, il primo gesto è spostare QUELLA
                    cliente: si sfogliano i giorni dal pannello e si clicca lo
                    spazio giusto, senza passare da nessun'altra schermata. */}
                {openAppt && (
                  <button className="dk-row" onClick={() => moveOpenApptHere(openAppt, slotMenu)} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="calendar" size={15} color="var(--clay-ink)" /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t(`Sposta qui ${firstName(openAppt.client?.full_name)}`, `Move ${firstName(openAppt.client?.full_name)} here`)}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t(`da ${fmtDateIt(toDateStr(openAppt.start), { weekday: false })} ${timeLabel(aMin(openAppt.start))}`, `from ${fmtDateIt(toDateStr(openAppt.start), { weekday: false })} ${timeLabel(aMin(openAppt.start))}`)}</div>
                    </div>
                  </button>
                )}
                <button className="dk-row" onClick={() => { const m = slotMenu; setSlotMenu(null); openNewAppt({ operatorId: m.opId, start: isoAtMin(date, m.startMin), date }); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Nuovo appuntamento', 'New appointment')}</div>
                    {/* Quando l'ora non è libera si può comunque insistere: il
                        pannello dell'orario, nel drawer, offre «Inserisci comunque».
                        Prometteva solo alternative, e chi voleva incastrare una
                        cliente sopra un'altra si fermava qui. */}
                    <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{slotMenu.verdict && !slotMenu.verdict.ok ? t(`alle ${timeLabel(slotMenu.startMin)} anche se occupato, o scegli un'alternativa`, `at ${timeLabel(slotMenu.startMin)} even if busy, or pick an alternative`) : t(`alle ${timeLabel(slotMenu.startMin)}`, `at ${timeLabel(slotMenu.startMin)}`)}</div>
                  </div>
                </button>
                <button className="dk-row" onClick={() => setSlotMenu((m) => ({ ...m, mode: 'break', dur: 60 }))} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left', border: 'none', background: 'transparent' }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="clock" size={15} color="var(--muted)" /></div>
                  <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Aggiungi pausa', 'Add break')}</span>
                </button>
              </React.Fragment>
            )}
          </div>
        </React.Fragment>
      )}

      {/* #6 — prenotazione di gruppo: drawer con l'agenda visibile per scaglionare gli slot */}
      {groupOpen && (
        <GroupBookingDrawer date={date} onClose={() => setGroupOpen(false)} onCreated={refetchAll} />
      )}
    </div>
  );
}

/* minuti dalla mezzanotte di un ISO, nel fuso del salone (vedi shared/format.js) */
const aMin = (iso) => minutesOfDay(iso);

function isTodayInWeek(weekDays) {
  const today = todayStr();
  return weekDays.some((d) => toDateStr(d) === today);
}

/* ---- month/date jump popover ---- */
function JumpPopover({ t, MONTHS, curM, curY, onClose, onMonth, onDate }) {
  return (
    <React.Fragment>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 41, padding: 12, width: 260, boxShadow: 'var(--sh-pop)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => onMonth(curM, curY - 1)}><Icon name="chevL" size={14} /></button>
          <span style={{ fontWeight: 700, fontSize: 14 }}>{curY}</span>
          <button className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} onClick={() => onMonth(curM, curY + 1)}><Icon name="chevR" size={14} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6, marginBottom: 12 }}>
          {MONTHS.map((mo, mi) => {
            const on = mi === curM;
            return (
              <button key={mi} onClick={() => onMonth(mi, curY)} style={{ padding: '8px 4px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{mo.slice(0, 3)}</button>
            );
          })}
        </div>
        <div style={{ borderTop: '1px solid var(--hair)', paddingTop: 10 }}>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Vai a una data', 'Jump to a date')}</div>
          <input type="date" onChange={(e) => onDate(e.target.value)} style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13.5, padding: '8px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box' }} />
        </div>
      </div>
    </React.Fragment>
  );
}

/* ---- day grid loading skeleton ---- */
function DaySkeleton() {
  return (
    <div style={{ flex: 1, overflow: 'hidden', padding: '14px 26px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <div style={{ width: 64, flexShrink: 0 }} />
        {[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ flex: 1, height: 54, borderRadius: 12 }} />)}
      </div>
      <div style={{ display: 'flex', gap: 6, height: '100%' }}>
        <div style={{ width: 64, flexShrink: 0 }} />
        {[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ flex: 1, height: 520, borderRadius: 12 }} />)}
      </div>
    </div>
  );
}


/* ---- orari del centro per il giorno mostrato (Impostazioni → Orari di apertura) ---- */
function SalonHoursChip({ settings, date, t, isOwner, onOpen }) {
  const week = settings?.opening_hours_week;
  const has = week && Object.keys(week).length > 0;
  const idx = (parseISO(date).getDay() + 6) % 7;
  const ranges = has ? (week[String(idx)] || []) : null;
  const label = !has
    ? (isOwner ? t('Orari del centro: imposta', 'Salon hours: set') : t('Orari del centro non impostati', 'Salon hours not set'))
    : ranges.length
      ? t('Centro', 'Salon') + ' ' + ranges.map(([a, b]) => `${a.replace(/^0/, '')}–${b.replace(/^0/, '')}`).join(' · ')
      : t('Centro chiuso', 'Salon closed');
  return (
    <button type="button" onClick={onOpen} title={t('Orari di apertura del centro · clicca per modificarli', 'Salon opening hours · click to edit')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 34, padding: '0 12px', borderRadius: 99, border: '1px solid ' + (has ? 'var(--hair)' : 'var(--warn)'), background: has ? 'var(--surface)' : 'var(--warn-tint)', color: has ? (ranges.length ? 'var(--ink-2)' : 'var(--muted)') : 'var(--warn)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
      <Icon name="clock" size={13} color="currentColor" />
      <span className="tabnum">{label}</span>
    </button>
  );
}
