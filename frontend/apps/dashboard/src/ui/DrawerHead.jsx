// ui/DrawerHead.jsx — la testata dei drawer delle Impostazioni: titolo,
// sottotitolo e la X per chiudere. I disegni sono tre e restano tre: unirli
// cambierebbe l'aspetto di qualche drawer.
import { Icon } from '@youty/shared';

/**
 *  - 'serif' (Orari, Brand, Password): titolo serif 22; `padBottom` 18 (Orari
 *    16) e `closeLabel`, l'aria-label della X, dove c'era;
 *  - 'team' (Team, Ruoli): titolo serif 21 e X da 19;
 *  - 'modal' (Motivazioni, Pagamenti): la testata dei modali, .dk-modalhead.
 */
export default function DrawerHead({ variant = 'serif', title, sub, onClose, closeLabel, padBottom = 18 }) {
  if (variant === 'team') {
    return (
      <div style={{ padding: '22px 22px 18px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 500 }}>{title}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{sub}</div>
        </div>
        <button className="dk-iconbtn" onClick={onClose}><Icon name="x" size={19} /></button>
      </div>
    );
  }
  if (variant === 'modal') {
    return (
      <div className="dk-modalhead">
        <div style={{ flex: 1 }}>
          <div className="t-title" style={{ fontSize: 20 }}>{title}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{sub}</div>
        </div>
        <button className="dk-iconbtn" onClick={onClose} aria-label={closeLabel} style={{ width: 36, height: 36 }}><Icon name="x" size={17} /></button>
      </div>
    );
  }
  return (
    <div style={{ padding: `22px 22px ${padBottom}px`, borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, lineHeight: 1.15 }}>{title}</div>
        <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{sub}</div>
      </div>
      <button className="dk-iconbtn" style={{ flexShrink: 0, marginLeft: 12 }} onClick={onClose} aria-label={closeLabel}><Icon name="x" size={18} /></button>
    </div>
  );
}
