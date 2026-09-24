// ClientSubHead.jsx — l'intestazione degli schermi interni: indietro e titolo.
import { Icon } from '@youty/shared';
import { headFont, headWeight } from '../theme.js';

/** Screen sub-header with back chevron. */
export function ClientSubHead({ brand, title, onBack }) {
  return (
    <div style={{ padding: '0 16px' }}>
      <div style={{ paddingTop: 'var(--safe-top)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10 }}>
        <button className="press" onClick={onBack} style={{ width: 42, height: 42, marginLeft: -8, borderRadius: 99, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="chevL" size={24} />
        </button>
        <div style={{ flex: 1, minWidth: 0, fontFamily: headFont(brand), fontSize: 21, fontWeight: headWeight(brand, 700), lineHeight: 1.15 }}>{title}</div>
      </div>
    </div>
  );
}
