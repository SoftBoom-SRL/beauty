// StatTile — una casella del riepilogo del mese (appuntamenti, occupazione,
// incasso atteso, giorno più pieno); con `onClick` è un bottone.
import { Icon } from '@youty/shared';

export default function StatTile({ icon, label, value, sub, tone, onClick, title }) {
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
