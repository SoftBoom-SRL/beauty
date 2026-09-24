// sell/GiftCardForm.jsx — importo e destinatario di una gift card da vendere
// nel blocco di un'operatrice del check-out (SellModal).
import { Icon, NumInput } from '@youty/shared';
import { inputCss, toCents } from '../lib.js';

/* `form`: { opId, amt, name }; `setForm` accetta una funzione, come lo stato. */
export default function GiftCardForm({ form, setForm, onAdd, onCancel, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid var(--hair)', borderRadius: 9, padding: '7px 9px', background: 'var(--surface)', width: 84, boxSizing: 'border-box' }}>
        <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
        <NumInput autoFocus min={1} value={form.amt}
          onChange={(amt) => setForm((g) => ({ ...g, amt }))}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5, width: '100%' }} />
      </div>
      <input value={form.name} onChange={(e) => setForm((g) => ({ ...g, name: e.target.value }))}
        placeholder={t('Destinatario (facolt.)', 'Recipient (optional)')} style={{ ...inputCss, flex: 1, minWidth: 120 }} />
      <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 11px' }} disabled={!(toCents(form.amt) > 0)} onClick={onAdd}>
        <Icon name="plus" size={13} />{t('Aggiungi', 'Add')}
      </button>
      <button className="dk-iconbtn" style={{ width: 30, height: 30 }} onClick={onCancel}><Icon name="x" size={14} /></button>
    </div>
  );
}
