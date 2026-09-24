// cart/GiftCardBuilder.jsx — la riga «Gift card» sotto il catalogo del banco
// (CartTab): importo, destinatario facoltativo e Aggiungi, che mette nel
// carrello una carta prepagata da emettere con la vendita.
import { Icon, NumInput } from '@youty/shared';
import { toCents } from '../lib.js';

export default function GiftCardBuilder({ amt, setAmt, name, setName, onAdd, t }) {
  return (
    <div className="dk-card" style={{ marginTop: 16, padding: 16, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--ok-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Icon name="gift" size={20} color="var(--ok)" />
      </div>
      <div style={{ flex: 1, minWidth: 130 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Gift card', 'Gift card')}</div>
        <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Emetti una carta prepagata', 'Issue a prepaid card')}</div>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 10, padding: '8px 10px', background: 'var(--surface)', width: 86, boxSizing: 'border-box' }}>
        <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
        <NumInput min={1} value={amt} onChange={setAmt}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 14, width: '100%' }} />
      </div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Destinatario (facolt.)', 'Recipient (optional)')}
        style={{ border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 13, fontWeight: 600, padding: '9px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', width: 160 }} />
      <button className="dk-btn dk-btn--ghost" style={{ height: 38 }} disabled={!(toCents(amt) > 0)} onClick={onAdd}>
        <Icon name="plus" size={15} />{t('Aggiungi', 'Add')}
      </button>
    </div>
  );
}
