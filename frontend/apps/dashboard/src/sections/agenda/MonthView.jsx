// MonthView — griglia mensile da GET /api/agenda/range (un solo fetch per mese).
// Ogni cella dice come è messa la giornata senza aprirla: occupazione a soglie,
// mini-barre per operatrice, primi appuntamenti; il popover al passaggio del mouse
// mostra il resto. In testa il riepilogo del mese e il filtro operatrice locale.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toastApiError, todayStr, parseISO, fmtDur, Avatar, Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { DOW_IT, DOW_EN, MONTHS_IT, MONTHS_EN, dowIndex, fmtMoney, opDisplay, LIVE_DEBOUNCE_MONTH_MS } from './lib.js';
import { monthGrid, filterDay, monthSummary, loadTone, LOAD_TONES, pctLabel, EMPTY_DAY } from './monthLib.js';
import * as agendaApi from './agendaApi.js';
import { useLatest } from './hooks/useLatest.js';
import { useAgendaLive } from './hooks/useAgendaLive.js';
import StatTile from './month/StatTile.jsx';
import Legend from './month/Legend.jsx';
import MonthGrid from './month/MonthGrid.jsx';
import DayPopover, { POP_W } from './month/DayPopover.jsx';

const HOVER_CLOSE_MS = 120; // il popover sopravvive al passaggio tra due celle vicine

export default function MonthView({ anchor, onOpenDay }) {
  const { t, lang, showRevenue, fireToast, operators, opColors, live, locationId } = useDash();
  const grid = useMemo(() => monthGrid(anchor), [anchor]);
  const [data, setData] = useState(null);       // [giorno /range] | null = caricamento
  const [error, setError] = useState(false);
  const [sel, setSel] = useState(() => new Set()); // filtro operatrice locale (vuoto = tutte)
  const [hover, setHover] = useState(null);     // { iso, x, y } — stato separato: la griglia (memo) non si ridisegna
  const seq = useRef(0);                        // scarta le risposte arrivate dopo un cambio mese
  const uiRef = useLatest({ t, fireToast });

  /* ---- caricamento: una chiamata per l'intera griglia (5-6 settimane) ---- */
  const load = useCallback((silent) => {
    const my = ++seq.current;
    if (!silent) { setData(null); setError(false); }
    agendaApi.getRange(grid.start, grid.end, locationId)
      .then((rows) => { if (my !== seq.current) return; setData(rows); setError(false); })
      .catch((err) => {
        if (my !== seq.current) return;
        if (!silent) { setData([]); setError(true); }
        toastApiError(err, uiRef.current.fireToast, uiRef.current.t);
      });
  }, [grid.start, grid.end, locationId, uiRef]);   // la ref è stabile

  useEffect(() => { load(false); }, [load]);
  useEffect(() => () => { seq.current++; }, []); // smontaggio: ignora le risposte in volo

  /* live: modifiche dalle altre postazioni → ricarica senza skeleton, una volta per raffica
   * (useAgendaLive: il timer sta in una ref, e il cleanup non lo annulla).
   * Gli eventi sono gli stessi delle viste giorno e settimana (AGENDA_LIVE_RE):
   * ascoltando solo appuntamenti e pause, la caparra pagata e i turni o gli
   * orari cambiati altrove lasciavano pallini e occupazione quelli vecchi. */
  const onLive = useCallback(() => load(true), [load]);
  useAgendaLive(live, onLive, LIVE_DEBOUNCE_MONTH_MS);

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
          value={summary.busiest ? `${(lang === 'en' ? DOW_EN : DOW_IT)[dowIndex(parseISO(summary.busiest.date))]} ${parseISO(summary.busiest.date).getDate()}` : '—'}
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
