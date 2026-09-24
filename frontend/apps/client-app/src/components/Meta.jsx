// Meta.jsx — una riga «icona + testo» dei dettagli di un appuntamento.
import { Icon } from '@youty/shared';

/** Inline icon+text meta row. */
export function Meta({ icon, text }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>
      <Icon name={icon} size={15} color="var(--brand)" />{text}
    </span>
  );
}
