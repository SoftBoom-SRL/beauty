// ConsensiTab.jsx — GDPR consents (consents JSON: privacy / marketing /
// card_charge) + whatsapp_reminders, all persisted via PUT /api/clients/{id}.
import React from 'react';
import { Icon, Toggle } from '@youty/shared';
import { useDash } from '../../../ctx.jsx';

export default function ConsensiTab({ c, updateClient, canWrite }) {
  const { t } = useDash();
  const consents = c.consents || {};

  const setConsent = (key, v) => updateClient(
    { consents: { ...consents, [key]: v } },
    { msg: v ? t('Consenso attivato', 'Consent enabled') : t('Consenso revocato', 'Consent revoked'), icon: v ? 'check' : 'x' },
  );
  const setWa = (v) => updateClient(
    { whatsapp_reminders: v },
    { msg: v ? t('Promemoria WhatsApp attivati', 'WhatsApp reminders enabled') : t('Promemoria WhatsApp disattivati', 'WhatsApp reminders disabled'), icon: 'whatsapp' },
  );

  const Row = ({ label, sub, on, onChange, first }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '15px 14px', borderTop: first ? 'none' : '1px solid var(--hair)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        {sub && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5 }}>{sub}</div>}
      </div>
      <span className="t-sm" style={{ fontWeight: 700, color: on ? 'var(--ok)' : 'var(--muted-2)' }}>{on ? t('Attivo', 'On') : 'Off'}</span>
      {canWrite ? <Toggle on={!!on} onChange={onChange} /> : <span style={{ width: 8 }} />}
    </div>
  );

  return (
    <div style={{ maxWidth: 520 }}>
      <div className="dk-card" style={{ padding: 8, boxShadow: 'none', border: '1px solid var(--hair)' }}>
        <Row first
          label={t('Autorizzazione addebito carta', 'Card charge authorization')}
          sub={t('Addebito no-show e cancellazioni tardive', 'No-show & late-cancel charge')}
          on={consents.card_charge}
          onChange={(v) => setConsent('card_charge', v)} />
        <Row
          label={t('Privacy & trattamento dati', 'Privacy & data')}
          sub={t("Obbligatorio per l'anagrafica", 'Required for records')}
          on={consents.privacy}
          onChange={(v) => setConsent('privacy', v)} />
        <Row
          label={t('Comunicazioni marketing', 'Marketing messages')}
          sub={t('Promozioni e novità', 'Promotions and news')}
          on={consents.marketing}
          onChange={(v) => setConsent('marketing', v)} />
        <Row
          label={t('Promemoria WhatsApp', 'WhatsApp reminders')}
          sub={t('Conferme e promemoria appuntamenti', 'Appointment confirmations and reminders')}
          on={c.whatsapp_reminders}
          onChange={setWa} />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 12 }}>
        <Icon name="edit" size={14} color="var(--muted)" />
        <span className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.45 }}>
          {t('Modificabili a mano: i consensi possono arrivare anche da modulo cartaceo firmato in salone.', 'Editable by hand: consents may also come from a paper form signed in the salon.')}
        </span>
      </div>
    </div>
  );
}
