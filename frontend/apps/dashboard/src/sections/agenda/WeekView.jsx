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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, Icon, minutesOfDay, nowMinutes, timeLabel, todayStr, parseISO, statusMeta } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import {
  DK_START, DK_END, PXM, DOW_IT, DOW_EN, weekLayout, fmtMoney, toastErr, opDisplay, isoAtMin,
  GRID_LINE_STYLE, gridMarks, opSegments,
} from './lib.js';

// oggi: tinta discreta derivata dal tema (era #D6E4F7 hardcoded); bordo giorno più leggero di --clay
const TODAY_BG = 'color-mix(in srgb, var(--clay) 12%, var(--paper))';
const DAY_BORDER = '1px solid var(--hair)';
const GUTTER_W = 46;   // colonna delle ore
const SUBCOL_W = 48;   // larghezza minima di una sotto-colonna operatrice
const DAY_MIN_W = 120;

export default function WeekView({ weekStart, operators, colorOf, nowMin = null, onOpenDay, onNewAppt }) {
  const { t, lang, showRevenue, fireToast, openModal, hasScope, settings, live, locationId } = useDash();
  const canWrite = hasScope('agenda');
  const step = settings?.slot_interval_min || 15;   // granularità fasce orarie (Impostazioni)
  const opFirsts = operators.map((o) => o.first_name); // per la disambiguazione omonimie
  const [days, setDays] = useState(null); // null = loading
  const [opTip, setOpTip] = useState(null); // { name, x, y }
  const [pending, setPending] = useState(null);   // { id, dayIdx, ns, nop }: il blocco resta dove è stato lasciato durante la POST
  const [, force] = useState(0);            // re-render on drag ghost changes
  const scrollRef = useRef(null);
  const drag = useRef(null);                // active drag { id, obj, ns, nop, dayIdx, moved, ... }
  const justDragged = useRef(false);        // suppress the click that follows a drop
  const onUpRef = useRef(null);             // ultimo onUp (chiusura fresca) per il fallback su window

  // reusable refetch (no skeleton flash) — used after a move and passed to the detail modal
  const refetchWeek = useCallback(() => (
    api.get('/api/agenda/week', { params: { start: weekStart, ...(locationId ? { location_id: locationId } : {}) } })
      .then((rows) => setDays(rows))
      .catch((err) => toastErr(err, t, fireToast))
  ), [weekStart, locationId, t, fireToast]);

  // live: modifiche dalle altre postazioni → ricarica la settimana senza skeleton
  useEffect(() => live.subscribe(({ events }) => {
    if (events.some((e) => /^(appointment|pause|waitlist|slot|visit)\./.test(e.type))) refetchWeek();
  }), [live, refetchWeek]);

  useEffect(() => {
    let alive = true;
    setDays(null);
    api.get('/api/agenda/week', { params: { start: weekStart, ...(locationId ? { location_id: locationId } : {}) } })
      .then((rows) => { if (alive) setDays(rows); })
      .catch((err) => { if (alive) { setDays([]); toastErr(err, t, fireToast); } });
    return () => { alive = false; };
  }, [weekStart, locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => document.body.classList.remove('dk-dragging'), []);
  // Esc annulla il drag; pointerup/pointercancel su window:
  // se la capture non è supportata o il rilascio avviene fuori dall'area, il drag
  // non resta mai "appeso".
  useEffect(() => {
    const cancel = () => { drag.current = null; document.body.classList.remove('dk-dragging'); force((x) => x + 1); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (drag.current) cancel();
    };
    const onWinUp = () => { if (drag.current) onUpRef.current?.(); };
    const onWinCancel = () => { if (drag.current) cancel(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', onWinUp);
    window.addEventListener('pointercancel', onWinCancel);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', onWinUp);
      window.removeEventListener('pointercancel', onWinCancel);
    };
  }, []);

  const hours = []; for (let h = 8; h <= 20; h++) hours.push(h);
  const marks = gridMarks(step);   // ora piena / mezz'ora / quarti (solo passo 15)
  const gridH = (DK_END - DK_START) * PXM;
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
    // Anche le operatrici non più in elenco (disattivate) che hanno ancora
    // appuntamenti: altrimenti il giorno li CONTA ma non li mostra da nessuna
    // parte, e la cliente si presenta a un orario che in agenda non esiste.
    const dayOps = operators.filter((o) => list.some((a) => a.operator_id === o.id));
    const known = new Set(dayOps.map((o) => o.id));
    const orphans = [];
    list.forEach((a) => {
      if (a.operator_id && !known.has(a.operator_id) && !operators.some((o) => o.id === a.operator_id)) {
        known.add(a.operator_id);
        orphans.push({ id: a.operator_id, first_name: t('Non più in team', 'No longer on the team'), last_name: '', inactive: true });
      }
    });
    return { ...d, list, dayOps: dayOps.concat(orphans) };
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
    e.preventDefault();                                     // niente selezione testo (il pointerup arriva comunque)
    drag.current = {
      id: appt.id, obj: appt, pointerId: e.pointerId,
      startX: e.clientX, startY: e.clientY, cx: e.clientX, cy: e.clientY,
      orig: appt.startMin, origOp: appt.operator_id, origDayIdx: dayIdx,
      ns: appt.startMin, nop: appt.operator_id, dayIdx, hoverOp: null, moved: false,
      multi: (appt.items || []).length > 1,   // visita multi-servizio: operatrice fissa, come in DayGrid
    };
    // il contenitore riceve TUTTI gli eventi fino al rilascio, anche fuori dall'area o sopra altri blocchi
    try { scrollRef.current?.setPointerCapture?.(e.pointerId); } catch { /* non supportato */ }
  }

  function onMove(e) {
    const d = drag.current;
    if (!d || !canWrite) return;
    d.cx = e.clientX; d.cy = e.clientY;
    const dy = e.clientY - d.startY, dx = e.clientX - d.startX;
    let ns = Math.round((d.orig + dy / PXM) / step) * step;
    ns = Math.max(DK_START, Math.min(DK_END - step, ns));
    const { dayIdx, opId } = targetFromX(e.clientX);
    d.ns = ns;
    d.dayIdx = dayIdx == null ? d.origDayIdx : dayIdx;
    d.hoverOp = opId;
    d.nop = d.multi || opId == null ? d.origOp : opId;
    const wasMoved = d.moved;
    d.moved = d.moved || Math.abs(dy) > 4 || Math.abs(dx) > 4;
    if (d.moved && !wasMoved) document.body.classList.add('dk-dragging');
    force((x) => x + 1);
  }

  function endDrag() {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('dk-dragging');
    force((x) => x + 1);
    return d;
  }
  function onCancel() { endDrag(); }

  function onUp() {
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

  /* Uno spostamento su un orario occupato o fuori turno NON si ferma a chiedere
   * conferma: chi usa l'agenda tutti i giorni sa quando sta incastrando una
   * cliente. Si sposta forzando e lo si dice nell'avviso, con «Annulla» per
   * rimettere tutto dov'era. Stessa regola della vista giorno. */
  async function commitMove(d, opts = {}) {
    const day = dayData[d.dayIdx];
    if (!day) return;
    const body = { start: isoAtMin(day.date, d.ns) };
    if (d.nop != null && d.nop !== d.origOp) body.operator_id = d.nop;
    if (opts.force) body.force = true;
    setPending({ id: d.id, dayIdx: d.dayIdx, ns: d.ns, nop: d.nop });
    try {
      await api.post(`/api/agenda/appointments/${d.id}/move`, body);
      if (opts.undo !== false) {
        const back = {
          id: d.id, obj: d.obj, dayIdx: d.origDayIdx, ns: d.orig, nop: d.origOp,
          orig: d.ns, origOp: d.nop, origDayIdx: d.dayIdx,
        };
        fireToast({
          msg: t('Spostato · ', 'Moved · ') + whereLabel(d.dayIdx, d.nop, d.ns) + (opts.warn ? ' · ' + opts.warn : ''),
          icon: opts.warn ? 'alert' : 'calendar',
          undo: t('Annulla', 'Undo'),
          undoFn: () => commitMove(back, { undo: false }),
        });
      }
      await refetchWeek();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && !opts.force && canWrite) {
        await commitMove(d, { ...opts, force: true, warn: t('forzato: occupato o fuori turno', 'forced: busy or off shift') });
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
    try {
      const full = await api.get(`/api/agenda/appointments/${appt.id}`);
      openModal('apptdetail', { appointment: full, onMutate: refetchWeek });
    } catch (err) { toastErr(err, t, fireToast); }
  }

  function onEmptyClick(e, opId, date) {
    if (e.target !== e.currentTarget) return;   // only the empty sub-column background, not a block
    if (justDragged.current || drag.current || !canWrite) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const raw = DK_START + (e.clientY - rect.top) / PXM;
    const minutes = Math.max(DK_START, Math.min(DK_END - step, Math.round(raw / step) * step));
    onNewAppt && onNewAppt({ operatorId: opId, start: isoAtMin(date, minutes), date });
  }

  const dg = drag.current;
  const dragging = !!(dg && dg.moved);
  // il blocco in trascinamento, già nel giorno/operatrice/orario di arrivo
  const movingObj = dragging ? { ...dg.obj, operator_id: dg.nop, startMin: dg.ns, endMin: dg.ns + (dg.obj.endMin - dg.obj.startMin) } : null;
  const blockTitle = (a, o) => `${a.client_name} · ${timeLabel(a.startMin)}${o ? ' · ' + o.first_name : ''}${a.forced ? ' · ' + t('Inserito forzando le regole', 'Booked overriding the rules') : ''}`;

  return (
    <div
      ref={scrollRef}
      className="scroll"
      style={{ flex: 1, overflow: 'auto', position: 'relative' }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
    >
      {/* sticky header: day + per-operator sub-columns */}
      <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 9, background: 'var(--paper)', borderBottom: '1px solid var(--hair)', width: 'max-content', minWidth: '100%' }}>
        <div style={{ width: GUTTER_W, flexShrink: 0, position: 'sticky', left: 0, background: 'var(--paper)', zIndex: 10 }} />
        {dayData.map((d, i) => {
          const isToday = d.date === today;
          const isTargetDay = dragging && dg.dayIdx === i;
          const rev = d.list.reduce((s, a) => s + Number(a.total_price || 0), 0);
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
      {/* grid */}
      <div style={{ display: 'flex', height: gridH, position: 'relative', width: 'max-content', minWidth: '100%' }}>
        {/* colonna delle ore: etichette in grassetto centrate sulla riga, ":30" in piccolo, tacca allineata */}
        <div style={{ width: GUTTER_W, flexShrink: 0, position: 'sticky', left: 0, zIndex: 7, background: 'var(--paper)' }}>
          {hours.map((h) => (
            <React.Fragment key={h}>
              <div className="tabnum" style={{ position: 'absolute', top: (h * 60 - DK_START) * PXM - 7, right: 7, fontSize: 10, lineHeight: '14px', fontWeight: 700, color: 'var(--muted)' }}>{String(h).padStart(2, '0')}:00</div>
              <div style={{ position: 'absolute', top: (h * 60 - DK_START) * PXM, right: 0, width: 5, ...GRID_LINE_STYLE.hour }} />
              {h < 20 && <div className="tabnum" style={{ position: 'absolute', top: (h * 60 + 30 - DK_START) * PXM - 6, right: 7, fontSize: 8.5, lineHeight: '12px', fontWeight: 600, color: 'var(--muted-2)' }}>:30</div>}
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
            <div key={i} data-daycol={i} className={looseTarget ? 'dk-col--target' : ''} style={{ flex: '0 0 ' + dayW + 'px', minWidth: 0, position: 'relative', borderLeft: DAY_BORDER, background: isToday ? TODAY_BG : 'transparent', display: 'flex' }}>
              {/* righe orarie: sotto i blocchi (z 2), sopra lo sfondo; pointer-events none per non disturbare drag e click */}
              {marks.map(({ m, kind }) => <div key={m} style={{ position: 'absolute', left: 0, right: 0, top: (m - DK_START) * PXM, zIndex: 1, pointerEvents: 'none', ...GRID_LINE_STYLE[kind] }} />)}
              {isToday && nowMinLive >= DK_START && nowMinLive <= DK_END && <div style={{ position: 'absolute', left: 0, right: 0, top: (nowMinLive - DK_START) * PXM, height: 2, background: '#F4708A', zIndex: 6, pointerEvents: 'none' }} />}
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
                    title={canWrite ? t('Clicca uno spazio libero', 'Click a free slot') : undefined}
                    style={{ flex: 1, minWidth: 0, position: 'relative', borderLeft: '1px solid var(--hair-2)', cursor: canWrite ? 'copy' : 'default', borderRadius: isTarget ? 4 : 0 }}
                  >
                    {isOrigin && <div className="dk-drag-ghost" style={{ top: (dg.orig - DK_START) * PXM + 1, height: (dg.obj.endMin - dg.obj.startMin) * PXM - 2, left: 1, right: 1, borderRadius: 6 }} />}
                    {weekLayout(opList).map((a) => {
                      const lc = a._laneCount || 1, lane = a._lane || 0;
                      return (
                        <WeekBlock
                          key={a.id} a={a} lc={lc} colorOf={colorOf} canWrite={canWrite} t={t}
                          title={blockTitle(a, o)}
                          left={`calc(${(lane / lc) * 100}% + 1px)`} width={`calc(${100 / lc}% - 2px)`}
                          onDown={(e) => onBlockDown(e, a, i)}
                        />
                      );
                    })}
                    {isTarget && <WeekBlock a={movingObj} moving colorOf={colorOf} canWrite={canWrite} t={t} left={1} width="calc(100% - 2px)" />}
                  </div>
                );
              })}
              {looseTarget && <WeekBlock a={movingObj} moving colorOf={colorOf} canWrite={canWrite} t={t} left={2} width="calc(100% - 4px)" />}
            </div>
          );
        })}
      </div>
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
            {dg.multi && dg.hoverOp != null && dg.hoverOp !== dg.origOp && <small>· {t('visita multi-servizio: operatrice fissa', 'multi-service visit: stylist fixed')}</small>}
          </div>
        );
      })()}
      {/* 409 allo spostamento: conferma per forzare (stesse regole della vista giorno) */}
    </div>
  );
}

/* ---------- blocco appuntamento della settimana ----------
 * Striscia verticale a sinistra nel colore dell'operatrice (segmentata per
 * operatrice se la visita è multi-servizio), sfondo derivato dal colore ma più
 * chiaro, indicatori forced / caparra dovuta / gift come nella vista giorno.
 * `moving` = copia che segue il puntatore durante il drag (non riceve eventi). */
function WeekBlock({ a, lc = 1, left, width, colorOf, moving = false, canWrite, t, title, onDown }) {
  const h = (a.endMin - a.startMin) * PXM;
  const parts = String(a.client_name || '').split(' ');
  const first = parts[0], last = parts.slice(1).join(' ');
  const segs = opSegments(a);
  const gifts = (a.gifts || []).length;   // il payload settimana può non avere `gifts`
  const depositDue = a.deposit_status === 'required';
  const flags = !!(a.forced || depositDue || gifts);
  return (
    <div
      onPointerDown={onDown}
      title={title}
      style={{
        position: 'absolute', top: (a.startMin - DK_START) * PXM + 1, height: h - 2, left, width, boxSizing: 'border-box',
        borderRadius: 6, overflow: 'hidden', padding: '3px 5px 3px 8px',
        background: `color-mix(in srgb, ${colorOf(a.operator_id)} 40%, #FFFFFF)`,
        border: moving ? '2px solid var(--ink)' : 'none',
        boxShadow: moving ? 'var(--sh-pop)' : '0 1px 2px rgba(17,24,39,0.1)',
        transform: moving ? 'scale(1.03)' : 'none', transition: moving ? 'none' : 'box-shadow 150ms',
        opacity: a.status === 'no_show' ? 0.5 : moving ? 0.92 : 1,
        cursor: canWrite ? 'grab' : 'pointer', touchAction: 'none',
        pointerEvents: moving ? 'none' : 'auto', zIndex: moving ? 20 : 2,
      }}
    >
      {/* striscia operatrice: segmenti in proporzione alla durata dei servizi */}
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
        {segs.map((s, k) => <div key={k} style={{ flex: s.w, background: colorOf(s.opId) }} />)}
      </div>
      {flags && (
        <div style={{ position: 'absolute', top: 3, right: 3, display: 'flex', alignItems: 'center', gap: 3, zIndex: 1 }}>
          {a.forced && <span title={t('Inserito forzando le regole', 'Booked overriding the rules')} style={{ display: 'grid' }}><Icon name="alert" size={10} color="var(--warn)" stroke={2.6} /></span>}
          {depositDue && <span title={t('Caparra da versare', 'Deposit due')} style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--warn)' }} />}
          {gifts > 0 && <span title={t('Gift card', 'Gift card')} style={{ display: 'grid' }}><Icon name="gift" size={10} color="var(--ink-2)" stroke={2.2} /></span>}
        </div>
      )}
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, pointerEvents: 'none', paddingRight: flags ? 14 : 0 }}>{first}</div>
      {last && h > 30 && lc < 3 && <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.2, pointerEvents: 'none' }}>{last}</div>}
      {h > 44 && <div className="tabnum" style={{ fontSize: 9.5, color: 'var(--ink-2)', marginTop: 1, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{timeLabel(a.startMin)}{moving ? '–' + timeLabel(a.endMin) : ''}</div>}
    </div>
  );
}
