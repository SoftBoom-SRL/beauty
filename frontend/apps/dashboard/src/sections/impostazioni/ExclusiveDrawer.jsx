// ExclusiveDrawer.jsx — la «Exclusive Card» (settings.exclusive_card):
// iscrizione annuale a pagamento, rinnovo anticipato a un prezzo più basso
// (l'anno si aggiunge alla scadenza attuale), sconto sui prodotti in cassa
// finché è attiva. Le iscritte sono in Promozioni → Exclusive Card. Solo il
// titolare la modifica.
import { useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import DrawerHead from '../../ui/DrawerHead.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, LockNote } from './lib.jsx';
import { settingsApi } from '../../api/core.js';

const num = (v) => String(v ?? '').replace(/[^0-9.,]/g, '');
const euro = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return n >= 0 ? n.toFixed(2) : null;
};

export default function ExclusiveDrawer({ onClose }) {
  const { t, session, settings, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;
  const conf = settings?.exclusive_card || {};
  const [draft, setDraft] = useState(() => ({
    enabled: !!conf.enabled,
    price: conf.price != null && Number(conf.price) ? String(Number(conf.price)) : '30',
    renewal_price: conf.renewal_price != null && Number(conf.renewal_price) ? String(Number(conf.renewal_price)) : '25',
    product_discount_pct: String(conf.product_discount_pct ?? 10),
  }));
  const [saving, setSaving] = useState(false);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (saving) return;
    const price = euro(draft.price), renewal = euro(draft.renewal_price);
    const pct = Number(draft.product_discount_pct || 0);
    if (!price || !renewal || !(pct >= 0 && pct <= 100)) {
      fireToast({ msg: t('Controlla quote e sconto (da 0 a 100%)', 'Check fees and discount (0 to 100%)'), icon: 'alert' });
      return;
    }
    setSaving(true);
    try {
      await settingsApi.update({ exclusive_card: { enabled: draft.enabled, price, renewal_price: renewal, product_discount_pct: Math.round(pct) } });
      await reload.salon();
      fireToast({ msg: t('Exclusive Card salvata', 'Exclusive Card saved'), icon: 'check' });
      onClose();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { setSaving(false); }
  };

  const field = (label, key, suffix) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
      <span className="t-sm" style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input inputMode="decimal" value={draft[key]} disabled={!isOwner} aria-label={label}
          onChange={(e) => set({ [key]: num(e.target.value) })} style={{ ...inputCss, width: 90 }} />
        <span className="t-sm" style={{ fontWeight: 700, width: 14 }}>{suffix}</span>
      </span>
    </label>
  );

  return (
    <DkDrawer open onClose={onClose}>
      <DrawerHead variant="modal" onClose={onClose} closeLabel={t('Chiudi', 'Close')} title="Exclusive Card"
        sub={t('Iscrizione annuale a pagamento con sconto sui prodotti in cassa', 'Paid yearly membership with a discount on products at the till')} />
      <div className="dk-modalbody" style={{ padding: '0 22px 22px' }}>
        {!isOwner && <div style={{ marginBottom: 14 }}><LockNote t={t} msg={t('Solo il titolare può modificare la Exclusive Card.', 'Only the owner can edit the Exclusive Card.')} /></div>}
        <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" checked={draft.enabled} disabled={!isOwner} onChange={(e) => set({ enabled: e.target.checked })} />
            <span style={{ fontWeight: 700 }}>{t('Attiva', 'Enabled')}</span>
          </label>
          {field(t('Quota di iscrizione (un anno)', 'Enrolment fee (one year)'), 'price', '€')}
          {field(t('Rinnovo prima della scadenza', 'Renewal before expiry'), 'renewal_price', '€')}
          {field(t('Sconto sui prodotti in cassa', 'Discount on products at the till'), 'product_discount_pct', '%')}
          <div className="t-sm" style={{ color: 'var(--muted)' }}>
            {t('Si iscrive o si rinnova dalla scheda cliente (Portafoglio): la quota entra in cassa. Il rinnovo prima della scadenza aggiunge un anno alla scadenza attuale; dopo la scadenza si paga di nuovo la quota piena. Elenco delle iscritte e scadenze in Promozioni → Exclusive Card.',
              'Enrol or renew from the client card (Wallet): the fee goes in the register. Renewing before expiry adds one year to the current expiry; after it, the full fee applies again. Members and expiries in Promotions → Exclusive Card.')}
          </div>
        </div>
        {isOwner && (
          <button className="dk-btn dk-btn--clay" disabled={saving} style={{ width: '100%', opacity: saving ? 0.6 : 1 }} onClick={save}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        )}
      </div>
    </DkDrawer>
  );
}
