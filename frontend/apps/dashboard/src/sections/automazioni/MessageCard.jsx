// MessageCard.jsx — il messaggio WhatsApp che l'automazione invia (YR-1391).
// Si sceglie uno dei modelli approvati su Yourang e, per ogni suo valore
// ({{1}}, {{2}}…), il campo di youty che lo riempie. Prima qui c'era un testo
// d'esempio e «Testo e variabili si modificano su Yourang», ma su Yourang non
// c'era niente da modificare: nessun salone riusciva a far partire un modello.
import React from 'react';
import { Icon } from '@youty/shared';
import { inputCss } from '../impostazioni/lib.jsx';
import { defaultTemplateFields, renderTemplate, templateKey } from './catalog.js';

const selectCss = { ...inputCss, width: '100%', fontWeight: 600, cursor: 'pointer' };

function Note({ icon = 'info', children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '11px 13px', borderRadius: 10, border: '1px dashed var(--line-strong)', color: 'var(--muted)', fontSize: 13, fontWeight: 500, lineHeight: 1.45 }}>
      <Icon name={icon} size={15} color="var(--muted)" /><span>{children}</span>
    </div>
  );
}

/**
 * wa: risposta di GET /whatsapp-templates (null = in caricamento).
 * value: { template_name, template_language, template_parameters }.
 */
export default function MessageCard({ wa, event, value, onChange, canWrite, t, lang }) {
  const states = {
    not_connected: t('Collega il salone a Yourang (Impostazioni → Integrazioni) per inviare i messaggi WhatsApp.', 'Connect the salon to Yourang (Settings → Integrations) to send WhatsApp messages.'),
    needs_reconnect: t('Ricollega Yourang da Impostazioni → Integrazioni: serve il permesso di inviare i messaggi WhatsApp.', 'Reconnect Yourang from Settings → Integrations: it needs permission to send WhatsApp messages.'),
    unavailable: t('L’invio dei messaggi WhatsApp non è ancora attivo su youty.', 'Sending WhatsApp messages is not enabled on youty yet.'),
    yourang_error: t('Yourang non risponde: i modelli non si possono leggere ora. Riprova tra poco.', 'Yourang is not answering: templates cannot be read right now. Try again shortly.'),
  };
  const field = (key) => (wa?.fields || []).find((f) => f.value === key);
  const fieldLabel = (key) => { const f = field(key); return f ? (lang === 'en' ? f.label_en : f.label_it) : key; };

  let body;
  if (!wa) {
    body = <Note icon="refresh">{t('Caricamento dei modelli…', 'Loading templates…')}</Note>;
  } else if (wa.state !== 'ok') {
    body = <Note icon="alert">{states[wa.state] || states.yourang_error}</Note>;
  } else if (!wa.events.includes(event)) {
    body = <Note>{t('Per questo evento l’invio WhatsApp non c’è ancora: scegli Appuntamento creato, Appuntamento in arrivo o Visita completata.', 'WhatsApp sending is not available for this event yet: pick Appointment created, Upcoming appointment or Visit completed.')}</Note>;
  } else {
    const current = templateKey(value.template_name, value.template_language);
    const template = wa.templates.find((tpl) => templateKey(tpl.name, tpl.language) === current);
    const pick = (key) => {
      const tpl = wa.templates.find((x) => templateKey(x.name, x.language) === key);
      onChange(tpl
        ? { template_name: tpl.name, template_language: tpl.language, template_parameters: defaultTemplateFields(tpl.parameters) }
        : { template_name: '', template_language: '', template_parameters: [] });
    };
    const setField = (i, key) => {
      const next = [...value.template_parameters];
      next[i] = key;
      onChange({ ...value, template_parameters: next });
    };
    body = (
      <React.Fragment>
        <div className="t-meta" style={{ marginBottom: 7 }}>{t('Modello WhatsApp', 'WhatsApp template')}</div>
        <select aria-label={t('Modello WhatsApp', 'WhatsApp template')} value={current} disabled={!canWrite} onChange={(e) => pick(e.target.value)} style={selectCss}>
          <option value="">{t('Nessun messaggio', 'No message')}</option>
          {current && !template && <option value={current}>{value.template_name} · {value.template_language} ({t('non più approvato', 'no longer approved')})</option>}
          {wa.templates.map((tpl) => (
            <option key={templateKey(tpl.name, tpl.language)} value={templateKey(tpl.name, tpl.language)}>{tpl.name} · {tpl.language}</option>
          ))}
        </select>
        {!wa.templates.length && (
          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{t('Nessun modello approvato: crealo su Yourang (WhatsApp → Modelli) e attendi l’approvazione di Meta.', 'No approved template: create one on Yourang (WhatsApp → Templates) and wait for Meta’s approval.')}</div>
        )}
        {template && template.parameters.length > 0 && (
          <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
            <div className="t-meta">{t('Valori del messaggio', 'Message values')}</div>
            {template.parameters.map((p, i) => (
              <div key={p.key} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center' }}>
                <span className="t-sm" style={{ fontWeight: 700, color: 'var(--ink-2)' }}>
                  {p.key.startsWith('body:') ? `{{${p.key.slice(5)}}}` : t('Link pulsante', 'Button link')}
                  {p.label ? <span style={{ color: 'var(--muted)', fontWeight: 500 }}> · {p.label}</span> : null}
                </span>
                <select aria-label={`${t('Valore', 'Value')} ${i + 1}`} value={value.template_parameters[i] || ''} disabled={!canWrite} onChange={(e) => setField(i, e.target.value)} style={selectCss}>
                  {wa.fields.map((f) => <option key={f.value} value={f.value}>{fieldLabel(f.value)}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        {template && (
          <div style={{ marginTop: 14 }}>
            <div className="t-meta" style={{ marginBottom: 8 }}>{t('Anteprima messaggio', 'Message preview')}</div>
            <div style={{ background: 'var(--paper-2)', borderRadius: '4px 12px 12px 12px', padding: '9px 12px', fontSize: 13, lineHeight: 1.5, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>
              {renderTemplate(template, value.template_parameters)}
            </div>
          </div>
        )}
      </React.Fragment>
    );
  }

  return (
    <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)', background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
        <div style={{ width: 32, height: 32, borderRadius: 9, background: 'color-mix(in srgb, #3F9D58 14%, transparent)', display: 'grid', placeItems: 'center' }}><Icon name="whatsapp" size={17} color="#3F9D58" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{t('Messaggio WhatsApp', 'WhatsApp message')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)' }}>{t('Parte dal numero WhatsApp collegato a Yourang, con un modello approvato da Meta.', 'Sent from the WhatsApp number connected to Yourang, with a template approved by Meta.')}</div>
        </div>
      </div>
      {body}
    </div>
  );
}
