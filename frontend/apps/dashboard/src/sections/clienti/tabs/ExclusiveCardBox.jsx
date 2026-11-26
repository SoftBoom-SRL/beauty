// ExclusiveCardBox.jsx — la «Exclusive Card» della cliente nel Portafoglio:
// iscritta fino a quando, e il pulsante per iscriverla o rinnovarla con la
// quota che dice il server (rinnovo anticipato più basso, l'anno si aggiunge
// alla scadenza attuale). La quota entra in cassa come vendita al banco.
// Senza la carta attiva in Impostazioni non compare. La usa anche
// Promozioni → Exclusive Card per iscrivere una cliente scelta lì: `onSubscribed`
// aggiorna l'elenco, `autoOpen` apre subito il pagamento.
import { useState } from 'react';
import { Icon, fmtEurNoFree, toastApiError } from '@youty/shared';
import { useDash } from '../../../ctx.jsx';
import { useResource } from '../../../hooks/useResource.js';
import { exclusiveApi } from '../../../api/marketing.js';
import { payMethods } from '../../pos/lib.js';
import ReceiptToggle from '../../pos/ReceiptToggle.jsx';
import { dateLabel } from '../helpers.js';

export default function ExclusiveCardBox({ clientId, onSubscribed, autoOpen = false }) {
  const { t, lang, settings, hasScope, fireToast } = useDash();
  const conf = settings?.exclusive_card;
  const [rev, setRev] = useState(0);
  const [form, setForm] = useState(autoOpen ? { method: 'card', receipt: true, busy: false } : null);   // { method, receipt, busy } mentre si incassa
  const { data } = useResource(() => exclusiveApi.ofClient(clientId), [clientId, rev], { enabled: !!conf?.enabled, fallback: null });
  if (!conf?.enabled) return null;

  const m = data?.membership;
  const pct = Number(conf.product_discount_pct) || 0;
  const subscribe = async () => {
    setForm((f) => ({ ...f, busy: true }));
    try {
      const res = await exclusiveApi.subscribe(clientId, { method: form.method, receipt_issued: form.receipt });
      fireToast({ msg: t(`Exclusive Card attiva fino al ${dateLabel(res.expires_on, 'it')}`, `Exclusive Card active until ${dateLabel(res.expires_on, 'en')}`), icon: 'check' });
      setForm(null);
      setRev((n) => n + 1);
      onSubscribed?.(res);
    } catch (err) {
      toastApiError(err, fireToast, t);
      setForm((f) => ({ ...f, busy: false }));
    }
  };

  return (
    <div data-exclusive-card="" className="dk-card" style={{ padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)', borderLeft: '3px solid ' + (m?.active ? 'var(--clay)' : 'var(--faint)'), marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: m?.active ? 'var(--clay-tint)' : 'var(--paper-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
          <Icon name="star" size={19} color={m?.active ? 'var(--clay-ink)' : 'var(--muted-2)'} />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Exclusive Card</div>
          <div className="t-sm" style={{ color: m?.active ? 'var(--ok)' : 'var(--muted)', marginTop: 2 }}>
            {data == null ? '…'
              : !m ? t('Non iscritta', 'Not a member')
              : m.active ? t(`Attiva fino al ${dateLabel(m.expires_on, 'it')}`, `Active until ${dateLabel(m.expires_on, 'en')}`) + (pct ? t(` · −${pct}% sui prodotti`, ` · −${pct}% on products`) : '')
              : t(`Scaduta il ${dateLabel(m.expires_on, 'it')}`, `Expired on ${dateLabel(m.expires_on, 'en')}`)}
          </div>
        </div>
        {data && hasScope('sales') && !form && (
          <button className="dk-btn dk-btn--soft" onClick={() => setForm({ method: 'card', receipt: true, busy: false })}>
            <Icon name={m ? 'refresh' : 'plus'} size={15} />
            {(data.renewal ? t('Rinnova', 'Renew') : t('Iscrivi', 'Enrol')) + ' · ' + fmtEurNoFree(data.amount, lang)}
          </button>
        )}
      </div>
      {form && data && (
        <div style={{ borderTop: '1px solid var(--hair)', paddingTop: 12, marginTop: 12 }}>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 8 }}>
            {t(`${data.renewal ? 'Rinnovo anticipato' : 'Iscrizione'}: ${fmtEurNoFree(data.amount, 'it')}, valida fino al ${dateLabel(data.expires_on, 'it')}. Come paga?`,
              `${data.renewal ? 'Early renewal' : 'Enrolment'}: ${fmtEurNoFree(data.amount, 'en')}, valid until ${dateLabel(data.expires_on, 'en')}. How is it paid?`)}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {payMethods(t).filter(([k]) => k !== 'gift_card').map(([k, l]) => (
              <button key={k} type="button" className="dk-pill" aria-pressed={form.method === k} onClick={() => setForm((f) => ({ ...f, method: k }))}
                style={{ padding: '6px 11px', fontSize: 12.5, fontWeight: 700, background: form.method === k ? 'var(--info)' : undefined, borderColor: form.method === k ? 'var(--info)' : undefined, color: form.method === k ? '#fff' : undefined }}>{l}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1 }}><ReceiptToggle value={form.receipt} onChange={(receipt) => setForm((f) => ({ ...f, receipt }))} t={t} /></div>
            <button className="dk-btn dk-btn--ghost" disabled={form.busy} onClick={() => setForm(null)}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--clay" disabled={form.busy} onClick={subscribe}>
              <Icon name="check" size={16} color="#fff" />{t('Incassa', 'Charge')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
