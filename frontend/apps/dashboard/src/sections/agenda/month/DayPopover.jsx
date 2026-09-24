// DayPopover — il popover di una giornata del mese al passaggio del mouse (o
// col fuoco): occupazione, stati, operatrici e appuntamenti. La posizione
// arriva dalla cella; se sborda in basso risale.
import { useLayoutEffect, useRef } from 'react';
import { fmtDur, statusMeta } from '@youty/shared';
import { fmtMoney, opDisplay } from '../lib.js';
import { loadRatio, loadTone, LOAD_TONES, statusCounts, sortByStart, operatorRows, dayLabel, pctLabel } from '../monthLib.js';
import { ApptLine, Bar, OpRow } from './DayParts.jsx';

export const POP_W = 320;
const POP_MAX_APPTS = 12;   // appuntamenti nel popover, poi "+N"

/* ---------- popover della giornata (hover / focus) ---------- */

export default function DayPopover({ hover, day, t, lang, showRevenue, opById, opOrder, opFirsts, opColors }) {
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
