// DetailRow.jsx — una riga del riepilogo della prenotazione.
import { Icon } from '@youty/shared';

/** Review detail line. */
export function DetailRow({ icon, label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <Icon name={icon} size={17} color="var(--brand)" />
      <span className="t-sm" style={{ color: 'var(--muted)', width: 90, flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 700, fontSize: 14.5, flex: 1, textAlign: 'right' }}>{value}</span>
    </div>
  );
}
