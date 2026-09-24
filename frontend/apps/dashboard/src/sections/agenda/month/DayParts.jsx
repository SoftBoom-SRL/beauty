// DayParts — i pezzi comuni alla cella del mese e al suo popover: la barra
// di occupazione, la riga di un'operatrice e la riga di un appuntamento.
import { Icon, fmtDur, minutesOfDay, timeLabel } from '@youty/shared';
import { opDisplay } from '../lib.js';
import { loadRatio } from '../monthLib.js';

const TRACK = 'color-mix(in srgb, var(--ink) 8%, transparent)'; // fondo delle barre, visibile su ogni tema

/* ---------- pezzi condivisi tra cella e popover ---------- */

export function Bar({ ratio, color, height = 4 }) {
  const w = Math.min(100, Math.max(0, (ratio || 0) * 100));
  return (
    <span style={{ display: 'block', height, borderRadius: 99, background: TRACK, overflow: 'hidden', flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', width: w + '%', height: '100%', borderRadius: 99, background: color, transition: 'width 240ms var(--ease)' }} />
    </span>
  );
}

/** Riga operatrice: nome breve + barra nel suo colore; in versione estesa anche i minuti. */
export function OpRow({ o, op, color, opFirsts, compact }) {
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
export function ApptLine({ a, color, t, detail }) {
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
