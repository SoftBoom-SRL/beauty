// BrandHero.jsx — la testata col brand del salone di accesso e modulo contatti.
// La copertina della Home è un'altra (più alta, col motivo a puntini).
import { headFont } from '../theme.js';

/** Logo (o iniziale), nome del salone e il sottotitolo `subtitle`. */
export function BrandHero({ brand, subtitle }) {
  return (
    <div style={{ background: 'var(--brand)', padding: 'calc(var(--safe-top) + 34px) 24px 30px' }}>
      <div style={{ width: 62, height: 62, borderRadius: 99, background: 'var(--brand-on)', display: 'grid', placeItems: 'center', overflow: 'hidden', marginBottom: 14, boxShadow: '0 4px 14px rgba(0,0,0,0.18)' }}>
        {brand.logo
          ? <img src={brand.logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <span style={{ fontFamily: 'var(--serif)', fontSize: 28, fontStyle: 'italic', color: 'var(--brand)', lineHeight: 1 }}>{brand.name.charAt(0)}</span>}
      </div>
      <div style={{ fontFamily: headFont(brand), fontSize: 30, fontWeight: brand.type === 'serif' ? 500 : 800, color: 'var(--brand-on)', lineHeight: 1.05 }}>{brand.name}</div>
      <div style={{ color: 'var(--brand-on)', opacity: 0.75, fontSize: 13, fontWeight: 600, marginTop: 6 }}>
        {subtitle}
      </div>
    </div>
  );
}
