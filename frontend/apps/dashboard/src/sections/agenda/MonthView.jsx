// MonthView — griglia mensile da GET /api/agenda/range (un solo fetch per mese).
// Ogni cella dice come è messa la giornata senza aprirla: occupazione a soglie,
// mini-barre per operatrice, primi appuntamenti; il popover al passaggio del mouse
// mostra il resto. In testa il riepilogo del mese e il filtro operatrice locale.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, toastApiError, todayStr, parseISO, minutesOfDay, timeLabel, fmtDur, statusMeta, Avatar, Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { DOW_IT, DOW_EN, MONTHS_IT, MONTHS_EN, fmtMoney, opDisplay, AGENDA_LIVE_RE } from './lib.js';
import {
  monthGrid, filterDay, monthSummary, loadRatio, loadTone, LOAD_TONES, LOAD_WARN, LOAD_FULL,
  statusCounts, sortByStart, operatorRows, dayLabel, pctLabel, EMPTY_DAY,
} from './monthLib.js';

const MAX_OP_ROWS = 5;      // righe operatrice in cella, poi "+N"
const MAX_APPTS = 3;        // appuntamenti in cella, poi "+N altri"
const POP_MAX_APPTS = 12;   // appuntamenti nel popover, poi "+N"
const POP_W = 320;
const HOVER_CLOSE_MS = 120; // il popover sopravvive al passaggio tra due celle vicine
const LIVE_DEBOUNCE_MS = 300;
const TRACK = 'color-mix(in srgb, var(--ink) 8%, transparent)'; // fondo delle barre, visibile su ogni tema

export default function MonthView({ anchor, onOpenDay }) {
  const { t, lang, showRevenue, fireToast, operators, opColors, live, locationId } = useDash();
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const [data, setData] = useState(null);       // [giorno /range] | null = caricamento
  const [error, setError] = useState(false);
  const [sel, setSel] = useState(() => new Set()); // filtro operatrice locale (vuoto = tutte)
  const [hover, setHover] = useState(null);     // { iso, x, y } — stato separato: la griglia (memo) non si ridisegna
  const seq = useRef(0);                        // scarta le risposte arrivate dopo un cambio mese
  const uiRef = useRef({ t, fireToast });
  uiRef.current = { t, fireToast };

  /* ---- caricamento: una chiamata per l'intera griglia (5-6 settimane) ---- */
  const load = useCallback((silent) => {
    const my = ++seq.current;
    if (!silent) { setData(null); setError(false); }
    api.get('/api/agenda/range', { params: { start: grid.start, end: grid.end, location_id: locationId } })
      .then((rows) => { if (my !== seq.current) return; setData(rows); setError(false); })
      .catch((err) => {
        if (my !== seq.current) return;
        if (!silent) { setData([]); setError(true); }
        toastApiError(err, uiRef.current.fireToast, uiRef.current.t);
      });
  }, [grid.start, grid.end, locationId]);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => () => { seq.current++; }, []); // smontaggio: ignora le risposte in volo

  /* live: modifiche dalle altre postazioni → ricarica senza skeleton, una volta per raffica */
  /* Il timer sta in una ref: `live` cambia identità a ogni evento ricevuto, e
   * con una variabile locale il cleanup dell'effetto annullava il ricarico
   * appena programmato — il mese non si aggiornava mai.
   * Gli eventi sono gli stessi delle viste giorno e settimana (AGENDA_LIVE_RE):
   * ascoltando solo appuntamenti e pause, la caparra pagata e i turni o gli
   * orari cambiati altrove lasciavano pallini e occupazione quelli vecchi. */
  const liveTimer = useRef(null);
  useEffect(() => {
    if (!live?.subscribe) return undefined;
    const unsub = live.subscribe(({ events }) => {
      if (!events.some((e) => AGENDA_LIVE_RE.test(e.type))) return;
      clearTimeout(liveTimer.current);
      liveTimer.current = setTimeout(() => load(true), LIVE_DEBOUNCE_MS);
    });
    return unsub;
  }, [live, load]);
  useEffect(() => () => clearTimeout(liveTimer.current), []);

  /* ---- dati derivati ---- */
  const staff = useMemo(() => operators.filter((o) => o.active !== false), [operators]);
  const opById = useMemo(() => Object.fromEntries(staff.map((o) => [o.id, o])), [staff]);
  const opOrder = useMemo(() => Object.fromEntries(staff.map((o, i) => [o.id, i])), [staff]);
  const opFirsts = useMemo(() => staff.map((o) => o.first_name), [staff]);
  const byDate = useMemo(() => {
    const m = {};
    (data || []).forEach((d) => { m[d.date] = filterDay(d, sel); });
    return m;
  }, [data, sel]);
  const summary = useMemo(() => {
    const inMonth = grid.weeks.flat()
      .filter((iso) => parseISO(iso).getMonth() === grid.month)
      .map((iso) => byDate[iso] || { ...EMPTY_DAY, date: iso });
    return monthSummary(inMonth);
  }, [byDate, grid]);
  const today = todayStr();
  const monthName = (lang === 'en' ? MONTHS_EN : MONTHS_IT)[grid.month];

  /* ---- popover: apertura/chiusura con piccolo ritardo, callback stabili ---- */
  const closeTimer = useRef(null);
  const onCellEnter = useCallback((iso, el) => {
    clearTimeout(closeTimer.current);
    const r = el.getBoundingClientRect();
    const right = r.right + 8 + POP_W <= window.innerWidth - 8;
    setHover({ iso, x: right ? r.right + 8 : Math.max(8, r.left - 8 - POP_W), y: r.top });
  }, []);
  const onCellLeave = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHover(null), HOVER_CLOSE_MS);
  }, []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const toggleOp = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  /* ---- skeleton ---- */
  if (data === null) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', gap: 10, padding: '10px 26px', borderBottom: '1px solid var(--hair)' }}>
          {[...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 40, width: 150, borderRadius: 10 }} />)}
        </div>
        <div style={{ flex: 1, padding: '12px 26px', display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridAutoRows: 'minmax(150px, auto)', gap: 6 }}>
          {[...Array(35)].map((_, i) => <div key={i} className="skel" style={{ borderRadius: 12 }} />)}
        </div>
      </div>
    );
  }

  const hoverDay = hover ? (byDate[hover.iso] || { ...EMPTY_DAY, date: hover.iso }) : null;
  const noData = !error && summary.total === 0 && summary.capacity === 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* riepilogo del mese + legenda + filtro operatrice (una riga, va a capo se stretta) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 26px', borderBottom: '1px solid var(--hair)', flexWrap: 'wrap', flexShrink: 0 }}>
        <StatTile icon="calendar" label={t('Appuntamenti', 'Appointments')} value={summary.total} />
        <StatTile
          icon="clock" label={t('Occupazione media', 'Avg. occupancy')}
          value={summary.ratio == null ? '—' : pctLabel(summary.ratio)}
          sub={summary.capacity ? `${fmtDur(summary.booked)} / ${fmtDur(summary.capacity)}` : t('nessun turno', 'no shifts')}
          tone={LOAD_TONES[loadTone(summary.ratio)]}
        />
        {showRevenue && <StatTile icon="wallet" label={t('Incasso atteso', 'Expected revenue')} value={fmtMoney(summary.revenue, lang)} />}
        <StatTile
          icon="star" label={t('Giorno più pieno', 'Busiest day')}
          value={summary.busiest ? `${(lang === 'en' ? DOW_EN : DOW_IT)[(parseISO(summary.busiest.date).getDay() + 6) % 7]} ${parseISO(summary.busiest.date).getDate()}` : '—'}
          sub={summary.busiest ? `${pctLabel(summary.busiest.ratio)} · ${summary.busiest.count} ${t('app.', 'appts')}` : ''}
          tone={summary.busiest ? LOAD_TONES[loadTone(summary.busiest.ratio)] : null}
          onClick={summary.busiest ? () => onOpenDay(summary.busiest.date) : undefined}
          title={summary.busiest ? t('Apri il giorno', 'Open the day') : undefined}
        />
        <Legend t={t} />
        <div style={{ flex: 1 }} />
        {staff.length > 1 && (
          <div role="group" aria-label={t('Filtra per operatrice', 'Filter by operator')} style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
            <button type="button" aria-pressed={!sel.size} className={'dk-pill' + (sel.size ? '' : ' dk-pill--on')} style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setSel(new Set())}>{t('Tutte', 'All')}</button>
            {staff.map((o) => {
              const on = sel.has(o.id);
              const col = opColors[o.id];
              return (
                <button
                  key={o.id} type="button" aria-pressed={on} onClick={() => toggleOp(o.id)}
                  title={`${o.first_name} ${o.last_name}`.trim()}
                  className={'dk-pill dk-pill--tint' + (on ? ' dk-pill--on' : (sel.size ? ' dk-pill--muted' : ''))}
                  style={{ '--pill-c': col, padding: '2px 9px 2px 3px', fontSize: 12, gap: 6 }}
                >
                  <Avatar initials={o.initials} size={20} color={col} ring={on} />
                  <span>{opDisplay(o.first_name, o.last_name, opFirsts)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 26 }}>
          <div style={{ textAlign: 'center', maxWidth: 320 }}>
            <Icon name="alert" size={26} color="var(--muted-2)" style={{ margin: '0 auto 10px' }} />
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{t('Impossibile caricare il mese', 'Could not load the month')}</div>
            <div className="t-sm" style={{ marginBottom: 14 }}>{t('Controlla la connessione e riprova.', 'Check your connection and try again.')}</div>
            <button type="button" className="dk-btn dk-btn--soft" style={{ height: 38 }} onClick={() => load(false)}>{t('Riprova', 'Retry')}</button>
          </div>
        </div>
      ) : (
        <div className="scroll" onScroll={() => setHover(null)} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 26px', display: 'flex', flexDirection: 'column' }}>
          {noData && (
            <div className="dk-card" style={{ margin: '12px 0 0', padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <Icon name="calendar" size={20} color="var(--muted-2)" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{t(`Nessun turno e nessun appuntamento a ${monthName}`, `No shifts and no appointments in ${monthName}`)}</div>
                <div className="t-sm" style={{ fontSize: 12.5 }}>{t('Imposta i turni in Staff, oppure clicca un giorno per prenotare comunque.', 'Set shifts under Staff, or click a day to book anyway.')}</div>
              </div>
            </div>
          )}
          {/* intestazione giorni: resta visibile durante lo scroll */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6, position: 'sticky', top: 0, zIndex: 2, background: 'var(--paper)', padding: '10px 0 6px', flexShrink: 0 }}>
            {DOW_IT.map((it, i) => (
              <div key={i} className="t-meta" style={{ textAlign: 'center', fontSize: 10.5, color: i >= 5 ? 'var(--muted)' : 'var(--muted-2)' }}>{t(it, DOW_EN[i])}</div>
            ))}
          </div>
          <MonthGrid
            weeks={grid.weeks} month={grid.month} byDate={byDate} today={today}
            t={t} lang={lang} showRevenue={showRevenue}
            opById={opById} opOrder={opOrder} opFirsts={opFirsts} opColors={opColors}
            onOpenDay={onOpenDay} onCellEnter={onCellEnter} onCellLeave={onCellLeave}
          />
        </div>
      )}

      {hover && hoverDay && (
        <DayPopover hover={hover} day={hoverDay} t={t} lang={lang} showRevenue={showRevenue} opById={opById} opOrder={opOrder} opFirsts={opFirsts} opColors={opColors} />
      )}
    </div>
  );
}

/* ---------- riepilogo ---------- */

function StatTile({ icon, label, value, sub, tone, onClick, title }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined} onClick={onClick} title={title}
      className={onClick ? 'dk-hovercard' : undefined}
      style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 11px 5px 9px', border: '1px solid var(--hair)', borderRadius: 10, background: 'var(--surface)', textAlign: 'left', cursor: onClick ? 'pointer' : 'default', minHeight: 40 }}
    >
      <Icon name={icon} size={15} color={tone ? tone.color : 'var(--muted-2)'} stroke={1.9} />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
        <span className="t-meta" style={{ fontSize: 9.5 }}>{label}</span>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="t-num" style={{ fontSize: 16, fontWeight: 600, color: tone ? tone.color : 'var(--ink)' }}>{value}</span>
          {sub && <span className="tabnum" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--muted-2)' }}>{sub}</span>}
        </span>
      </div>
    </Tag>
  );
}

function Legend({ t }) {
  const items = [
    ['ok', t('Libero', 'Light'), `< ${Math.round(LOAD_WARN * 100)}%`],
    ['warn', t('Carico', 'Busy'), `${Math.round(LOAD_WARN * 100)}–${Math.round(LOAD_FULL * 100)}%`],
    ['full', t('Pieno', 'Full'), `> ${Math.round(LOAD_FULL * 100)}%`],
  ];
  return (
    <div role="group" aria-label={t('Legenda occupazione', 'Occupancy legend')} style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 6 }}>
      {items.map(([tone, label, range]) => (
        <span key={tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: LOAD_TONES[tone].color }} />
          {label} <span className="tabnum" style={{ color: 'var(--muted-2)', fontWeight: 500 }}>{range}</span>
        </span>
      ))}
    </div>
  );
}

/* ---------- griglia (memo: non si ridisegna quando cambia solo il popover) ---------- */

const MonthGrid = React.memo(function MonthGrid({ weeks, month, byDate, today, t, lang, showRevenue, opById, opOrder, opFirsts, opColors, onOpenDay, onCellEnter, onCellLeave }) {
  return (
    // gridAutoRows con max `auto`: le righe si allargano fino a riempire l'altezza
    // disponibile e crescono oltre i 150px solo se il contenuto lo richiede.
    <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridAutoRows: 'minmax(150px, auto)', alignContent: 'stretch', gap: 6, paddingBottom: 22 }}>
      {weeks.flat().map((iso, i) => (
        <DayCell
          key={iso} iso={iso} day={byDate[iso] || EMPTY_DAY}
          inMonth={parseISO(iso).getMonth() === month} isToday={iso === today} isWeekend={i % 7 >= 5}
          t={t} lang={lang} showRevenue={showRevenue}
          opById={opById} opOrder={opOrder} opFirsts={opFirsts} opColors={opColors}
          onOpenDay={onOpenDay} onCellEnter={onCellEnter} onCellLeave={onCellLeave}
        />
      ))}
    </div>
  );
});

function DayCell({ iso, day, inMonth, isToday, isWeekend, t, lang, showRevenue, opById, opOrder, opFirsts, opColors, onOpenDay, onCellEnter, onCellLeave }) {
  const num = parseISO(iso).getDate();
  const ratio = loadRatio(day.booked_min, day.capacity_min);
  const tone = LOAD_TONES[loadTone(ratio)];
  const counts = statusCounts(day.by_status);
  const opRows = operatorRows(day, opOrder);
  const appts = sortByStart(day.appointments);
  const aria = [
    dayLabel(iso, lang),
    day.count ? t(`${day.count} appuntamenti`, `${day.count} appointments`) : t('nessun appuntamento', 'no appointments'),
    ratio == null ? t('nessun turno', 'no shifts') : t(`occupazione ${pctLabel(ratio)}`, `${pctLabel(ratio)} booked`),
  ].join(', ');

  return (
    <button
      type="button" aria-label={aria}
      className={inMonth ? 'dk-hovercard' : undefined}
      onClick={() => onOpenDay(iso)}
      onMouseEnter={(e) => onCellEnter(iso, e.currentTarget)} onMouseLeave={onCellLeave}
      onFocus={(e) => onCellEnter(iso, e.currentTarget)} onBlur={onCellLeave}
      style={{
        position: 'relative', minWidth: 0, minHeight: 150, display: 'flex', flexDirection: 'column', gap: 6,
        padding: '7px 9px 8px', textAlign: 'left', borderRadius: 12, cursor: 'pointer', overflow: 'hidden',
        // niente boxShadow inline: vincerebbe sull'ombra hover di .dk-hovercard
        border: '1px solid ' + (isToday ? 'var(--ink)' : 'var(--hair)'),
        background: !inMonth ? 'transparent' : isWeekend ? 'var(--surface-2)' : 'var(--surface)',
        opacity: inMonth ? 1 : 0.55,
      }}
    >
      {/* numero del giorno + percentuale (o "Nessun turno") */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <span className="t-num" style={{ fontSize: 15, lineHeight: 1, width: 24, height: 24, marginLeft: -4, borderRadius: 99, display: 'grid', placeItems: 'center', background: isToday ? 'var(--ink)' : 'transparent', color: isToday ? '#fff' : 'var(--ink)', fontWeight: isToday ? 600 : 400 }}>{num}</span>
        {ratio != null ? (
          <span className="tabnum" style={{ fontSize: 10.5, fontWeight: 700, color: tone.color, background: tone.tint, padding: '2px 6px', borderRadius: 99, lineHeight: 1.3 }}>{pctLabel(ratio)}</span>
        ) : (
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--faint)', whiteSpace: 'nowrap' }}>{t('Nessun turno', 'No shifts')}</span>
        )}
      </div>

      {/* barra di occupazione della giornata */}
      {ratio != null && <Bar ratio={ratio} color={tone.color} height={5} />}

      {/* conteggio, incasso, pallini di stato */}
      {day.count > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 10.5, lineHeight: 1.2 }}>
          <span className="tabnum" style={{ fontWeight: 700, color: 'var(--ink-2)' }}>{day.count} {t('app.', 'appts')}</span>
          {showRevenue && <span className="tabnum" style={{ fontWeight: 600, color: 'var(--muted)' }}>{fmtMoney(day.revenue, lang)}</span>}
          <span style={{ flex: 1 }} />
          {counts.map(([st, n]) => {
            const sm = statusMeta(st, t);
            return (
              <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <span style={{ width: 6, height: 6, borderRadius: 99, background: sm.color }} />
                <span className="tabnum" style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)' }}>{n}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* mini-barre per operatrice */}
      {opRows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {opRows.slice(0, MAX_OP_ROWS).map((o) => <OpRow key={o.operator_id} o={o} op={opById[o.operator_id]} color={opColors[o.operator_id]} opFirsts={opFirsts} compact />)}
          {opRows.length > MAX_OP_ROWS && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted-2)' }}>+{opRows.length - MAX_OP_ROWS}</span>}
        </div>
      )}

      {/* primi appuntamenti, il resto nel popover / nel giorno */}
      {appts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 'auto' }}>
          {appts.slice(0, MAX_APPTS).map((a) => <ApptLine key={a.id} a={a} color={opColors[a.operator_id]} t={t} />)}
          {appts.length > MAX_APPTS && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--muted)', paddingLeft: 7 }}>+{appts.length - MAX_APPTS} {t('altri', 'more')}</span>}
        </div>
      )}
    </button>
  );
}

/* ---------- pezzi condivisi tra cella e popover ---------- */

function Bar({ ratio, color, height = 4 }) {
  const w = Math.min(100, Math.max(0, (ratio || 0) * 100));
  return (
    <span style={{ display: 'block', height, borderRadius: 99, background: TRACK, overflow: 'hidden', flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', width: w + '%', height: '100%', borderRadius: 99, background: color, transition: 'width 240ms var(--ease)' }} />
    </span>
  );
}

/** Riga operatrice: nome breve + barra nel suo colore; in versione estesa anche i minuti. */
function OpRow({ o, op, color, opFirsts, compact }) {
  const ratio = loadRatio(o.booked_min, o.capacity_min);
  const fill = ratio == null ? (o.booked_min ? 1 : 0) : ratio; // prenotazioni senza turno: barra piena
  const col = color || 'var(--muted-2)';
  const name = op ? opDisplay(op.first_name, op.last_name, opFirsts) : '—';
  return (
    <div title={compact && op ? `${op.first_name} ${op.last_name} · ${fmtDur(o.booked_min)} / ${fmtDur(o.capacity_min)}` : undefined} style={{ display: 'flex', alignItems: 'center', gap: compact ? 5 : 8, minWidth: 0 }}>
      <span style={{ fontSize: compact ? 10 : 12, fontWeight: 600, color: 'var(--ink-2)', width: compact ? '38%' : 84, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      <Bar ratio={fill} color={col} height={compact ? 4 : 6} />
      {!compact && (
        <span className="tabnum" style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', flexShrink: 0, minWidth: 74, textAlign: 'right' }}>
          {o.capacity_min ? `${fmtDur(o.booked_min)} / ${fmtDur(o.capacity_min)}` : (o.booked_min ? fmtDur(o.booked_min) : '—')}
        </span>
      )}
    </div>
  );
}

/** Appuntamento compatto: striscia colore operatrice, ora, cliente, marcatori forzato/caparra. */
function ApptLine({ a, color, t, detail }) {
  const noShow = a.status === 'no_show';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, borderLeft: `3px solid ${color || 'var(--muted-2)'}`, paddingLeft: 5, opacity: noShow ? 0.5 : 1, lineHeight: 1.25 }}>
      <span className="tabnum" style={{ fontSize: detail ? 11.5 : 10, fontWeight: 700, color: 'var(--ink-2)', flexShrink: 0 }}>{timeLabel(minutesOfDay(a.start))}</span>
      <span style={{ fontSize: detail ? 12.5 : 10.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: noShow ? 'line-through' : 'none' }}>{a.client_name}</span>
      {a.forced && <span role="img" aria-label={t('Forzato', 'Forced')} title={t('Forzato', 'Forced')} style={{ fontSize: 12, fontWeight: 800, color: 'var(--clay-ink)', lineHeight: 1, flexShrink: 0 }}>*</span>}
      {a.deposit_status === 'required' && <span role="img" aria-label={t('Caparra richiesta', 'Deposit due')} title={t('Caparra richiesta', 'Deposit due')} style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--warn)', flexShrink: 0 }} />}
      {(a.gifts || []).length > 0 && <Icon name="gift" size={11} color="var(--clay-ink)" title={t('Trattamento regalato', 'Gifted treatment')} style={{ flexShrink: 0 }} />}
      {detail && <span style={{ flex: 1 }} />}
      {detail && <span className="t-sm" style={{ fontSize: 11, color: 'var(--muted-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%', flexShrink: 1 }}>{detail}</span>}
    </div>
  );
}

/* ---------- popover della giornata (hover / focus) ---------- */

function DayPopover({ hover, day, t, lang, showRevenue, opById, opOrder, opFirsts, opColors }) {
  const ref = useRef(null);
  // La posizione arriva dalla cella; l'altezza si conosce solo dopo il render:
  // se sborda in basso risalgo senza passare da un nuovo stato.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.top = hover.y + 'px';
    const r = el.getBoundingClientRect();
    const over = r.bottom - (window.innerHeight - 8);
    if (over > 0) el.style.top = Math.max(8, hover.y - over) + 'px';
  }, [hover, day]);

  const ratio = loadRatio(day.booked_min, day.capacity_min);
  const tone = LOAD_TONES[loadTone(ratio)];
  const counts = statusCounts(day.by_status);
  const opRows = operatorRows(day, opOrder);
  const appts = sortByStart(day.appointments);
  const label = dayLabel(day.date, lang);

  return (
    <div
      ref={ref} role="tooltip" className="dk-card"
      style={{ position: 'fixed', top: hover.y, left: hover.x, width: POP_W, zIndex: 90, padding: '13px 14px 12px', boxShadow: 'var(--sh-pop)', pointerEvents: 'none', maxHeight: 'calc(100vh - 16px)', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, textTransform: 'capitalize' }}>{label}</div>
          <div className="t-sm" style={{ fontSize: 12 }}>
            {day.count ? t(`${day.count} appuntamenti`, `${day.count} appointments`) : t('Nessun appuntamento', 'No appointments')}
            {showRevenue && day.count > 0 && ` · ${fmtMoney(day.revenue, lang)}`}
          </div>
        </div>
        {ratio != null ? (
          <span className="tabnum" style={{ fontSize: 12, fontWeight: 700, color: tone.color, background: tone.tint, padding: '3px 8px', borderRadius: 99 }}>{pctLabel(ratio)}</span>
        ) : (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted-2)' }}>{t('Nessun turno', 'No shifts')}</span>
        )}
      </div>

      {ratio != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Bar ratio={ratio} color={tone.color} height={6} />
          <span className="tabnum" style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', flexShrink: 0 }}>{fmtDur(day.booked_min)} / {fmtDur(day.capacity_min)}</span>
        </div>
      )}

      {counts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
          {counts.map(([st, n]) => {
            const sm = statusMeta(st, t);
            return (
              <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: sm.color }} />
                <span className="tabnum" style={{ color: 'var(--ink-2)', fontWeight: 700 }}>{n}</span> {sm.label}
              </span>
            );
          })}
        </div>
      )}

      {opRows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 8, borderTop: '1px solid var(--hair)' }}>
          {opRows.map((o) => <OpRow key={o.operator_id} o={o} op={opById[o.operator_id]} color={opColors[o.operator_id]} opFirsts={opFirsts} />)}
        </div>
      )}

      {appts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8, borderTop: '1px solid var(--hair)' }}>
          {appts.slice(0, POP_MAX_APPTS).map((a) => {
            const op = opById[a.operator_id];
            const who = op ? opDisplay(op.first_name, op.last_name, opFirsts) : '';
            const svc = (a.services || []).join(' + ');
            return <ApptLine key={a.id} a={a} color={opColors[a.operator_id]} t={t} detail={[who, svc].filter(Boolean).join(' · ')} />;
          })}
          {appts.length > POP_MAX_APPTS && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', paddingLeft: 8 }}>+{appts.length - POP_MAX_APPTS} {t('altri', 'more')}</span>}
        </div>
      )}

      <div className="t-sm" style={{ fontSize: 11, color: 'var(--muted-2)' }}>{t('Clic sulla cella per aprire il giorno', 'Click the cell to open the day')}</div>
    </div>
  );
}
