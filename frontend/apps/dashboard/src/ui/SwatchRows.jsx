// SwatchRows.jsx — le tinte dei trattamenti in file con il loro nome (vivaci,
// scure, tenui: TREATMENT_SWATCHES). Le usano la scheda del servizio e la
// gestione delle categorie dei servizi.
import { Icon } from '@youty/shared';
import { wantsLightText } from './colorTools.js';
import { TREATMENT_SWATCHES } from './palette.js';

/** `value` = il colore scelto, `onChange(hex)`; `size` = il lato di un quadratino. */
export default function SwatchRows({ value, onChange, t, size = 22, rows = TREATMENT_SWATCHES }) {
  const sel = String(value || '').toLowerCase();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', alignItems: 'center' }}>
      {rows.map((row) => (
        <div key={row.key} style={{ display: 'contents' }}>
          <span className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5, fontWeight: 600 }}>{t(row.it, row.en)}</span>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {row.colors.map((c) => {
              const on = sel === c.toLowerCase();
              return (
                <button key={c} type="button" onClick={() => onChange(c)} title={c} aria-label={c} aria-pressed={on}
                  style={{ width: size, height: size, borderRadius: 6, background: c, cursor: 'pointer', border: '1px solid color-mix(in srgb, var(--ink) 10%, transparent)', outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, display: 'grid', placeItems: 'center', padding: 0, flexShrink: 0 }}>
                  {on && <Icon name="check" size={12} color={wantsLightText(c) ? '#fff' : 'var(--ink)'} stroke={2.6} />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
