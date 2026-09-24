// cart/CartLine.jsx — una riga del carrello del banco (CartTab): nome, prezzo
// scontato, sconto di riga, omaggio e quantità (o la X per una gift card).
import { Icon, NumInput } from '@youty/shared';
import { money } from '../lib.js';

/* `val`: il valore della riga già scontato; `d`: lo sconto che vale per lei
 * (il suo o quello della vendita, counterDiscountPct). */
export default function CartLine({ l, val, d, onPatch, onStep, onRemove, t, lang }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', border: l.is_gift ? '1px solid var(--ok)' : '1px solid transparent' }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--surface)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name={l.line_type === 'gift_card' ? 'gift' : 'box'} size={16} color={l.is_gift ? 'var(--ok)' : 'var(--clay-ink)'} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {l.name}{l.line_type === 'gift_card' && l.recipient_name ? ' · ' + l.recipient_name : ''}
        </div>
        <div className="t-sm" style={{ color: l.is_gift ? 'var(--ok)' : 'var(--muted)', fontWeight: l.is_gift ? 700 : 400 }}>
          {l.is_gift ? t('Omaggio', 'Free gift') : money(val, lang)}
          {!l.is_gift && d > 0 ? ` · −${d}%` : ''}
          {!l.is_gift && l.qty > 1 ? ' × ' + l.qty : ''}
        </div>
      </div>
      {l.line_type === 'product' && !l.is_gift && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 1, border: '1px solid ' + (l.disc > 0 ? 'var(--clay)' : 'var(--hair)'), borderRadius: 7, padding: '2px 5px', background: 'var(--surface)', flexShrink: 0 }} title={t('Sconto riga', 'Line discount')}>
          <NumInput integer min={0} max={100} value={l.disc}
            onChange={(disc) => onPatch(l.key, { disc })}
            style={{ width: 24, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontSize: 12, fontWeight: 700, fontFamily: 'ui-monospace, monospace' }} />
          <span style={{ color: 'var(--muted-2)', fontWeight: 700, fontSize: 11 }}>%</span>
        </div>
      )}
      {l.line_type === 'product' && (
        <button onClick={() => onPatch(l.key, { is_gift: !l.is_gift })} title={t('Ometti pagamento', 'Comp this item')} className="dk-iconbtn"
          style={{ width: 26, height: 26, flexShrink: 0, background: l.is_gift ? 'var(--ok-tint)' : 'transparent', borderRadius: 7 }}>
          <Icon name="gift" size={14} color={l.is_gift ? 'var(--ok)' : 'var(--muted-2)'} />
        </button>
      )}
      {l.line_type === 'product' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button className="dk-iconbtn" style={{ width: 26, height: 26, fontSize: 16, fontWeight: 700, lineHeight: 1, color: 'var(--ink-2)' }}
            onClick={() => (l.qty === 1 ? onRemove(l.key) : onStep(l, -1))}>
            {l.qty === 1 ? <Icon name="x" size={13} /> : '−'}
          </button>
          <span className="t-num" style={{ minWidth: 18, textAlign: 'center', fontWeight: 700, fontSize: 13.5 }}>{l.qty}</span>
          <button className="dk-iconbtn" style={{ width: 26, height: 26 }} onClick={() => onStep(l, 1)}><Icon name="plus" size={13} /></button>
        </div>
      ) : (
        <button className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0 }} onClick={() => onRemove(l.key)}><Icon name="x" size={13} /></button>
      )}
    </div>
  );
}
