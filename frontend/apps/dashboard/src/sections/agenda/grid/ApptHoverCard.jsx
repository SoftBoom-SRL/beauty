// ApptHoverCard — l'anteprima di un appuntamento al passaggio del mouse, la
// stessa in giorno e settimana (`hints` = i gesti che la vista permette).
// La mostra la vista che la chiede, con la posizione di hoverPlacement.
import { Avatar, Icon, fmtDur, timeLabel } from '@youty/shared';
import { aEndMin, aStartMin, initialsOf, svcLabel } from '../lib.js';

/* ---------- appointment hover card ---------- */
export default function ApptHoverCard({ hover, t, lang, operators, colorOf, hints = 'day' }) {
  const { a, x, y, side } = hover;
  const o = operators.find((op) => op.id === a.operator_id);
  const opName = o ? o.first_name + ' ' + o.last_name : ((a.items || [])[0]?.operator_name || '');
  const col = colorOf(a.operator_id);
  const startMin = aStartMin(a), endMin = aEndMin(a);
  return (
    <div style={{ position: 'fixed', top: y, left: side === 'right' ? x : undefined, right: side === 'left' ? (window.innerWidth - x) : undefined, zIndex: 90, width: 300, background: 'var(--surface)', border: '1px solid var(--hair)', borderRadius: 14, boxShadow: 'var(--sh-pop)', padding: 16, pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Avatar initials={initialsOf(a.client?.full_name)} size={38} color={col} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{a.client?.full_name}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{opName}</div>
        </div>
        <span style={{ width: 10, height: 10, borderRadius: 99, background: col, flexShrink: 0 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <Icon name="scissors" size={15} color="var(--muted-2)" style={{ marginTop: 1, flexShrink: 0 }} />
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>{svcLabel(a)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name="clock" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} />
          <span className="tabnum" style={{ fontSize: 13.5 }}>{timeLabel(startMin)}–{timeLabel(endMin)}</span>
          <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {fmtDur(endMin - startMin, lang)}</span>
        </div>
        {a.client?.phone && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="phone" size={15} color="var(--muted-2)" style={{ flexShrink: 0 }} />
            <span className="tabnum" style={{ fontSize: 13.5 }}>{a.client.phone}</span>
          </div>
        )}
        {a.note && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 2, padding: '9px 11px', background: 'var(--warn-tint)', borderRadius: 10 }}>
            <Icon name="info" size={15} color="var(--warn)" style={{ marginTop: 1, flexShrink: 0 }} />
            <span className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}>{a.note}</span>
          </div>
        )}
        {/* In settimana non si ridimensiona: prometterlo sarebbe una bugia. */}
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2, fontSize: 11.5 }}>
          {hints === 'week'
            ? t('Clic: dettaglio · Trascina: sposta, anche su un altro giorno', 'Click: details · Drag: move, to another day too')
            : t('Clic: dettaglio · Trascina: sposta questo servizio · Barra a sinistra: tutta la visita', 'Click: details · Drag: move this service · Left bar: the whole visit')}
        </div>
      </div>
    </div>
  );
}
