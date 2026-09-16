// NewClientModal — scheda anagrafica: creazione (POST /api/clients/) E modifica
// (PUT /api/clients/{id}, payload completo) nello stesso form. Aperto dal
// registro modali ('newclient') con `client` per la modifica. Include genere,
// compleanno con anno facoltativo, origine, "cliente dal", caparra sempre.
// Alla creazione: nota iniziale + consensi; in modifica i consensi restano
// nella scheda Consensi (hanno data di raccolta).
import React, { useState } from 'react';
import { api, ApiError, Icon, Toggle } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import { BirthdayInput, Field, GenderPicker } from '../components.jsx';
import { inputCss, toClientIn } from '../helpers.js';

const ORIGINS = ['Passaparola', 'Instagram', 'Google', 'Facebook', 'TikTok', 'Sito web', 'Passaggio', 'Volantino'];

export default function NewClientModal({ client, onClose, onSaved }) {
  const { t, lang, clientCategories, fireToast, setSelClient, setTab, tab } = useDash();
  const isEdit = !!client?.id;
  const [f, setF] = useState(() => ({
    first: client?.first_name || '', last: client?.last_name || '', phone: client?.phone || '',
    wa: client ? !!client.wa : true, email: client?.email || '',
    gender: client?.gender || '', birthday: client?.birthday || '',
    lang: client?.lang || 'it', origin: client?.origin || '', since: client?.since || '',
    deposit_always: !!client?.deposit_always,
    tags: client ? (client.categories || []).map((x) => x.id) : [],
    note: '', privacy: true, marketing: false, whatsapp: client ? !!client.whatsapp_reminders : true,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const missing = [!f.first.trim() && t('nome', 'first name'), !f.phone.trim() && t('telefono', 'phone')].filter(Boolean);
  const ready = !missing.length && !saving;

  const save = async () => {
    if (missing.length) { setErr(t('Manca: ', 'Missing: ') + missing.join(', ')); return; }
    setSaving(true); setErr('');
    try {
      const common = {
        first_name: f.first.trim(), last_name: f.last.trim(), phone: f.phone.trim(), wa: f.wa,
        email: f.email.trim(), lang: f.lang, category_ids: f.tags,
        gender: f.gender, birthday: f.birthday || null, origin: f.origin.trim(),
        since: f.since || null, deposit_always: f.deposit_always, whatsapp_reminders: f.whatsapp,
      };
      let saved;
      if (isEdit) {
        saved = await api.put(`/api/clients/${client.id}`, toClientIn(client, common));
        fireToast({ msg: t(`Scheda di ${saved.full_name} aggiornata`, `${saved.full_name}'s profile updated`), icon: 'check' });
      } else {
        saved = await api.post('/api/clients/', {
          ...common,
          origin: common.origin || t('Inserimento manuale', 'Manual entry'),
          consents: { privacy: f.privacy, marketing: f.marketing, card_charge: false },
        });
        if (f.note.trim()) {
          try { await api.post(`/api/clients/${saved.id}/notes`, { text: f.note.trim(), visibility: 'private' }); }
          catch { /* il cliente esiste: la nota non deve far fallire il flusso */ }
        }
        fireToast({ msg: t(`Cliente ${saved.full_name} creato`, `Client ${saved.full_name} created`), icon: 'check' });
        setSelClient(saved.id);
        if (tab !== 'clienti') setTab('clienti');
      }
      onSaved?.(saved);
      onClose();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : t('Errore di rete', 'Network error');
      setErr(msg);
    } finally { setSaving(false); }
  };

  const Cons = ({ k, label, sub }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13.5 }}>{label}</div>
        {sub && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5 }}>{sub}</div>}
      </div>
      <Toggle on={f[k]} onChange={(v) => set(k, v)} />
    </div>
  );
  const Section = ({ children }) => <div className="t-meta" style={{ margin: '18px 0 8px', color: 'var(--ink-2)' }}>{children}</div>;

  return (
    <DkModal open onClose={onClose}
      title={isEdit ? t('Modifica cliente', 'Edit client') : t('Nuovo cliente', 'New client')}
      sub={isEdit ? client.full_name : t('Inserimento manuale in anagrafica', 'Manual entry')} width={560}
      foot={<React.Fragment>
        {err && <span style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--danger)' }}><Icon name="alert" size={14} color="var(--danger)" />{err}</span>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" aria-disabled={!ready} onClick={save} title={missing.length ? t('Manca: ', 'Missing: ') + missing.join(', ') : ''}>
          <Icon name="check" size={17} color="#fff" />
          {saving ? t('Salvo…', 'Saving…') : missing.length ? t('Manca ', 'Missing ') + missing.join(' · ') : isEdit ? t('Salva modifiche', 'Save changes') : t('Crea cliente', 'Create client')}
        </button>
      </React.Fragment>}>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={t('Nome', 'First name') + ' *'}><input value={f.first} onChange={(e) => set('first', e.target.value)} style={inputCss} autoFocus={!isEdit} /></Field>
        <Field label={t('Cognome', 'Last name')}><input value={f.last} onChange={(e) => set('last', e.target.value)} style={inputCss} /></Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, marginTop: 12, alignItems: 'end' }}>
        <Field label={t('Telefono', 'Phone') + ' *'}>
          <div style={{ position: 'relative' }}>
            <span style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', display: 'grid', placeItems: 'center' }}><Icon name="phone" size={15} color="var(--muted-2)" /></span>
            <input value={f.phone} inputMode="tel" onChange={(e) => set('phone', e.target.value)} placeholder="+39 …" style={{ ...inputCss, paddingLeft: 34 }} />
          </div>
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42 }}>
          <Icon name="whatsapp" size={16} color="#3F9D58" />
          <span className="t-sm" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>WhatsApp</span>
          <Toggle on={f.wa} onChange={(v) => set('wa', v)} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="nome@email.it" style={inputCss} /></Field>
      </div>

      <Section>{t('Genere', 'Gender')} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted-2)' }}>· {t('molti trattamenti cambiano', 'many treatments differ')}</span></Section>
      <GenderPicker value={f.gender} onChange={(g) => set('gender', g)} t={t} />

      <Section>{t('Compleanno', 'Birthday')}</Section>
      <BirthdayInput value={f.birthday} onChange={(v) => set('birthday', v)} t={t} lang={lang} />

      <Section>{t('Lingua preferita', 'Preferred language')} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted-2)' }}>· {t('comunicazioni WhatsApp automatiche', 'automatic WhatsApp messages')}</span></Section>
      <div style={{ display: 'flex', gap: 6 }}>
        {[['it', 'Italiano'], ['en', 'English']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => set('lang', k)} className={'dk-pill' + (f.lang === k ? ' dk-pill--on' : '')} style={{ padding: '6px 14px' }}>{l}</button>
        ))}
      </div>

      <Section>{t('Etichette', 'Labels')}</Section>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {clientCategories.map((cat) => {
          const on = f.tags.includes(cat.id);
          return (
            <button key={cat.id} type="button" onClick={() => set('tags', on ? f.tags.filter((x) => x !== cat.id) : [...f.tags, cat.id])} className={'dk-pill' + (on ? ' dk-pill--on' : '')} style={{ padding: '5px 11px 5px 9px', fontSize: 12.5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: cat.color, boxShadow: on ? '0 0 0 2px rgba(255,255,255,0.6)' : 'none' }} />{cat.name}{on && <Icon name="check" size={12} stroke={2.6} />}
            </button>
          );
        })}
        {!clientCategories.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessuna etichetta a catalogo.', 'No labels in the catalogue.')}</span>}
      </div>

      <Section>{t('Altro', 'More')}</Section>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label={t('Come ci ha conosciuto', 'How they found us')}>
          <input list="dk-origins" value={f.origin} onChange={(e) => set('origin', e.target.value)} placeholder={t('es. Instagram', 'e.g. Instagram')} style={inputCss} />
          <datalist id="dk-origins">{ORIGINS.map((o) => <option key={o} value={o} />)}</datalist>
        </Field>
        <Field label={t('Cliente dal', 'Client since')}>
          <input type="date" value={f.since || ''} onChange={(e) => set('since', e.target.value)} style={inputCss} />
        </Field>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--warn-tint)' }}>
        <Icon name="coupon" size={16} color="var(--warn)" />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Caparra sempre richiesta', 'Deposit always required')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 11.5 }}>{t('Per chi ha saltato appuntamenti: la caparra scatta a ogni prenotazione.', 'For no-show prone clients: a deposit is required on every booking.')}</div>
        </div>
        <Toggle on={f.deposit_always} onChange={(v) => set('deposit_always', v)} />
      </div>

      {!isEdit && (
        <React.Fragment>
          <Section>{t('Prima nota', 'First note')} <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted-2)' }}>· {t('facoltativa', 'optional')}</span></Section>
          <textarea value={f.note} onChange={(e) => set('note', e.target.value)} rows={2} placeholder={t('es. Allergie, preferenze, come ci ha conosciuto…', 'e.g. Allergies, preferences, how they found us…')} style={{ ...inputCss, resize: 'none', lineHeight: 1.5 }} />

          <Section>{t('Consensi GDPR', 'GDPR consents')}</Section>
          <div style={{ border: '1px solid var(--hair)', borderRadius: 12, padding: '2px 14px', display: 'flex', flexDirection: 'column' }}>
            <Cons k="privacy" label={t('Privacy & trattamento dati', 'Privacy & data')} sub={t("Obbligatorio per l'anagrafica", 'Required for records')} />
            <div style={{ height: 1, background: 'var(--hair)' }} />
            <Cons k="marketing" label={t('Comunicazioni marketing', 'Marketing messages')} />
            <div style={{ height: 1, background: 'var(--hair)' }} />
            <Cons k="whatsapp" label={t('Promemoria WhatsApp', 'WhatsApp reminders')} />
          </div>
          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10 }}>
            {t('I consensi possono arrivare anche da modulo cartaceo e restano modificabili dalla scheda.', 'Consents may come from a paper form and stay editable from the profile.')}
          </div>
        </React.Fragment>
      )}
      {isEdit && (
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 14 }}>
          {t('Consensi e promemoria si gestiscono nella scheda “Consensi”, che ne conserva la data di raccolta.', 'Consents and reminders live in the “Consents” tab, which keeps their collection date.')}
        </div>
      )}
    </DkModal>
  );
}
