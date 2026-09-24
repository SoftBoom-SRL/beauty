// SuccessScreen.jsx — la schermata di fine di Prenota, Sposta e Annulla.
import { Icon } from '@youty/shared';
import { headFont, headWeight } from '../theme.js';

/** Il cerchio col segno di spunta, il titolo e il testo; sotto, i `children`
 *  (avvisi e pulsanti di chi la usa). `muted`: il cerchio grigio
 *  dell'annullamento invece di quello del brand. */
export function SuccessScreen({ brand, title, text, muted = false, children }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 30, textAlign: 'center' }}>
      <div className="pop-in" style={{ width: 86, height: 86, borderRadius: 99, background: muted ? 'var(--paper-2)' : 'var(--brand-tint)', display: 'grid', placeItems: 'center', marginBottom: 20 }}>
        <Icon name="check" size={44} color={muted ? 'var(--muted)' : 'var(--brand)'} stroke={2.2} />
      </div>
      <div style={{ fontFamily: headFont(brand), fontSize: 26, fontWeight: headWeight(brand) }}>{title}</div>
      <div className="t-body" style={{ color: 'var(--muted)', marginTop: 8, maxWidth: 280 }}>
        {text}
      </div>
      {children}
    </div>
  );
}
