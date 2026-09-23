import React, { useState } from 'react';
import { api, ApiError, Icon, toDateStr, fmtEur, NumInput } from '@youty/shared';
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
export default function GiftCardModal({ onClose, onSaved, t, lang, fireToast, services = [], canCash = true, canPayLater = true }) {
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState('amount'); // amount | service (trattamento)
  const [value, setValue] = useState(50);
  const [service, setService] = useState(null); // servizio scelto dal catalogo (gift card a trattamento)
  const [svcQ, setSvcQ] = useState('');
  const [svcOpen, setSvcOpen] = useState(false);
  const svcName = (s) => (lang === 'en' && s.name_en ? s.name_en : s.name_it);
  const activeServices = (services || []).filter((s) => s.active !== false);
  const svcResults = svcQ.trim()
    ? activeServices.filter((s) => svcName(s).toLowerCase().includes(svcQ.trim().toLowerCase()))
    : activeServices.slice(0, 8);
  const [buyer, setBuyer] = useState(null);          // {id, full_name} | null
  const [recipient, setRecipient] = useState(null);  // {id, full_name} | null
  const [recipientName, setRecipientName] = useState('');
  const [byName, setByName] = useState(false);   // destinataria come testo libero, senza scheda cliente
  // «Pagata ora» è un incasso (vendita e pagamento): lo registra chi ha
  // `sales`; una carta «Da pagare» la crea chi ha `marketing` (07-04).
  const [paid, setPaid] = useState(canCash);
  const [paidMethod, setPaidMethod] = useState('card');
  const [scheduled, setScheduled] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState('');
  const [expiryMonths, setExpiryMonths] = useState(0); // 0 = never

  const canSave = (type === 'service' ? !!service : value > 0) && (byName ? recipientName.trim() : !!recipient)
    && (paid ? canCash : canPayLater);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const payload = {
        value: (type === 'service' ? Number(service.price) : Number(value)).toFixed(2),
        ...(type === 'service' ? { gift_service_id: service.id } : {}),
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

      {/* tipo: importo monetario oppure trattamento (servizio dal catalogo esistente) */}
      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Tipo di gift card', 'Gift card type')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button style={segBtn(type === 'amount')} onClick={() => setType('amount')}>{t('Importo', 'Amount')}</button>
        <button style={segBtn(type === 'service')} onClick={() => setType('service')}>{t('Trattamento', 'Treatment')}</button>
      </div>

      {type === 'amount' ? (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Valore', 'Value')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 12px', height: 42, background: 'var(--surface)' }}>
              <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
              <NumInput min={0} value={value} onChange={setValue} style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, width: 70 }} />
            </div>
            {[25, 50, 75, 100].map((v) => (
              <button key={v} onClick={() => setValue(v)} style={{ ...pillBtn(value === v), fontWeight: 700, padding: '8px 13px' }}>€{v}</button>
            ))}
            <span className="t-sm" style={{ marginLeft: 'auto', color: 'var(--muted-2)' }}>{t('Codice generato al salvataggio', 'Code generated on save')}</span>
          </div>
        </React.Fragment>
      ) : (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Trattamento in regalo', 'Gifted treatment')}</div>
          {service ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--hair)', borderRadius: 10, padding: '10px 12px', background: 'var(--surface)', marginBottom: 16 }}>
              <Icon name="gift" size={16} color="var(--clay-ink)" />
              <span style={{ flex: 1, fontWeight: 700, fontSize: 14 }}>{svcName(service)}</span>
              <span className="t-num" style={{ fontWeight: 700 }}>{fmtEur(Number(service.price), lang)}</span>
              <button onClick={() => setService(null)} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>
            </div>
          ) : (
            <div style={{ position: 'relative', marginBottom: 16 }}>
              <div className="dk-search" style={{ width: '100%' }}>
                <Icon name="search" size={16} color="var(--muted-2)" />
                <input value={svcQ} onChange={(e) => { setSvcQ(e.target.value); setSvcOpen(true); }} onFocus={() => setSvcOpen(true)} placeholder={t('Cerca un servizio dal catalogo…', 'Search a service from the catalogue…')} />
              </div>
              {svcOpen && (
                <React.Fragment>
                  <div onClick={() => setSvcOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
                  <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, padding: 6, zIndex: 61, maxHeight: 260, overflowY: 'auto', boxShadow: 'var(--sh-pop)' }}>
                    {svcResults.length ? svcResults.map((s) => (
                      <button key={s.id} className="dk-row" onClick={() => { setService(s); setSvcOpen(false); setSvcQ(''); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 9, textAlign: 'left' }}>
                        <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{svcName(s)}</span>
                        <span className="t-num" style={{ fontSize: 13, color: 'var(--muted)' }}>{fmtEur(Number(s.price), lang)}</span>
                      </button>
                    )) : <div className="t-sm" style={{ padding: 10, color: 'var(--muted)' }}>{t('Nessun servizio', 'No services')}</div>}
                  </div>
                </React.Fragment>
              )}
              <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>{t('Il valore della card sarà il prezzo del servizio scelto.', 'The card value will be the chosen service price.')}</div>
            </div>
          )}
        </React.Fragment>
      )}

      {/* Acquirente e destinataria su righe separate: i due ClientPicker aprono un
        * menu assoluto e affiancati in una griglia si sovrapponevano, con le
        * colonne di altezza diversa. */}
      <div style={{ marginBottom: 14 }}>
        <div className="t-meta" style={{ marginBottom: 6 }}>{t('Acquirente (chi paga)', 'Buyer (who pays)')}</div>
        <ClientPicker client={buyer} onChange={setBuyer} placeholder={t('Cerca una cliente…', 'Search a client…')} t={t} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="t-meta" style={{ marginBottom: 6 }}>{t('Destinataria (chi riceve il credito)', 'Recipient (who gets the credit)')}</div>
        {/* Il credito segue la SCHEDA cliente: solo così la destinataria lo vede
          * nella sua app e compare in agenda quando prenota quel trattamento.
          * Il nome scritto a mano resta possibile (regalo da consegnare), ma va
          * detto che in quel caso vale solo il codice sulla card. */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button style={segBtn(!byName)} onClick={() => { setByName(false); setRecipientName(''); }}>{t('Una cliente', 'A client')}</button>
          <button style={segBtn(byName)} onClick={() => { setByName(true); setRecipient(null); }}>{t('Solo un nome', 'Just a name')}</button>
        </div>
        {byName ? (
          <React.Fragment>
            <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder={t('Nome di chi riceve', 'Name of the recipient')} style={inputCss} />
            <div style={{ display: 'flex', gap: 9, marginTop: 8, padding: '10px 12px', borderRadius: 10, background: 'var(--warn-tint)' }}>
              <Icon name="alert" size={15} color="var(--warn)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div className="t-sm" style={{ color: 'var(--ink-2)', lineHeight: 1.45 }}>
                {t('Senza scheda cliente il credito non comparirà in nessuna app: vale il codice stampato sulla card, da usare in salone. Collega una cliente per farglielo trovare nel suo portafoglio e in agenda.',
                   'Without a client profile the credit shows in no app: only the printed code counts, to be used in the salon. Link a client so she finds it in her wallet and in the agenda.')}
              </div>
            </div>
          </React.Fragment>
        ) : (
          <React.Fragment>
            <ClientPicker client={recipient} onChange={setRecipient} placeholder={t('Cerca o crea la cliente…', 'Search or create the client…')} t={t} />
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 6 }}>
              {t('Vedrà il credito nel suo portafoglio; se è un trattamento, comparirà accanto al servizio quando prenota.', 'She will see the credit in her wallet; if it is a treatment, it shows next to the service when she books.')}
            </div>
          </React.Fragment>
        )}
      </div>

      <div className="t-meta" style={{ marginBottom: 8 }}>{t('Pagamento', 'Payment')}</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: paid ? 10 : 16 }}>
        <button style={{ ...segBtn(paid), opacity: canCash ? 1 : 0.5, cursor: canCash ? 'pointer' : 'not-allowed' }} disabled={!canCash} onClick={() => setPaid(true)}
          title={canCash ? undefined : t('Serve il permesso "vendite" per incassare', 'The "sales" permission is required to take payment')}>{t('Pagata ora', 'Paid now')}</button>
        <button style={{ ...segBtn(!paid), opacity: canPayLater ? 1 : 0.5, cursor: canPayLater ? 'pointer' : 'not-allowed' }} disabled={!canPayLater} onClick={() => setPaid(false)}
          title={canPayLater ? undefined : t('Serve il permesso "marketing" per una carta da pagare dopo', 'The "marketing" permission is required for a card paid later')}>{t('Da pagare', 'Payment due')}</button>
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
