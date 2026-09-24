// PaletteGrid.jsx — la griglia dei colori (GD_PALETTE) per brand e categorie.
import { Icon } from '@youty/shared';
import { GD_PALETTE } from './palette.js';

export default function PaletteGrid({ value, onChange, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280, ...style }}>
      {GD_PALETTE.map((row, ri) => (
        <div key={ri} style={{ display: 'flex', gap: 3 }}>
          {row.map((c) => {
            const on = (value || '').toLowerCase() === c.toLowerCase();
            return (
              <button key={c} onClick={() => onChange(c)} title={c}
                style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
                {on && <Icon name="check" size={12} color={ri === 0 && row.indexOf(c) > 6 ? 'var(--ink)' : '#fff'} stroke={2.6} />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
