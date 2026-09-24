// sell/OperatorBlock.jsx — il blocco di un'operatrice nel check-out
// (SellModal): chi è, quanto ha venduto, le sue righe (sconto prodotto,
// omaggio, togli per le righe aggiunte) e sotto, come `children`, il modo per
// aggiungerne altre.
import { Avatar, Icon, NumInput } from '@youty/shared';
import { lineAmount, money } from '../lib.js';

const lineIcon = (l) => (l.line_type === 'gift_card' ? 'gift' : l.line_type === 'product' ? 'box' : 'scissors');

export default function OperatorBlock({ lines, subtotal, color, initials, label, onPatch, onRemove, children, t, lang }) {
  return (
    <div style={{ border: '1px solid var(--hair)', borderRadius: 14 }}>
      {/* operator header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderRadius: '13px 13px 0 0', background: `color-mix(in srgb, ${color} 14%, var(--surface))` }}>
        <Avatar initials={initials} size={30} color={color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Vendita accreditata', 'Sale credited')}</div>
        </div>
        <span className="t-num" style={{ fontWeight: 700, fontSize: 15 }}>{money(subtotal, lang)}</span>
      </div>

      <div style={{ padding: '4px 14px 12px' }}>
        {lines.map((l) => (
          <div key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--hair)' }}>
            <Icon name={lineIcon(l)} size={14} color="var(--muted-2)" style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 600, color: l.is_gift ? 'var(--ok)' : 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {l.name}{l.line_type === 'gift_card' && l.recipient_name ? ' · ' + l.recipient_name : ''}
            </span>
            {l.line_type === 'product' && !l.is_gift && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 1, border: '1px solid var(--hair)', borderRadius: 8, padding: '3px 6px', height: 26, boxSizing: 'border-box', background: 'var(--surface)', flexShrink: 0 }} title={t('Sconto prodotto', 'Product discount')}>
                <NumInput integer min={0} max={100} value={l.discount_pct}
                  onChange={(discount_pct) => onPatch(l.key, { discount_pct })}
                  style={{ width: 24, textAlign: 'right', border: 'none', outline: 'none', background: 'transparent', fontSize: 12.5, fontWeight: 700, fontFamily: 'ui-monospace, monospace' }} />
                <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>%</span>
              </div>
            )}
            {l.line_type !== 'gift_card' && (
              <button onClick={() => onPatch(l.key, { is_gift: !l.is_gift })} title={t('Ometti pagamento', 'Comp this item')} className="dk-iconbtn"
                style={{ width: 26, height: 26, flexShrink: 0, background: l.is_gift ? 'var(--ok-tint)' : 'transparent', borderRadius: 7 }}>
                <Icon name="gift" size={14} color={l.is_gift ? 'var(--ok)' : 'var(--muted-2)'} />
              </button>
            )}
            {l.extra && (
              <button onClick={() => onRemove(l.key)} className="dk-iconbtn" style={{ width: 26, height: 26, flexShrink: 0, borderRadius: 7 }}>
                <Icon name="x" size={13} color="var(--muted-2)" />
              </button>
            )}
            <span className="t-num" style={{ minWidth: 54, textAlign: 'right', fontSize: 13, flexShrink: 0 }}>
              {l.is_gift
                ? <span style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 12 }}>{t('Omaggio', 'Free')}</span>
                : money(lineAmount(l), lang)}
            </span>
          </div>
        ))}

        {children}
      </div>
    </div>
  );
}
