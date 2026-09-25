// WeekView — 7-day overview from GET /api/agenda/week (per-op sub-columns, lane packing)
// Interactions mirror the day view (DayGrid): drag a block to reschedule/reassign,
// click a block to open its detail, click an empty slot to create a new appointment.
//
// Drag: il contenitore cattura il puntatore (setPointerCapture) così il rilascio
// arriva anche fuori dall'area; il blocco trascinato viene tolto dalla sua corsia e
// ridisegnato dove si trova il puntatore (giorno + operatrice + orario snappato),
// con traccia tratteggiata all'origine, colonna di destinazione evidenziata e badge
// che segue il cursore. Il 409 del server («occupato / fuori turno») non ferma
// niente: la POST si ripete con `force: true`, come nella vista giorno.
import { useEffect, useRef, useState } from 'react';
import { toastApiError, nowMinutes, todayStr } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import ApptHoverCard from './grid/ApptHoverCard.jsx';
import WeekDayHeader from './grid/WeekDayHeader.jsx';
import HourGutter from './grid/HourGutter.jsx';
import WeekDayColumn from './grid/WeekDayColumn.jsx';
import WeekDragBadge from './grid/WeekDragBadge.jsx';
import {
  PXM, WEEK_HOURS_W, HOVER_CLEAR_WEEK, isoAtMin, gridMarks, weekGridRange, slotStep, openApptIdOf, hoverPlacement,
} from './lib.js';
import { dragDy, snapStart, snapTolerance } from './lib/drag.js';
import { retryForced } from './lib/retry.js';
import { weekMovedText } from './lib/toastText.js';
import * as agendaApi from './agendaApi.js';
import {
  weekDays, weekColOf, weekBestSnap, weekDropChanged, weekMoveBody, whereLabel, movingBlock, weekGhostSpans, hoverShape,
} from './lib/week.js';
import { useWeekData } from './hooks/useWeekData.js';
import { useGridZoom } from './hooks/useGridZoom.js';
import { useScrollMemo } from './hooks/useScrollMemo.js';
import { useGridDrag } from './hooks/useGridDrag.js';

/* Larghezze MINIME: i giorni si allargano fino a riempire lo spazio (flex
 * 1 0 in WeekDayHeader e WeekDayColumn). Prima erano fisse, e con quattro
 * operatrici la domenica usciva dallo schermo anche con metà pagina vuota. */
const SUBCOL_W = 44;   // larghezza minima di una sotto-colonna operatrice
const DAY_MIN_W = 112;

export default function WeekView({ weekStart, operators, colorOf, itemColor, nowMin = null, onOpenDay, onNewAppt, onOpenAppt, pickMode = false, undoMark, undoAfter, ghost, ghostDate, zoom = 1, onZoom, hiddenOps = [] }) {
  const { t, lang, showRevenue, fireToast, hasScope, settings, live, locationId, modal } = useDash();
  // come in vista giorno: il blocco aperto nel pannello resta cerchiato
  const openApptId = openApptIdOf(modal);
  const canWrite = hasScope('agenda');
  const step = slotStep(settings);   // granularità fasce orarie (Impostazioni)
  const opFirsts = operators.map((o) => o.first_name); // per la disambiguazione omonimie
  const [opTip, setOpTip] = useState(null); // { name, x, y }
  const [pending, setPending] = useState(null);   // { id, dayIdx, ns, nop }: il blocco resta dove è stato lasciato durante la POST
  // Anteprima al passaggio del mouse, come nella vista giorno: in settimana i
  // blocchi sono stretti e il solo `title` del browser arriva tardi e dice poco.
  const [hover, setHover] = useState(null);
  /* Cambiando settimana i blocchi spariscono senza mouseleave: la scheda
   * dell'appuntamento di prima restava incollata sulla settimana nuova. */
  useEffect(() => { setHover(null); }, [weekStart]);
  const scrollRef = useRef(null);
  const headRef = useRef(null);             // intestazione fissa dei giorni
  const onUpRef = useRef(null);             // ultimo onUp (chiusura fresca) per il fallback su window
  /* Apre la nuova prenotazione una volta sola: il doppio clic manda due click
   * più un dblclick, e senza questa guardia il drawer si rimontava tre volte. */
  const lastOpen = useRef({ at: 0, key: '' });

  // la settimana: scheletro al cambio, ricarico silenzioso dopo un gesto o un evento live
  const { days, refetchWeek, refetchWeekRef } = useWeekData({ weekStart, locationId, live, t, fireToast });
  // la griglia è disegnata: lo scheletro non ha il contenitore (scrollRef)
  const ready = days !== null;

  const pxm = PXM * (zoom || 1);   // scala scelta da chi guarda (zoom personale)
  /* Fascia oraria della settimana (12-04): orari del centro dei sette giorni,
   * allargata per gli appuntamenti e l'ombra (vedi weekGridRange). Era fissa
   * 08–20, e la sposa delle 07:00 in settimana non c'era. I turni in settimana
   * non arrivano: la vista giorno li vede. Si calcola prima degli hook che la
   * leggono (zoom, scroll), anche durante il caricamento. */
  const { start: G0, end: G1 } = weekGridRange(days, settings?.opening_hours_week, ghost);
  const marks = gridMarks(step, G0, G1);   // ora piena / mezz'ora / quarti (solo passo 15)
  const gridH = (G1 - G0) * pxm;

  /* Zoom: stessa scala e stesso gesto della vista giorno (⌘/ctrl + rotella o
   * pinch del trackpad), tenendo fermo il minuto che si stava guardando. Il
   * gesto si aggancia alla griglia quando c'è (`ready`), anche dopo lo
   * scheletro del cambio di settimana. */
  useGridZoom({ scrollRef, zoom, onZoom, g0: G0, bodySelector: '[data-daycol]', ready });

  /* Il trascinamento: Esc lo annulla e, qui, anche pointerup e pointercancel su
   * window: se la cattura non è supportata o il rilascio avviene fuori
   * dall'area, il drag non resta mai "appeso" (onUpRef = l'ultimo onUp). */
  const { drag, justDragged, force, otherPointer, endDrag, onCancel, markDropped, startGesture } = useGridDrag({ windowUpRef: onUpRef });

  /* Cambiando settimana la griglia passa dallo scheletro e tornava in cima:
   * l'ombra dell'appuntamento aperto finiva fuori schermo. Il minuto in cima si
   * ricorda e si ritrova (anche se la fascia cambia); l'ombra, se resta fuori
   * vista, si porta in vista. */
  const rememberScroll = useScrollMemo({ scrollRef, headRef, g0: G0, pxm, ghost, dayKey: ghostDate, ready, initialMin: nowMin != null && nowMin > G0 && nowMin < G1 ? nowMin - 60 : null });
  function onGridScroll() {
    rememberScroll();
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

  // i giorni da disegnare: sotto-colonne di TUTTE le operatrici della sede, e
  // l'appuntamento in POST già dove è stato lasciato (vedi weekDays)
  // (le operatrici spente nel filtro «Team» non hanno sotto-colonna: `hiddenOps`)
  const dayData = weekDays(days, pending, operators, locationId, t('Non più in team', 'No longer on the team'), hiddenOps);
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
    startGesture();
    drag.current = {
      id: appt.id, obj: appt, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, cx: e.clientX, cy: e.clientY,
      startScroll: scrollRef.current?.scrollTop || 0,
      // la colonna da cui parte, quella in cui è disegnato (weekColOf): con la
      // principale spenta nel filtro, trascinarlo nella stessa colonna non
      // deve passare i servizi della principale a un'altra
      orig: appt.startMin, origOp: weekColOf(appt), origDayIdx: dayIdx,
      ns: appt.startMin, nop: weekColOf(appt), dayIdx, hoverOp: null, moved: false,
    };
    // il contenitore riceve TUTTI gli eventi fino al rilascio, anche fuori dall'area o sopra altri blocchi
    try { scrollRef.current?.setPointerCapture?.(e.pointerId); } catch { /* non supportato */ }
  }

  // aggancio al vicino, come in vista giorno (weekBestSnap)
  const snapTol = snapTolerance(step);

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
    const dy = dragDy(d, scrollRef.current?.scrollTop || 0);
    const dx = d.cx - d.startX;
    const { dayIdx, opId } = targetFromX(d.cx);
    const rawMin = d.orig + dy / pxm;
    const near = weekBestSnap(rawMin, dayData[dayIdx == null ? d.origDayIdx : dayIdx], opId == null ? d.origOp : opId, d, snapTol);
    const { ns, snap } = snapStart(rawMin, step, near, G0, G1);
    d.snap = snap;
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

  function onUp(e) {
    if (otherPointer(e)) return;   // si solleva un altro dito: il trascinamento continua
    const d = endDrag();
    if (!d) return;
    if (!d.moved) { openDetail(d.obj); return; }   // click semplice → dettaglio; il drag no
    markDropped();   // il click nativo che segue non apre niente
    if (weekDropChanged(d) && canWrite) commitMove(d);
  }
  onUpRef.current = onUp;

  /* Uno spostamento su un orario occupato o fuori turno NON si ferma a chiedere
   * conferma: chi usa l'agenda tutti i giorni sa quando sta incastrando una
   * cliente. Si sposta e basta, con «Annulla» nell'avviso per rimettere tutto
   * dov'era. Che sia stato «forzato» non si scrive da nessuna parte: al banco
   * lo sanno già, ed era l'ennesimo allarme per una giornata normale. Stessa
   * regola della vista giorno. */
  async function commitMove(d, opts = {}) {
    const day = dayData[d.dayIdx];
    if (!day) return;
    const body = weekMoveBody(day, d, opts.force);
    const mark = undoMark();   // voce più recente di «torna indietro» prima del gesto
    setPending({ id: d.id, dayIdx: d.dayIdx, ns: d.ns, nop: d.nop });
    try {
      await agendaApi.moveAppointment(d.id, body);
      fireToast({
        msg: weekMovedText(t, whereLabel(dayData, operators, d.dayIdx, d.nop, d.ns, t)),
        icon: 'calendar',
        undo: t('Annulla', 'Undo'),
        // «Torna indietro» del server, lo stesso del tasto in barra, per la
        // voce scritta da QUESTO gesto (vedi undoAfter nella sezione): rimette
        // l'appuntamento dov'era e, se il messaggio alla cliente non è ancora
        // partito, lo ferma. Poi ricarica la settimana.
        undoFn: undoAfter(mark, () => refetchWeekRef.current()),
      });
      await refetchWeek();
    } catch (err) {
      if (retryForced(err, opts.force, canWrite)) {
        await commitMove(d, { ...opts, force: true });
        return;
      }
      setPending(null);        // il blocco torna al suo posto
      await refetchWeek();
      toastApiError(err, fireToast, t);
    } finally {
      setPending(null);
    }
  }

  async function openDetail(appt) {
    // Con la prenotazione aperta il dettaglio non si apre (la sostituirebbe):
    // lo dice la sezione, senza nemmeno caricarlo.
    if (pickMode) { onOpenAppt(appt); return; }
    try {
      const full = await agendaApi.getAppointment(appt.id);
      // Il pannello lo apre la sezione, che gli passa anche il ricarico della
      // settimana. Il ricarico passa dalla ref: quello catturato all'apertura
      // rileggeva la settimana di allora anche dopo averne sfogliata un'altra.
      onOpenAppt(full, () => refetchWeekRef.current());
    } catch (err) { toastApiError(err, fireToast, t); }
  }

  const openAt = (dayIso, minutes, opId) => {
    const key = `${dayIso}|${minutes}|${opId || ''}`;
    const now = Date.now();
    if (lastOpen.current.key === key && now - lastOpen.current.at < 700) return;
    lastOpen.current = { at: now, key };
    onNewAppt && onNewAppt({ operatorId: opId || undefined, start: isoAtMin(dayIso, minutes), date: dayIso });
  };
  /* La fascia sotto il puntatore, come in vista giorno (onColumnClick di
   * DayGrid). Arrotondava: con fasce da 30 minuti un clic alle 10:50 apriva la
   * prenotazione alle 11:00 in settimana e alle 10:30 in giorno (bug sospetti
   * del 24/09, n. 50). */
  const minutesFrom = (clientY, el) => {
    const rect = el.getBoundingClientRect();
    const raw = G0 + (clientY - rect.top) / pxm;
    return Math.max(G0, Math.min(G1 - step, Math.floor(raw / step) * step));
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

  // l'ombra dell'appuntamento aperto, servizio per servizio (weekGhostSpans)
  const ghostSpans = weekGhostSpans(ghost);

  const dg = drag.current;
  const dragging = !!(dg && dg.moved);
  // il blocco in trascinamento, già nel giorno/operatrice/orario di arrivo
  const movingObj = dragging ? movingBlock(dg) : null;

  // anteprima al passaggio del mouse, con la scheda della vista giorno (hoverShape)
  const openHover = (a, el) => {
    if (drag.current) return;
    setHover({ a: hoverShape(a), ...hoverPlacement(el.getBoundingClientRect(), window, HOVER_CLEAR_WEEK) });
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
        <div style={{ width: WEEK_HOURS_W, flexShrink: 0, position: 'sticky', left: 0, background: 'var(--paper)', zIndex: 10 }} />
        {dayData.map((d, i) => (
          <WeekDayHeader
            key={i} day={d} index={i} width={dayWidth(d)} isToday={d.date === today} isTargetDay={dragging && dg.dayIdx === i}
            showRevenue={showRevenue} t={t} lang={lang} onOpenDay={onOpenDay} colorOf={colorOf} opFirsts={opFirsts} setOpTip={setOpTip}
          />
        ))}
      </div>
      {/* grid — `data-span-min`: quanti minuti copre, per «Adatta» */}
      <div data-span-min={G1 - G0} style={{ display: 'flex', height: gridH, position: 'relative', width: 'max-content', minWidth: '100%' }}>
        {/* colonna delle ore: etichette in grassetto centrate sulla riga, ":30" in piccolo, tacca allineata */}
        <HourGutter g0={G0} g1={G1} pxm={pxm} variant="week" />
        {dayData.map((d, i) => {
          const isToday = d.date === today;
          const dayW = dayWidth(d);
          const isTargetDay = dragging && dg.dayIdx === i;
          // destinazione senza sotto-colonna per l'operatrice (giorno vuoto): il blocco si mostra a tutta larghezza
          const looseTarget = isTargetDay && !d.dayOps.some((o) => o.id === dg.nop);
          return (
            <WeekDayColumn
              key={i} day={d} index={i} width={dayW} isToday={isToday} isTargetDay={isTargetDay} looseTarget={looseTarget}
              dragging={dragging} dg={dg} movingObj={movingObj} marks={marks} g0={G0} g1={G1} pxm={pxm} nowMin={isToday ? nowMinLive : null}
              ghost={ghost} ghostDate={ghostDate} ghostSpans={ghostSpans} openApptId={openApptId} canWrite={canWrite} t={t}
              colorOf={colorOf} itemColor={itemColor}
              onDayAreaClick={onDayAreaClick} onEmptyClick={onEmptyClick} onBlockDown={onBlockDown} onHover={openHover} onLeave={closeHover}
            />
          );
        })}
      </div>
      {hover && <ApptHoverCard hover={hover} t={t} lang={lang} operators={operators} colorOf={colorOf} hints="week" />}
      {opTip && <div style={{ position: 'fixed', top: opTip.y, left: opTip.x, transform: 'translateX(-50%)', zIndex: 90, background: 'var(--ink)', color: '#fff', fontSize: 12.5, fontWeight: 600, padding: '6px 11px', borderRadius: 8, whiteSpace: 'nowrap', pointerEvents: 'none', boxShadow: 'var(--sh-pop)' }}>{opTip.name}</div>}
      {/* badge che segue il cursore: giorno + operatrice + orario di arrivo */}
      {dragging && <WeekDragBadge dg={dg} dayData={dayData} operators={operators} movingObj={movingObj} t={t} />}
    </div>
  );
}
