// NewClientModal — scheda anagrafica: creazione (POST /api/clients/) E modifica
// (PUT /api/clients/{id} con i soli campi cambiati, C15) nello stesso form.
// Aperto dal registro modali ('newclient') con `client` per la modifica.
// Include genere, compleanno con anno facoltativo, origine, "cliente dal",
// caparra sempre. Alla creazione: nota iniziale + consensi; in modifica i
// consensi restano nella scheda Consensi (il server ne registra la data).
import React, { useState } from 'react';
import { ApiError, Icon, PhoneInput, Toggle, isPlausiblePhone, apiErrorText } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import { BirthdayInput, Field, GenderPicker } from '../components.jsx';
import { inputCss, clientChanges } from '../helpers.js';
import { clientNotesApi, clientsApi } from '../../../api/clients.js';

const ORIGINS = ['Passaparola', 'Instagram', 'Google', 'Facebook', 'TikTok', 'Sito web', 'Passaggio', 'Volantino'];

/* Definiti FUORI dal componente: ricreati a ogni render sarebbero un tipo di
 * componente nuovo ogni volta, React smonterebbe e rimonterebbe il sottoalbero
 * a ogni battuta di tasto e il fuoco sul toggle dei consensi se ne andrebbe. */
const Section = ({ children }) => <div className="t-meta" style={{ margin: '18px 0 8px', color: 'var(--ink-2)' }}>{children}</div>;
const Cons = ({ label, sub, on, onChange }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 0' }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600, fontSize: 13.5 }}>{label}</div>
      {sub && <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11.5 }}>{sub}</div>}
    </div>
    <Toggle on={on} onChange={onChange} />
  </div>
);

/** `afterSave`:
 *  - 'profile' (predefinito): finito, si apre la scheda in anagrafica;
 *  - 'book': si torna alla prenotazione con la cliente appena creata già
 *    scelta. Chi apre «Nuova → Nuovo cliente» sta quasi sempre prendendo un
 *    appuntamento al telefono: mandarlo in anagrafica gli faceva perdere il
 *    filo, e l'appuntamento non veniva più creato. */
export default function NewClientModal({ client, onClose, onSaved, afterSave = 'profile' }) {
  const { t, lang, clientCategories, fireToast, setSelClient, setTab, tab, openModal, agendaDate } = useDash();
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
  // scheda archiviata che ha già questo numero (POST → 409): si riattiva quella
  const [archived, setArchived] = useState(null);   // { id, name }
  const set = (k, v) => { setF((o) => ({ ...o, [k]: v })); if (k === 'phone') setArchived(null); };
  const missing = [!f.first.trim() && t('nome', 'first name'), !f.phone.trim() && t('telefono', 'phone')].filter(Boolean);
  // Stessa regola del server e dell'app cliente: «333» si salvava come
  // «+39333», una scheda con un numero che non esiste (14-19). In modifica
  // conta solo se il numero è stato toccato: un numero vecchio non blocca la
  // correzione del cognome.
  const phoneTouched = !isEdit || f.phone.trim() !== (client.phone || '');
  const phoneBad = !!f.phone.trim() && phoneTouched && !isPlausiblePhone(f.phone);
  const phoneBadMsg = t('Numero non valido: controlla prefisso e cifre', 'Invalid number: check the prefix and digits');
  const ready = !missing.length && !phoneBad && !saving;

  /* Dopo una creazione (o la riattivazione della scheda archiviata con quel
   * numero): o si apre la scheda, o si torna alla prenotazione con lei scelta. */
  const afterCreate = async (saved) => {
    if (f.note.trim()) {
      try { await clientNotesApi.create(saved.id, { text: f.note.trim(), visibility: 'private' }); }
      catch { /* il cliente esiste: la nota non deve far fallire il flusso */ }
    }
    if (afterSave !== 'book') {
      setSelClient(saved.id);
      if (tab !== 'clienti') setTab('clienti');
    }
    onSaved?.(saved);
    onClose();
    // L'apertura va DOPO la chiusura: i due aggiornamenti finiscono nello
    // stesso giro e l'ultimo vince, altrimenti il drawer si chiuderebbe da solo.
    // Il giorno è quello che l'agenda sta mostrando, come «Prenota» della barra
    // in alto: si apriva sempre su oggi (13-16).
    if (afterSave === 'book') {
      openModal('newappt', { prefill: { clientId: saved.id, clientName: saved.full_name, ...(agendaDate ? { date: agendaDate } : {}) } });
    }
  };

  /* Cliente archiviata che richiama: la creazione risponde 409 con la sua
   * scheda (06-02) e la si riattiva così com'è (PUT {is_active: true}); prima
   * era un vicolo cieco, «Telefono già registrato» senza dire da chi. */
  const reactivate = async () => {
    if (saving || !archived) return;
    setSaving(true); setErr('');
    try {
      const saved = await clientsApi.reactivate(archived.id);
      fireToast({ msg: t(`Scheda di ${saved.full_name} riattivata`, `${saved.full_name}'s profile reactivated`), icon: 'check' });
      await afterCreate(saved);
    } catch (e) {
      setErr(apiErrorText(e, t));
    } finally { setSaving(false); }
  };

  const save = async () => {
    if (saving) return;   // il doppio clic creava due schede: aria-disabled non blocca il click
    if (missing.length) { setErr(t('Manca: ', 'Missing: ') + missing.join(', ')); return; }
    if (phoneBad) { setErr(phoneBadMsg); return; }
    setSaving(true); setErr(''); setArchived(null);
    try {
      const common = {
        first_name: f.first.trim(), last_name: f.last.trim(), phone: f.phone.trim(), wa: f.wa,
        email: f.email.trim(), lang: f.lang, category_ids: f.tags,
        gender: f.gender, birthday: f.birthday || null, origin: f.origin.trim(),
        since: f.since || null, deposit_always: f.deposit_always, whatsapp_reminders: f.whatsapp,
      };
      let saved;
      if (isEdit) {
        // Solo ciò che l'operatrice ha cambiato rispetto alla scheda aperta:
        // lingua, email o promemoria cambiati nel frattempo dall'app non
        // tornano indietro per un nome corretto qui (06-10, C15).
        const changes = clientChanges(client, common);
        if (!Object.keys(changes).length) {
          fireToast({ msg: t('Nessuna modifica da salvare', 'No changes to save'), icon: 'check' });
          onClose();
          return;
        }
        saved = await clientsApi.update(client.id, changes);
        fireToast({ msg: t(`Scheda di ${saved.full_name} aggiornata`, `${saved.full_name}'s profile updated`), icon: 'check' });
        onSaved?.(saved);
        onClose();
      } else {
        saved = await clientsApi.create({
          ...common,
          origin: common.origin || t('Inserimento manuale', 'Manual entry'),
          consents: { privacy: f.privacy, marketing: f.marketing, card_charge: false },
        });
        fireToast({ msg: t(`Cliente ${saved.full_name} creato`, `Client ${saved.full_name} created`), icon: 'check' });
        await afterCreate(saved);
      }
    } catch (e) {
      if (!isEdit && e instanceof ApiError && e.status === 409 && e.data?.archived_client_id) {
        setArchived({ id: e.data.archived_client_id, name: e.data.archived_client_name || '' });
      }
      const msg = apiErrorText(e, t);
      setErr(msg);
    } finally { setSaving(false); }
  };

  return (
    <DkModal open onClose={onClose}
      title={isEdit ? t('Modifica cliente', 'Edit client') : t('Nuovo cliente', 'New client')}
      sub={isEdit ? client.full_name : t('Inserimento manuale in anagrafica', 'Manual entry')} width={560}
      foot={<React.Fragment>
        {err && <span style={{ marginRight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: 'var(--danger)' }}><Icon name="alert" size={14} color="var(--danger)" />{err}</span>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" aria-disabled={!ready} onClick={save} title={missing.length ? t('Manca: ', 'Missing: ') + missing.join(', ') : phoneBad ? phoneBadMsg : ''}>
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
          <PhoneInput value={f.phone} onChange={(v) => set('phone', v)} lang={lang} ariaLabel={t('Telefono', 'Phone')} />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 42 }}>
          <Icon name="whatsapp" size={16} color="#3F9D58" />
          <span className="t-sm" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>WhatsApp</span>
          <Toggle on={f.wa} onChange={(v) => set('wa', v)} />
        </div>
      </div>
      {phoneBad && <div className="t-sm" style={{ color: 'var(--danger)', fontWeight: 600, marginTop: 6 }}>{phoneBadMsg}</div>}
      {archived && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--warn-tint)' }}>
          <Icon name="alert" size={16} color="var(--warn)" />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>
            {t(`Il numero è di una scheda archiviata${archived.name ? `: ${archived.name}` : ''}. Riattivala invece di crearne un’altra: storico e punti restano i suoi.`, `This number belongs to an archived profile${archived.name ? `: ${archived.name}` : ''}. Reactivate it instead of creating another: history and points stay with it.`)}
          </span>
          <button type="button" className="dk-btn dk-btn--clay" style={{ height: 32, fontSize: 12.5, flexShrink: 0 }} aria-disabled={saving} onClick={reactivate}>
            <Icon name="refresh" size={14} color="#fff" />{t('Riattiva', 'Reactivate')}
          </button>
        </div>
      )}
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
            <Cons label={t('Privacy & trattamento dati', 'Privacy & data')} sub={t("Obbligatorio per l'anagrafica", 'Required for records')} on={f.privacy} onChange={(v) => set('privacy', v)} />
            <div style={{ height: 1, background: 'var(--hair)' }} />
            <Cons label={t('Comunicazioni marketing', 'Marketing messages')} on={f.marketing} onChange={(v) => set('marketing', v)} />
            <div style={{ height: 1, background: 'var(--hair)' }} />
            <Cons label={t('Promemoria WhatsApp', 'WhatsApp reminders')} on={f.whatsapp} onChange={(v) => set('whatsapp', v)} />
          </div>
          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 10 }}>
            {t('I consensi possono arrivare anche da modulo cartaceo e restano modificabili dalla scheda.', 'Consents may come from a paper form and stay editable from the profile.')}
          </div>
        </React.Fragment>
      )}
      {isEdit && (
        <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 14 }}>
          {t('Consensi e promemoria si gestiscono nella scheda “Consensi”: lì c’è anche la data in cui ogni consenso è stato dato o revocato, quando è registrata.', 'Consents and reminders live in the “Consents” tab, which also shows when each consent was given or revoked, when that date is on file.')}
        </div>
      )}
    </DkModal>
  );
}
