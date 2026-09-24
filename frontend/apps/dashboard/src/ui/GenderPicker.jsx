// GenderPicker — pillole a scelta singola per il genere del cliente.
// Vuoto = non specificato (cliccare di nuovo la pillola attiva la deseleziona).
// Condiviso fra la scheda cliente (sezione Clienti) e la creazione rapida in agenda.

export const GENDERS = [
  { k: 'female', it: 'Donna', en: 'Woman', glyph: '♀' },
  { k: 'male', it: 'Uomo', en: 'Man', glyph: '♂' },
  { k: 'other', it: 'Altro', en: 'Other', glyph: '⚧' },
];
export function genderLabel(g, t) {
  const m = GENDERS.find((x) => x.k === g);
  return m ? t(m.it, m.en) : '';
}
export function genderGlyph(g) {
  return GENDERS.find((x) => x.k === g)?.glyph || '';
}

export default function GenderPicker({ value, onChange, t, disabled, compact }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }} role="radiogroup">
      {GENDERS.map((g) => {
        const on = value === g.k;
        return (
          <button key={g.k} type="button" role="radio" aria-checked={on} aria-disabled={disabled}
            onClick={() => !disabled && onChange(on ? '' : g.k)}
            className={'dk-pill' + (on ? ' dk-pill--on' : '')} style={{ padding: compact ? '3px 10px' : '6px 12px', fontSize: compact ? 12 : 13 }}>
            <span aria-hidden="true" style={{ fontSize: compact ? 12 : 13.5, opacity: 0.85 }}>{g.glyph}</span>{t(g.it, g.en)}
          </button>
        );
      })}
      {!value && !compact && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('non specificato', 'not specified')}</span>}
    </div>
  );
}
