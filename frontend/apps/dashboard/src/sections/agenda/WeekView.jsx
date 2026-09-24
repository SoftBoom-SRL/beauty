// WeekView — 7-day overview from GET /api/agenda/week (per-op sub-columns, lane packing)
// Interactions mirror the day view (DayGrid): drag a block to reschedule/reassign,
// click a block to open its detail, click an empty slot to create a new appointment.
//
// Drag: il contenitore cattura il puntatore (setPointerCapture) così il rilascio
// arriva anche fuori dall'area; il blocco trascinato viene tolto dalla sua corsia e
// ridisegnato dove si trova il puntatore (giorno + operatrice + orario snappato),
// con traccia tratteggiata all'origine, colonna di destinazione evidenziata e badge
// che segue il cursore. Il 409 del server («occupato / fuori turno») apre un popover
// di conferma che ripete la POST con `force: true`, come nella vista giorno.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError, Icon, minutesOfDay, nowMinutes, timeLabel, todayStr, parseISO, statusMeta } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { ApptHoverCard } from './DayGrid.jsx';
import {
  DK_START, PXM, clampZoom, DOW_IT, DOW_EN, weekLayout, fmtMoney, toastErr, opDisplay, isoAtMin,
  GRID_LINE_STYLE, gridMarks, opSegments, serviceBands, AGENDA_LIVE_RE, weekDayOps, apptRevenue, weekGridRange,
} from './lib.js';

// oggi: tinta discreta derivata dal tema (era #D6E4F7 hardcoded); bordo giorno più leggero di --clay
const TODAY_BG = 'color-mix(in srgb, var(--clay) 12%, var(--paper))';
const DAY_BORDER = '1px solid var(--hair)';
const GUTTER_W = 46;   // colonna delle ore
const SUBCOL_W = 48;   // larghezza minima di una sotto-colonna operatrice
const DAY_MIN_W = 120;

export default function WeekView({ weekStart, operators, colorOf, itemColor, nowMin = null, onOpenDay, onNewAppt, onOpenAppt, pickMode = false, undoMark, undoAfter, onShowDate, ghost, ghostDate, zoom = 1, onZoom }) {
  const { t, lang, showRevenue, fireToast, openModal, hasScope, settings, live, locationId, modal } = useDash();
  // come in vista giorno: il blocco aperto nel pannello resta cerchiato
  const openApptId = modal?.name === 'apptdetail' ? (modal.props?.appointment?.id ?? null) : null;
  const canWrite = hasScope('agenda');
  const step = settings?.slot_interval_min || 15;   // granularità fasce orarie (Impostazioni)
  const opFirsts = operators.map((o) => o.first_name); // per la disambiguazione omonimie
  const [days, setDays] = useState(null); // null = loading
  const [opTip, setOpTip] = useState(null); // { name, x, y }
  const [pending, setPending] = useState(null);   // { id, dayIdx, ns, nop }: il blocco resta dove è stato lasciato durante la POST
  const [, force] = useState(0);            // re-render on drag ghost changes
  // Anteprima al passaggio del mouse, come nella vista giorno: in settimana i
  // blocchi sono stretti e il solo `title` del browser arriva tardi e dice poco.
  const [hover, setHover] = useState(null);
  const scrollRef = useRef(null);
  const headRef = useRef(null);             // intestazione fissa dei giorni
  const drag = useRef(null);                // active drag { id, obj, ns, nop, dayIdx, moved, ... }
  const justDragged = useRef(false);        // suppress the click that follows a drop
  const onUpRef = useRef(null);             // ultimo onUp (chiusura fresca) per il fallback su window
  // evento di un puntatore diverso da quello che ha cominciato il trascinamento
  const otherPointer = (e) => {
    const d = drag.current;
    return !!(d && e && e.pointerId != null && d.pointerId != null && e.pointerId !== d.pointerId);
  };
  /* Apre la nuova prenotazione una volta sola: il doppio clic manda due click
   * più un dblclick, e senza questa guardia il drawer si rimontava tre volte. */
  const lastOpen = useRef({ at: 0, key: '' });

  /* reusable refetch (no skeleton flash) — used after a move and passed to the detail modal.
   * Settimana e sede si leggono da una ref, e un numero di sequenza scarta le
   * risposte superate, come fa fetchDay in vista giorno. Il pannello teneva il
   * ricarico di quando si era aperto: sfogliata la settimana dopo, «Salva»
   * rileggeva la 21–27 e la mostrava sotto l'intestazione «28 set – 4 ott», e
   * clic e trascinamenti lavoravano sulle date vecchie. Stessa corsa fra un
   * evento live e un cambio di settimana. */
  const weekSeq = useRef(0);
  const weekRef = useRef(weekStart);
  weekRef.current = weekStart;
  const locRef = useRef(locationId);
  locRef.current = locationId;
  const weekParams = (start, loc) => ({ params: { start, ...(loc ? { location_id: loc } : {}) } });
  const refetchWeek = useCallback(() => {
    const my = ++weekSeq.current;
    const forWeek = weekRef.current, forLoc = locRef.current;
    return api.get('/api/agenda/week', weekParams(forWeek, forLoc))
      .then((rows) => {
        if (my === weekSeq.current && forWeek === weekRef.current && forLoc === locRef.current) setDays(rows);
      })
      .catch((err) => {
        if (my !== weekSeq.current) return;
        toastErr(err, t, fireToast);
        setDays((cur) => cur ?? []);   // mai uno scheletro senza fine
      });
  }, [t, fireToast]);
  const refetchWeekRef = useRef(refetchWeek);
  refetchWeekRef.current = refetchWeek;

  // live: modifiche dalle altre postazioni → ricarica la settimana senza skeleton
  useEffect(() => live.subscribe(({ events }) => {
    if (events.some((e) => AGENDA_LIVE_RE.test(e.type))) refetchWeek();
  }), [live, refetchWeek]);

  useEffect(() => {
    const my = ++weekSeq.current;
    setDays(null);
    api.get('/api/agenda/week', weekParams(weekStart, locationId))
      .then((rows) => { if (my === weekSeq.current) setDays(rows); })
      .catch((err) => { if (my === weekSeq.current) { setDays([]); toastErr(err, t, fireToast); } });
  }, [weekStart, locationId]); // eslint-disable-line react-hooks/exhaustive-deps
  // smontaggio: le risposte in volo non scrivono più niente
  useEffect(() => () => { weekSeq.current++; }, []);

  /* Zoom: stessa scala e stesso gesto della vista giorno (⌘/ctrl + rotella o
   * pinch del trackpad), tenendo fermo il minuto che si stava guardando. */
  const zoomAnchor = useRef(null);
  const lastZoom = useRef(zoom);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = lastZoom.current;
    if (!el || prev === zoom) return;
    lastZoom.current = zoom;
    const body = el.querySelector('[data-daycol]')?.parentElement;
    if (!body) return;
    const top0 = body.offsetTop;
    const offset = zoomAnchor.current?.offset ?? el.clientHeight / 2;
    zoomAnchor.current = null;
    const minute = G0 + (el.scrollTop + offset - top0) / (PXM * prev);
    el.scrollTop = (minute - G0) * (PXM * zoom) + top0 - offset;
    // Solo lo zoom sposta lo scroll. G0 non può stare fra le dipendenze: è
    // dichiarata più sotto, e leggerla qui durante il render sarebbe un errore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onZoom) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAnchor.current = { offset: e.clientY - el.getBoundingClientRect().top };
      // valore precedente dallo stato: il pinch manda una raffica di eventi
      // nello stesso istante, e partendo tutti dallo stesso numero se ne
      // sarebbe sentito uno solo
      onZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onZoom]);

  useEffect(() => () => document.body.classList.remove('dk-dragging'), []);
  // Esc annulla il drag; pointerup/pointercancel su window:
  // se la capture non è supportata o il rilascio avviene fuori dall'area, il drag
  // non resta mai "appeso".
  // Esc con `preventDefault` (contratto di ui/layers.js), e in cattura: annulla
  // il trascinamento e basta, senza chiudere anche il pannello aperto sotto.
  // Gli eventi di un altro dito non chiudono il trascinamento (vedi otherPointer).
  useEffect(() => {
    const cancel = () => { drag.current = null; document.body.classList.remove('dk-dragging'); force((x) => x + 1); };
    const onKey = (e) => {
      if (e.key !== 'Escape' || !drag.current) return;
      e.preventDefault();
      cancel();
    };
    const onWinUp = (e) => { if (drag.current && !otherPointer(e)) onUpRef.current?.(e); };
    const onWinCancel = (e) => { if (drag.current && !otherPointer(e)) cancel(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinCancel);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinCancel);
    };
  }, []);

  const pxm = PXM * (zoom || 1);   // scala scelta da chi guarda (zoom personale)
  /* Fascia oraria della settimana (12-04): orari del centro dei sette giorni,
   * allargata per gli appuntamenti e l'ombra (vedi weekGridRange). Era fissa
   * 08–20, e la sposa delle 07:00 in settimana non c'era. I turni in settimana
   * non arrivano: la vista giorno li vede. */
  const { start: G0, end: G1 } = weekGridRange(days, settings?.opening_hours_week, ghost);
  const hours = []; for (let h = G0 / 60; h <= G1 / 60; h++) hours.push(h);
  const marks = gridMarks(step, G0, G1);   // ora piena / mezz'ora / quarti (solo passo 15)
  const gridH = (G1 - G0) * pxm;

  /* Cambiando settimana la griglia passa dallo scheletro e tornava in cima:
   * l'ombra dell'appuntamento aperto finiva fuori schermo. Il minuto in cima si
   * ricorda e si ritrova (anche se la fascia cambia); l'ombra, se resta fuori
   * vista, si porta in vista. */
  const scrollMemo = useRef(null);
  const ready = days !== null;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || scrollMemo.current == null) return;
    el.scrollTop = Math.max(0, (scrollMemo.current - G0) * pxm);
  }, [ready, G0]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!ready || !el || !ghost) return;
    const top = (minutesOfDay(ghost.start) - G0) * pxm;
    const visible = el.clientHeight - (headRef.current?.offsetHeight || 0);
    if (top < el.scrollTop || top + 24 > el.scrollTop + visible) el.scrollTop = Math.max(0, top - 40);
  }, [ready, ghost?.id, ghost?.start, ghostDate]); // eslint-disable-line react-hooks/exhaustive-deps
  function onGridScroll() {
    const el = scrollRef.current;
    if (el) scrollMemo.current = G0 + el.scrollTop / pxm;
    onDragScroll();
  }
  const today = todayStr();
  // L'ora arriva dal contenitore, che la aggiorna ogni 30 secondi: ricalcolarla
  // qui la legava al momento del render, e bastava che nient'altro cambiasse
  // perché la riga rossa restasse dov'era.
  const nowMinLive = nowMin != null ? nowMin : nowMinutes();

  if (days === null) {
    return (
      <div style={{ flex: 1, overflow: 'hidden', padding: '16px 26px', display: 'flex', gap: 8 }}>
        {[...Array(7)].map((_, i) => <div key={i} className="skel" style={{ flex: 1, height: 480, borderRadius: 12 }} />)}
      </div>
    );
  }

  // override ottimistico: l'appuntamento in POST compare già nel giorno/operatrice/orario di arrivo
  const pendingSrc = pending ? days.flatMap((d) => d.appointments).find((a) => a.id === pending.id) : null;
  const dayData = days.map((d, i) => {
    const src = pending ? d.appointments.filter((a) => a.id !== pending.id) : d.appointments;
    const list = src.map((a) => { const s = minutesOfDay(a.start); return { ...a, startMin: s, endMin: s + (a.duration_min || 0) }; });
    if (pendingSrc && pending.dayIdx === i) {
      list.push({ ...pendingSrc, operator_id: pending.nop, startMin: pending.ns, endMin: pending.ns + (pendingSrc.duration_min || 0) });
    }
    // TUTTE le operatrici della sede attiva, ogni giorno, anche dove non hanno
    // niente in agenda: le sotto-colonne sono il posto dove si clicca per
    // prenotare, e disegnarle solo dove c'era già lavoro lasciava i giorni
    // liberi — quelli su cui si prenota di più — senza nulla da cliccare e
    // senza modo di dire a chi.
    // In coda restano le operatrici non più in elenco (disattivate) che hanno
    // ancora appuntamenti: altrimenti il giorno li CONTA ma non li mostra da
    // nessuna parte, e la cliente si presenta a un orario che in agenda non
    // esiste. Vedi weekDayOps.
    return { ...d, list, dayOps: weekDayOps(operators, locationId, list, t('Non più in team', 'No longer on the team')) };
  });
  const dayWidth = (d) => Math.max(DAY_MIN_W, d.dayOps.length * SUBCOL_W);

  /* ---- drag & drop: which day column + operator sub-column is under clientX ---- */
  function targetFromX(clientX) {
    const root = scrollRef.current;
    if (!root) return { dayIdx: null, opId: null };
    let dayEl = null, dayIdx = null, opId = null;
    root.querySelectorAll('[data-daycol]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (clientX >= r.left && clientX < r.right) { dayEl = el; dayIdx = Number(el.dataset.daycol); }
    });
    // le sotto-colonne si cercano SOLO nel giorno trovato (un giorno vuoto non ne ha)
    if (dayEl) {
      dayEl.querySelectorAll('[data-subcol]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (clientX >= r.left && clientX < r.right) opId = Number(el.dataset.op);
      });
    }
    return { dayIdx, opId };
  }

  function onBlockDown(e, appt, dayIdx) {
    if (e.button !== undefined && e.button !== 0) return;   // solo tasto sinistro
    // un secondo dito sul tablet non ruba il trascinamento in corso
    if (e.isPrimary === false) return;
    e.preventDefault();                                     // niente selezione testo (il pointerup arriva comunque)
    drag.current = {
      id: appt.id, obj: appt, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, cx: e.clientX, cy: e.clientY,
      startScroll: scrollRef.current?.scrollTop || 0,
      orig: appt.startMin, origOp: appt.operator_id, origDayIdx: dayIdx,
      ns: appt.startMin, nop: appt.operator_id, dayIdx, hoverOp: null, moved: false,
    };
    // il contenitore riceve TUTTI gli eventi fino al rilascio, anche fuori dall'area o sopra altri blocchi
    try { scrollRef.current?.setPointerCapture?.(e.pointerId); } catch { /* non supportato */ }
  }

  /* Aggancio al vicino, come in vista giorno: con trattamenti che non cadono
   * sulle fasce (venti minuti, venticinque) lo scatto alla griglia lasciava
   * sempre un ritaglio invendibile fra un appuntamento e l'altro. */
  const snapTol = Math.min(8, Math.max(4, Math.floor(step / 2) - 1));
  function bestSnap(rawMin, day, opId, d) {
    if (!day) return null;
    const span = Math.max(0, d.obj.endMin - d.obj.startMin);
    let best = null;
    const consider = (min, label) => {
      const dist = Math.abs(min - rawMin);
      if (dist > snapTol || (best && dist >= best.dist)) return;
      best = { min, dist, label };
    };
    for (const a of day.list) {
      if (a.id === d.id || a.operator_id !== opId) continue;
      consider(a.endMin, a.client_name);                 // ci si attacca sotto
      consider(a.startMin - span, a.client_name);        // ci si attacca sopra
    }
    return best;
  }

  function onMove(e) {
    const d = drag.current;
    if (!d || !canWrite || otherPointer(e)) return;
    d.cx = e.clientX; d.cy = e.clientY;
    track(d);
  }
  // La rotella durante il trascinamento sposta l'orario sotto il puntatore:
  // i minuti tengono conto anche dello scorrimento (come in vista giorno).
  function onDragScroll() {
    const d = drag.current;
    if (d && canWrite) track(d);
  }
  function track(d) {
    const dy = d.cy - d.startY + ((scrollRef.current?.scrollTop || 0) - (d.startScroll || 0));
    const dx = d.cx - d.startX;
    const { dayIdx, opId } = targetFromX(d.cx);
    const rawMin = d.orig + dy / pxm;
    let ns = Math.round(rawMin / step) * step;
    const snap = bestSnap(rawMin, dayData[dayIdx == null ? d.origDayIdx : dayIdx], opId == null ? d.origOp : opId, d);
    d.snap = snap && snap.min !== ns ? snap : null;
    if (snap) ns = snap.min;
    ns = Math.max(G0, Math.min(G1 - step, ns));
    d.ns = ns;
    d.dayIdx = dayIdx == null ? d.origDayIdx : dayIdx;
    d.hoverOp = opId;
    // anche una visita con più servizi passa di mano: cambiano operatrice i
    // servizi della colonna di partenza (from_operator_id), come in vista giorno
    d.nop = opId == null ? d.origOp : opId;
    const wasMoved = d.moved;
    d.moved = d.moved || Math.abs(dy) > 4 || Math.abs(dx) > 4;
    if (d.moved && !wasMoved) { document.body.classList.add('dk-dragging'); setHover(null); }
    force((x) => x + 1);
  }

  function endDrag() {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('dk-dragging');
    force((x) => x + 1);
    return d;
  }
  function onCancel(e) { if (!otherPointer(e)) endDrag(); }

  function onUp(e) {
    if (otherPointer(e)) return;   // si solleva un altro dito: il trascinamento continua
    const d = endDrag();
    if (!d) return;
    if (!d.moved) { openDetail(d.obj); return; }   // click semplice → dettaglio; il drag no
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
    const changed = d.ns !== d.orig || d.dayIdx !== d.origDayIdx || d.nop !== d.origOp;
    if (changed && canWrite) commitMove(d);
  }
  onUpRef.current = onUp;

  function whereLabel(dayIdx, opId, ns) {
    const day = dayData[dayIdx];
    const op = operators.find((o) => o.id === opId);
    return `${day ? `${t(DOW_IT[dayIdx], DOW_EN[dayIdx])} ${parseISO(day.date).getDate()} · ` : ''}${op ? op.first_name + ' · ' : ''}${timeLabel(ns)}`;
  }

  /* «Torna indietro» del server, lo stesso del tasto in barra: rimette
   * l'appuntamento dov'era e, se il messaggio alla cliente non è ancora
   * partito, lo ferma. Rifare lo spostamento al contrario lo lasciava invece
   * partire. Di norma passa dalla sezione (`undoAfter`): annulla QUEL gesto,
   * con la stessa guardia del tasto in barra; questo resta solo di riserva. */
  async function undoLast() {
    try {
      const res = await api.post('/api/agenda/undo', {});
      fireToast({ msg: t('Annullato · ' + res.label, 'Undone · ' + res.label), icon: 'undo' });
    } catch (err) { toastErr(err, t, fireToast); }
    await refetchWeek();
  }

  /* Uno spostamento su un orario occupato o fuori turno NON si ferma a chiedere
   * conferma: chi usa l'agenda tutti i giorni sa quando sta incastrando una
   * cliente. Si sposta e basta, con «Annulla» nell'avviso per rimettere tutto
   * dov'era. Che sia stato «forzato» non si scrive da nessuna parte: al banco
   * lo sanno già, ed era l'ennesimo allarme per una giornata normale. Stessa
   * regola della vista giorno. */
  async function commitMove(d, opts = {}) {
    const day = dayData[d.dayIdx];
    if (!day) return;
    const body = { start: isoAtMin(day.date, d.ns) };
    if (d.nop != null && d.nop !== d.origOp) { body.operator_id = d.nop; body.from_operator_id = d.origOp; }
    if (opts.force) body.force = true;
    const mark = undoMark?.();   // voce più recente di «torna indietro» prima del gesto
    setPending({ id: d.id, dayIdx: d.dayIdx, ns: d.ns, nop: d.nop });
    try {
      await api.post(`/api/agenda/appointments/${d.id}/move`, body);
      if (opts.undo !== false) {
        fireToast({
          msg: t('Spostato · ', 'Moved · ') + whereLabel(d.dayIdx, d.nop, d.ns),
          icon: 'calendar',
          undo: t('Annulla', 'Undo'),
          // annulla questo spostamento (la voce scritta dal gesto), poi ricarica la settimana
          undoFn: undoAfter ? undoAfter(mark, () => refetchWeekRef.current()) : () => undoLast(),
        });
      }
      await refetchWeek();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !opts.force && canWrite) {
        await commitMove(d, { ...opts, force: true });
        return;
      }
      setPending(null);        // il blocco torna al suo posto
      await refetchWeek();
      toastErr(err, t, fireToast);
    } finally {
      setPending(null);
    }
  }

  async function openDetail(appt) {
    // Con la prenotazione aperta il dettaglio non si apre (la sostituirebbe):
    // lo dice la sezione, senza nemmeno caricarlo.
    if (pickMode && onOpenAppt) { onOpenAppt(appt); return; }
    try {
      const full = await api.get(`/api/agenda/appointments/${appt.id}`);
      // `onShowDate`: sfogliando i giorni dal pannello, la settimana mostrata
      // segue (la vista si ricava dalla stessa data della sezione).
      // Il ricarico passa dalla ref: quello catturato all'apertura rileggeva
      // la settimana di allora anche dopo averne sfogliata un'altra.
      if (onOpenAppt) onOpenAppt(full, () => refetchWeekRef.current());
      else openModal('apptdetail', { appointment: full, onMutate: () => refetchWeekRef.current(), onShowDate });
    } catch (err) { toastErr(err, t, fireToast); }
  }

  const openAt = (dayIso, minutes, opId) => {
    const key = `${dayIso}|${minutes}|${opId || ''}`;
    const now = Date.now();
    if (lastOpen.current.key === key && now - lastOpen.current.at < 700) return;
    lastOpen.current = { at: now, key };
    onNewAppt && onNewAppt({ operatorId: opId || undefined, start: isoAtMin(dayIso, minutes), date: dayIso });
  };
  const minutesFrom = (clientY, el) => {
    const rect = el.getBoundingClientRect();
    const raw = G0 + (clientY - rect.top) / pxm;
    return Math.max(G0, Math.min(G1 - step, Math.round(raw / step) * step));
  };

  function onEmptyClick(e, opId, date) {
    if (e.target !== e.currentTarget) return;   // only the empty sub-column background, not a block
    if (justDragged.current || drag.current || !canWrite) return;
    openAt(date, minutesFrom(e.clientY, e.currentTarget), opId);
  }

  /* Clic (e doppio clic) sulla colonna del GIORNO, non su una sotto-colonna.
   * Un giorno senza appuntamenti non ha nessuna sotto-colonna — le si disegna
   * solo per le operatrici che lavorano quel giorno — quindi non c'era proprio
   * niente da cliccare: il doppio clic su un giorno libero non apriva nulla, ed
   * era il gesto più naturale per prenotare. L'operatrice, se il punto cade in
   * una sotto-colonna, la si ricava dalla x; altrimenti la sceglie il drawer. */
  function onDayAreaClick(e, dayIso) {
    if (justDragged.current || drag.current || !canWrite) return;
    if (e.target.closest('[data-appt]')) return;   // sopra un appuntamento: quello si apre col clic
    openAt(dayIso, minutesFrom(e.clientY, e.currentTarget), targetFromX(e.clientX).opId);
  }

  /* I servizi dell'appuntamento aperto, in fila dalla sua ora: servono a
   * disegnarne l'ombra sul giorno che si sta guardando. */
  const ghostSpans = (() => {
    if (!ghost) return [];
    let cursor = minutesOfDay(ghost.start);
    return (ghost.items || []).map((it, i) => {
      const dur = (it.duration_min || 0) + (it.soak_min || 0);
      const span = { key: it.id ?? i, opId: it.operator_id ?? ghost.operator_id, startMin: cursor, dur: Math.max(10, dur) };
      cursor += dur;
      return span;
    });
  })();

  const dg = drag.current;
  const dragging = !!(dg && dg.moved);
  // il blocco in trascinamento, già nel giorno/operatrice/orario di arrivo
  const movingObj = dragging ? { ...dg.obj, operator_id: dg.nop, startMin: dg.ns, endMin: dg.ns + (dg.obj.endMin - dg.obj.startMin) } : null;

  /* Il payload della settimana è più compatto di quello del giorno: qui si
   * riporta alla forma che la scheda di anteprima già sa leggere, così la
   * scheda resta una sola per le due viste. */
  const hoverShape = (a) => ({
    ...a,
    client: { full_name: a.client_name, phone: a.client_phone },
    total_duration_min: a.duration_min,
  });
  const openHover = (a, el) => {
    if (drag.current) return;
    const r = el.getBoundingClientRect();
    const right = r.right + 320 < window.innerWidth;
    setHover({
      a: hoverShape(a),
      x: right ? r.right + 10 : r.left - 10,
      y: Math.min(r.top, window.innerHeight - 280),
      side: right ? 'right' : 'left',
    });
  };
  const closeHover = () => setHover(null);

  return (
    <div
      ref={scrollRef}
      className="scroll"
      style={{ flex: 1, overflow: 'auto', position: 'relative' }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onScroll={onGridScroll}
    >
      {/* sticky header: day + per-operator sub-columns */}
      <div ref={headRef} style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 9, background: 'var(--paper)', borderBottom: '1px solid var(--hair)', width: 'max-content', minWidth: '100%' }}>
        <div style={{ width: GUTTER_W, flexShrink: 0, position: 'sticky', left: 0, background: 'var(--paper)', zIndex: 10 }} />
        {dayData.map((d, i) => {
          const isToday = d.date === today;
          const isTargetDay = dragging && dg.dayIdx === i;
          const rev = apptRevenue(d.list);   // il no-show non entra, come nel mese
          const dayW = dayWidth(d);
          const num = parseISO(d.date).getDate();
          const statuses = Object.entries(d.by_status || {});
          return (
            <div key={i} style={{ flex: '0 0 ' + dayW + 'px', minWidth: 0, borderLeft: DAY_BORDER, background: isToday ? TODAY_BG : 'transparent', boxShadow: isTargetDay ? 'inset 0 -2px 0 var(--ink)' : 'none', transition: 'box-shadow 100ms' }}>
              <button onClick={() => onOpenDay(d.date)} style={{ display: 'block', width: '100%', textAlign: 'center', padding: '8px 4px 5px', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: isToday ? 'var(--clay-ink)' : 'var(--muted)' }}>{t(DOW_IT[i], DOW_EN[i])}</span>
                  <span className="t-num" style={{ fontSize: 14, color: isToday ? '#fff' : 'var(--ink)', background: isToday ? 'var(--clay)' : 'transparent', width: 24, height: 24, borderRadius: 99, display: 'grid', placeItems: 'center' }}>{num}</span>
                </div>
                <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 10, marginTop: 2 }}>
                  {d.count ? `${d.count}${showRevenue ? ' · ' + fmtMoney(rev, lang) : ''}` : t('Libero', 'Free')}
                </div>
                {statuses.length > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                    {statuses.map(([st, n]) => {
                      const sm = statusMeta(st, t);
                      return (
                        <span key={st} title={sm.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <span style={{ width: 6, height: 6, borderRadius: 99, background: sm.color }} />
                          <span className="tabnum" style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--muted)' }}>{n}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </button>
              {/* operator sub-column headers: striscia colorata in alto, stessa tinta dei blocchi */}
              {d.dayOps.length > 0 && (
                <div style={{ display: 'flex' }}>
                  {d.dayOps.map((o) => (
                    <div key={o.id} title={o.first_name + ' ' + o.last_name} onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setOpTip({ name: o.first_name + ' ' + o.last_name, x: r.left + r.width / 2, y: r.bottom + 6 }); }} onMouseLeave={() => setOpTip(null)} style={{ flex: 1, minWidth: 0, padding: '4px 2px 5px', textAlign: 'center', borderLeft: '1px solid var(--hair-2)', borderTop: `3px solid ${colorOf(o.id)}`, cursor: 'default', background: `color-mix(in srgb, ${colorOf(o.id)} 14%, var(--paper))` }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', padding: '0 2px' }}>{opDisplay(o.first_name, o.last_name, opFirsts)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* grid — `data-span-min`: quanti minuti copre, per «Adatta» */}
      <div data-span-min={G1 - G0} style={{ display: 'flex', height: gridH, position: 'relative', width: 'max-content', minWidth: '100%' }}>
        {/* colonna delle ore: etichette in grassetto centrate sulla riga, ":30" in piccolo, tacca allineata */}
        <div style={{ width: GUTTER_W, flexShrink: 0, position: 'sticky', left: 0, zIndex: 7, background: 'var(--paper)' }}>
          {hours.map((h) => (
            <React.Fragment key={h}>
              <div className="tabnum" style={{ position: 'absolute', top: (h * 60 - G0) * pxm - 7, right: 7, fontSize: 10, lineHeight: '14px', fontWeight: 700, color: 'var(--muted)' }}>{String(h).padStart(2, '0')}:00</div>
              <div style={{ position: 'absolute', top: (h * 60 - G0) * pxm, right: 0, width: 5, ...GRID_LINE_STYLE.hour }} />
              {h < G1 / 60 && 30 * pxm > 16 && <div className="tabnum" style={{ position: 'absolute', top: (h * 60 + 30 - G0) * pxm - 6, right: 7, fontSize: 8.5, lineHeight: '12px', fontWeight: 600, color: 'var(--muted-2)' }}>:30</div>}
            </React.Fragment>
          ))}
        </div>
        {dayData.map((d, i) => {
          const isToday = d.date === today;
          const dayW = dayWidth(d);
          const isTargetDay = dragging && dg.dayIdx === i;
          // destinazione senza sotto-colonna per l'operatrice (giorno vuoto): il blocco si mostra a tutta larghezza
          const looseTarget = isTargetDay && !d.dayOps.some((o) => o.id === dg.nop);
          return (
            <div key={i} data-daycol={i} className={looseTarget ? 'dk-col--target' : ''}
              onClick={(e) => { if (e.target === e.currentTarget) onDayAreaClick(e, d.date); }}
              onDoubleClick={(e) => onDayAreaClick(e, d.date)}
              style={{ flex: '0 0 ' + dayW + 'px', minWidth: 0, position: 'relative', borderLeft: DAY_BORDER, background: isToday ? TODAY_BG : 'transparent', display: 'flex', cursor: canWrite ? 'copy' : 'default' }}>
              {/* righe orarie: sotto i blocchi (z 2), sopra lo sfondo; pointer-events none per non disturbare drag e click */}
              {marks.filter(({ kind }) => (kind === 'hour') || (kind === 'half' && 30 * pxm > 12) || (kind === 'quarter' && 15 * pxm > 12))
                .map(({ m, kind }) => <div key={m} style={{ position: 'absolute', left: 0, right: 0, top: (m - G0) * pxm, zIndex: 1, pointerEvents: 'none', ...GRID_LINE_STYLE[kind] }} />)}
              {isToday && nowMinLive >= G0 && nowMinLive <= G1 && <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMinLive - G0) * pxm, height: 2, background: '#F4708A', zIndex: 6, pointerEvents: 'none' }} />}
              {d.dayOps.map((o) => {
                // il blocco trascinato esce dalla sua corsia: al suo posto la traccia, e riappare dove punta il cursore
                const opList = d.list.filter((a) => a.operator_id === o.id && !(dragging && a.id === dg.id));
                const isTarget = isTargetDay && dg.nop === o.id;
                const isOrigin = dragging && dg.origDayIdx === i && dg.origOp === o.id;
                return (
                  <div
                    key={o.id}
                    data-subcol=""
                    data-day={i}
                    data-op={o.id}
                    className={isTarget ? 'dk-col--target' : ''}
                    onClick={(e) => onEmptyClick(e, o.id, d.date)}
                    style={{ flex: 1, minWidth: 0, position: 'relative', borderLeft: '1px solid var(--hair-2)', cursor: canWrite ? 'copy' : 'default', borderRadius: isTarget ? 4 : 0 }}
                  >
                    {isOrigin && <div className="dk-drag-ghost" style={{ top: (dg.orig - G0) * pxm + 1, height: (dg.obj.endMin - dg.obj.startMin) * pxm - 2, left: 1, right: 1, borderRadius: 6 }} />}
                    {/* Ombra dell'appuntamento aperto nel pannello, sul giorno
                        che si sta guardando: dove finirebbe, alla sua ora. Non
                        intercetta il puntatore — il clic passa sotto. */}
                    {ghost && d.date === ghostDate && ghostSpans.filter((g) => g.opId === o.id).map((g) => (
                      <div key={'ghost' + g.key} style={{
                        position: 'absolute', left: 1, right: 1,
                        top: (g.startMin - G0) * pxm + 1, height: g.dur * pxm - 2,
                        borderRadius: 6, border: '2px dashed var(--clay)',
                        background: 'color-mix(in srgb, var(--clay) 14%, transparent)',
                        pointerEvents: 'none', zIndex: 5, overflow: 'hidden', padding: '2px 4px',
                      }}>
                        <div className="tabnum" style={{ fontSize: 9, fontWeight: 800, color: 'var(--clay-ink)' }}>{timeLabel(g.startMin)}</div>
                      </div>
                    ))}
                    {weekLayout(opList).map((a) => {
                      const lc = a._laneCount || 1, lane = a._lane || 0;
                      return (
                        <WeekBlock pxm={pxm} g0={G0}
                          key={a.id} a={a} lc={lc} colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} highlight={a.id === openApptId}
                          left={`calc(${(lane / lc) * 100}% + 1px)`} width={`calc(${100 / lc}% - 2px)`}
                          onDown={(e) => onBlockDown(e, a, i)}
                          onHover={openHover} onLeave={closeHover}
                        />
                      );
                    })}
                    {isTarget && <WeekBlock pxm={pxm} g0={G0} a={movingObj} moving colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} left={1} width="calc(100% - 2px)" />}
                  </div>
                );
              })}
              {looseTarget && <WeekBlock pxm={pxm} g0={G0} a={movingObj} moving colorOf={colorOf} itemColor={itemColor} canWrite={canWrite} t={t} left={2} width="calc(100% - 4px)" />}
            </div>
          );
        })}
      </div>
      {hover && <ApptHoverCard hover={hover} t={t} lang={lang} operators={operators} colorOf={colorOf} hints="week" />}
      {opTip && <div style={{ position: 'fixed', top: opTip.y, left: opTip.x, transform: 'translateX(-50%)', zIndex: 90, background: 'var(--ink)', color: '#fff', fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 8, whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: 'var(--sh-pop)' }}>{opTip.name}</div>}
      {/* badge che segue il cursore: giorno + operatrice + orario di arrivo */}
      {dragging && (() => {
        const day = dayData[dg.dayIdx];
        const op = operators.find((o) => o.id === dg.nop);
        return (
          <div className="dk-drag-badge" style={{ top: dg.cy + 18, left: dg.cx + 18 }}>
            <Icon name="calendar" size={14} color="#fff" stroke={2.4} />
            {day && <span>{t(DOW_IT[dg.dayIdx], DOW_EN[dg.dayIdx])} {parseISO(day.date).getDate()}</span>}
            {op && <span>· {op.first_name}</span>}
            <span className="tabnum">· {timeLabel(movingObj.startMin)}–{timeLabel(movingObj.endMin)}</span>
            {dg.snap && <small>· {t(`attaccato a ${dg.snap.label}`, `snapped to ${dg.snap.label}`)}</small>}
          </div>
        );
      })()}
      {/* 409 allo spostamento: conferma per forzare (stesse regole della vista giorno) */}
    </div>
  );
}

/* ---------- blocco appuntamento della settimana ----------
 * Sfondo nel colore del SERVIZIO (categoria), come in vista giorno: il colore
 * deve dire che lavoro è anche qui — con la tinta dell'operatrice tutti i
 * blocchi di una colonna erano identici e il tipo di trattamento si scopriva
 * solo passandoci sopra. Chi lo fa resta scritto nella striscia verticale a
 * sinistra e nell'intestazione della sotto-colonna. Indicatori caparra dovuta /
 * gift come nella vista giorno.
 * `moving` = copia che segue il puntatore durante il drag (non riceve eventi). */
function WeekBlock({ a, lc = 1, left, width, colorOf, itemColor, moving = false, highlight = false, pxm = PXM, g0 = DK_START, canWrite, t, onDown, onHover, onLeave }) {
  const h = (a.endMin - a.startMin) * pxm;
  const parts = String(a.client_name || '').split(' ');
  const first = parts[0], last = parts.slice(1).join(' ');
  const segs = opSegments(a);
  const nServices = (a.items || []).length;
  const multi = nServices > 1;
  const bands = serviceBands(a);
  const gifts = (a.gifts || []).length;   // il payload settimana può non avere `gifts`
  const depositDue = a.deposit_status === 'required';
  /* «Forzato» NON si segnala più in griglia. Da quando l'agenda non chiede più
   * conferme — si trascina e basta, si forza per conto nostro al primo rifiuto —
   * quasi ogni appuntamento nasce o passa da una forzatura: il triangolino
   * finiva su tutti i blocchi e non distingueva più niente, spaventando per
   * giornate perfettamente normali. Resta scritto nel pannello di dettaglio,
   * dove serve davvero (e dove la vista giorno lo lascia da tempo). */
  const flags = !!(depositDue || gifts);
  const svcTint = (it) => {
    const col = it && itemColor
      ? itemColor({ service_id: it.service_id, operator_id: it.operator_id ?? it.opId ?? a.operator_id })
      : null;
    // stessa resa della vista giorno (82%): un colore mezzo slavato qui e pieno
    // là non si riconosce come lo stesso trattamento
    return `color-mix(in srgb, ${col || colorOf(a.operator_id)} 82%, #FFFFFF)`;
  };
  const textZ = { position: 'relative', zIndex: 2 };
  return (
    <div
      data-appt={a.id}
      onPointerDown={onDown}
      onMouseEnter={(e) => onHover && onHover(a, e.currentTarget)}
      onMouseLeave={() => onLeave && onLeave()}
      style={{
        position: 'absolute', top: (a.startMin - g0) * pxm + 1, height: h - 2, left, width, boxSizing: 'border-box',
        borderRadius: 6, overflow: 'hidden', padding: '3px 5px 3px 8px',
        background: svcTint((a.items || [])[0]),
        border: moving ? '2px solid var(--ink)' : 'none',
        boxShadow: moving ? 'var(--sh-pop)' : highlight ? '0 0 0 2.5px var(--ink)' : '0 1px 2px rgba(17,24,39,0.1)',
        transform: moving ? 'scale(1.03)' : 'none', transition: moving ? 'none' : 'box-shadow 150ms',
        opacity: a.status === 'no_show' ? 0.5 : moving ? 0.92 : 1,
        cursor: canWrite ? 'grab' : 'pointer', touchAction: 'none',
        pointerEvents: moving ? 'none' : 'auto', zIndex: moving ? 20 : 2,
      }}
    >
      {/* Striscia operatrice: segmenti in proporzione alla durata dei servizi. */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: multi ? 4 : 3, display: 'flex', flexDirection: 'column', pointerEvents: 'none', zIndex: 2 }}>
        {segs.map((s, k) => (
          <div key={k} style={{ flex: s.w, background: colorOf(s.opId), borderTop: multi && k > 0 ? '1.5px solid var(--surface)' : 'none' }} />
        ))}
      </div>
      {/* La visita divisa nei suoi servizi: in settimana è UN riquadro, e due o
          tre servizi dentro restavano un blocco unico. Ogni fascia prende il
          colore della sua categoria, in proporzione alla durata: si legge a
          colpo d'occhio che una visita è colore + piega. I nomi no: la
          sottocolonna è larga quaranta pixel e finirebbero sopra quello della
          cliente — stanno nell'anteprima al passaggio del mouse. */}
      {bands.map((b, k) => (
        <div key={k} style={{
          position: 'absolute', left: multi ? 4 : 3, right: 0, top: `${b.fromPct}%`, height: `${b.toPct - b.fromPct}%`,
          background: svcTint(b), borderTop: k > 0 ? '1px dashed rgba(17,24,39,0.35)' : 'none',
          pointerEvents: 'none', zIndex: 1,
        }} />
      ))}
      {flags && (
        <div style={{ position: 'absolute', top: 3, right: 3, display: 'flex', alignItems: 'center', gap: 3, zIndex: 3 }}>
          {depositDue && <span title={t('Caparra da versare', 'Deposit due')} style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--warn)' }} />}
          {gifts > 0 && <span title={t('Gift card', 'Gift card')} style={{ display: 'grid' }}><Icon name="gift" size={10} color="var(--ink-2)" stroke={2.2} /></span>}
        </div>
      )}
      <div style={{ ...textZ, fontSize: 10.5, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, pointerEvents: 'none', paddingRight: flags ? 14 : 0 }}>{first}</div>
      {last && h > 30 && lc < 3 && <div style={{ ...textZ, fontSize: 10, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, pointerEvents: 'none' }}>{last}</div>}
      {h > 44 && (
        <div className="tabnum" style={{ ...textZ, fontSize: 9.5, color: 'var(--ink-2)', marginTop: 1, pointerEvents: 'none', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span>{timeLabel(a.startMin)}{moving ? '–' + timeLabel(a.endMin) : ''}</span>
          {multi && (
            <span title={t(`${nServices} servizi in un'unica visita`, `${nServices} services in one visit`)}
              style={{ fontWeight: 800, fontSize: 9, letterSpacing: '0.02em', color: 'var(--ink-2)', background: 'rgba(255,255,255,0.72)', borderRadius: 4, padding: '0 3px' }}>
              ×{nServices}
            </span>
          )}
        </div>
      )}
      {/* blocco troppo basso per la riga dell'orario: il conteggio va comunque detto */}
      {multi && h <= 44 && (
        <span title={t(`${nServices} servizi in un'unica visita`, `${nServices} services in one visit`)}
          style={{ position: 'absolute', bottom: 2, right: 3, zIndex: 3, fontWeight: 800, fontSize: 9, color: 'var(--ink-2)', background: 'rgba(255,255,255,0.72)', borderRadius: 4, padding: '0 3px', pointerEvents: 'none' }}>
          ×{nServices}
        </span>
      )}
    </div>
  );
}
