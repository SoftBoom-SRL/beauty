import React, { useState } from 'react';
import { api, ApiError, Icon, toDateStr } from '@youty/shared';
import { DkModal } from '../../../ui/index.js';
import ClientPicker from '../ClientPicker.jsx';
import { inputCss, segBtn, pillBtn } from '../formStyles.js';

const PAY_METHODS = [['card', 'Carta', 'Card'], ['cash', 'Contanti', 'Cash'], ['other', 'Altro', 'Other']];

/** now + n calendar months, end of day, as ISO string (for expires_at). */
function monthsFromNowIso(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

/** Sell a new gift card → POST /api/marketing/gift-cards
 * (value, buyer_client_id?, recipient_client_id?, recipient_name, paid+paid_method,
 * delivery_date?, expires_at?). The code is generated server-side (prototype showed a locally
 * generated code — dropped). Expiry presets map to a concrete expires_at datetime. */
export default function GiftCardModal({ onClose, onSaved, t, lang, fireToast }) {
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState(50);
  const [buyer, setBuyer] = useState(null);          // {id, full_name} | null
  const [recipient, setRecipient] = useState(null);  // {id, full_name} | null
  const [recipientName, setRecipientName] = useState('');
  const [paid, setPaid] = useState(true);
  const [paidMethod, setPaidMethod] = useState('card');
  const [scheduled, setScheduled] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [expiryMonths, setExpiryMonths] = useState(0); // 0 = never

  const canSave = value > 0 && (recipient || recipientName.trim());

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const payload = {
        value: Number(value).toFixed(2),
        buyer_client_id: buyer ? buyer.id : null,
        recipient_client_id: recipient ? recipient.id : null,
        recipient_name: recipient ? recipient.full_name : recipientName.trim(),
        paid,
        paid_method: paid ? paidMethod : '',
        delivery_date: scheduled && deliveryDate ? deliveryDate : null,
        expires_at: expiryMonths ? monthsFromNowIso(expiryMonths) : null,
      };
      await api.post('/api/marketing/gift-cards', payload);
      onSaved();
    } catch (err) {
      fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
      setSaving(false);
    }
  };

  return (
    <DkModal open onClose={onClose} title={t('Nuova gift card', 'New gift card')}
      sub={t('Valore prepagato: registra pagamento e consegna', 'Prepaid value: record payment and delivery')} width={540}
      foot={<React.Fragment>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave || saving} onClick={save}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>

      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Valore', 'Value')}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
          <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
          <input type="number" value={value} onChange={(e) => setValue(Math.max(0, Number(e.target.value) || 0))} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 70 }} />
        </div>
        {[25, 50, 75, 100].map((v) => (
          <button key={v} onClick={() => setValue(v)} style={{ ...pillBtn(value === v), fontWeight: 700, padding: '8px 13px' }}>€{v}</button>
        ))}
        <span className="t-sm" style={{ marginLeft: 'auto', color: 'var(--muted-2)' }}>{t('Codice generato al salvataggio', 'Code generated on save')}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Acquirente (chi paga)', 'Buyer (who pays)')}</div>
          <ClientPicker client={buyer} onChange={setBuyer} placeholder={t('Cerca una cliente…', 'Search a client…')} t={t} />
        </div>
        <div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('Destinataria (chi riceve)', 'Recipient (who receives)')}</div>
          {recipient ? (
            <ClientPicker client={recipient} onChange={setRecipient} placeholder="" t={t} />
          ) : (
            <React.Fragment>
              <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder={t('Nome destinataria', 'Recipient name')} style={inputCss} />
              <div style={{ marginTop: 8 }}>
                <ClientPicker client={null} onChange={(c) => { setRecipient(c); setRecipientName(''); }} placeholder={t('…o cerca una cliente', '…or search a client')} t={t} />
              </div>
            </React.Fragment>
          )}
        </div>
      </div>

      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Pagamento', 'Payment')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: paid ? 10 : 16 }}>
        <button style={segBtn(paid)} onClick={() => setPaid(true)}>{t('Pagata ora', 'Paid now')}</button>
        <button style={segBtn(!paid)} onClick={() => setPaid(false)}>{t('Da pagare', 'Payment due')}</button>
      </div>
      {paid && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {PAY_METHODS.map(([k, it_, en_]) => (
            <button key={k} onClick={() => setPaidMethod(k)} style={pillBtn(paidMethod === k)}>{lang === 'en' ? en_ : it_}</button>
          ))}
        </div>
      )}

      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Consegna', 'Delivery')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: scheduled ? 10 : 16 }}>
        <button style={segBtn(!scheduled)} onClick={() => setScheduled(false)}>{t('A mano · stampa QR', 'By hand · print QR')}</button>
        <button style={segBtn(scheduled)} onClick={() => setScheduled(true)}>{t('Programmata', 'Scheduled')}</button>
      </div>
      {scheduled && (
        <input type="date" min={toDateStr(new Date())} value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} style={{ ...inputCss, marginBottom: 16 }} />
      )}

      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Scadenza', 'Expiry')}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        {[[0, t('Mai', 'Never')], [3, t('3 mesi', '3 months')], [6, t('6 mesi', '6 months')], [12, t('12 mesi', '12 months')]].map(([m, l]) => (
          <button key={m} onClick={() => setExpiryMonths(m)} style={pillBtn(expiryMonths === m)}>{l}</button>
        ))}
      </div>
    </DkModal>
  );
}
