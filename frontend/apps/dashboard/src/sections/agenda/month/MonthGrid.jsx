// MonthGrid — la griglia del mese (5-6 settimane) e le sue celle: ogni cella
// dice come è messa la giornata senza aprirla — occupazione a soglie, righe
// per operatrice, primi appuntamenti. React.memo: la griglia non si
// ridisegna quando cambia solo il popover (MonthView non la monta nei test
// col React finto).
import React from 'react';
import { parseISO, statusMeta } from '@youty/shared';
import { fmtMoney } from '../lib.js';
import { loadRatio, loadTone, LOAD_TONES, statusCounts, sortByStart, operatorRows, dayLabel, pctLabel, EMPTY_DAY } from '../monthLib.js';
import { ApptLine, Bar, OpRow } from './DayParts.jsx';

const MAX_OP_ROWS = 5;      // righe operatrice in cella, poi "+N"
const MAX_APPTS = 3;        // appuntamenti in cella, poi "+N altri"

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

export default MonthGrid;
