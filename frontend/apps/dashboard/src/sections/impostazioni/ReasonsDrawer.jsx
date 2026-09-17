// ReasonsDrawer.jsx — motivazioni personalizzate di annullamento e no-show
// (settings.cancel_reasons / no_show_reasons). Liste vuote = quelle
// predefinite della dashboard. Il dettaglio appuntamento le usa nel picker.
import React, { useState } from 'react';
import { api, ApiError, Icon } from '@youty/shared';
import DkDrawer from '../../ui/DkDrawer.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, toastErr, LockNote } from './lib.jsx';

const DEFAULT_CANCEL = ['Richiesta cliente', 'Malattia', 'Sovrapposizione', 'Altro'];
const DEFAULT_NOSHOW = ['Mancata presenza', 'Malattia / imprevisto', 'Altro'];

function ReasonList({ title, sub, value, onChange, defaults, t, ro }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || value.includes(v)) { setDraft(''); return; }
    onChange([...value, v].slice(0, 30));
    setDraft('');
  };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const list = value.length ? value : defaults;
  const usingDefaults = !value.length;
  return (
    <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 18 }}>
      <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3, marginBottom: 12 }}>{sub}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.map((r, i) => (
          <div key={r + i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', opacity: usingDefaults ? 0.75 : 1 }}>
            <Icon name="tag" size={13} color="var(--muted-2)" />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{r}</span>
            {!usingDefaults && !ro && (
              <React.Fragment>
                <button className="dk-iconbtn" onClick={() => move(i, -1)} disabled={i === 0} style={{ width: 26, height: 26, borderRadius: 7 }} aria-label={t('Su', 'Up')}><Icon name="chevD" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
                <button className="dk-iconbtn" onClick={() => move(i, 1)} disabled={i === list.length - 1} style={{ width: 26, height: 26, borderRadius: 7 }} aria-label={t('Giù', 'Down')}><Icon name="chevD" size={13} /></button>
                <button className="dk-iconbtn" onClick={() => onChange(value.filter((_, j) => j !== i))} style={{ width: 26, height: 26, borderRadius: 7 }} aria-label={t('Rimuovi', 'Remove')}><Icon name="x" size={13} /></button>
              </React.Fragment>
            )}
          </div>
        ))}
      </div>
      {usingDefaults && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{t('Motivazioni predefinite. Aggiungine una per personalizzare l’elenco (le predefinite spariscono).', 'Default reasons. Add one to customise the list (defaults disappear).')}</div>}
      {!ro && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value.slice(0, 80))} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder={t('Nuova motivazione…', 'New reason…')} style={{ ...inputCss, flex: 1 }} />
          <button className="dk-btn dk-btn--soft" onClick={add} disabled={!draft.trim()}><Icon name="plus" size={15} />{t('Aggiungi', 'Add')}</button>
          {!usingDefaults && <button className="dk-btn dk-btn--ghost" onClick={() => onChange(defaults)} title={t('Riparti dalle predefinite (modificabili)', 'Start again from the defaults (editable)')}>{t('Predefinite', 'Defaults')}</button>}
        </div>
      )}
    </div>
  );
}

export default function ReasonsDrawer({ onClose }) {
  const { t, session, settings, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;
  const [cancel, setCancel] = useState(settings?.cancel_reasons || []);
  const [noShow, setNoShow] = useState(settings?.no_show_reasons || []);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.put('/api/core/settings', { cancel_reasons: cancel, no_show_reasons: noShow });
      await reload.salon();
      fireToast({ msg: t('Motivazioni salvate', 'Reasons saved'), icon: 'check' });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) fireToast({ msg: err.message, icon: 'alert' }); else toastErr(err, fireToast, t);
    } finally { setSaving(false); }
  };

  return (
    <DkDrawer open onClose={onClose}>
      <div className="dk-modalhead">
        <div style={{ flex: 1 }}>
          <div className="t-title" style={{ fontSize: 20 }}>{t('Motivazioni', 'Reasons')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 3 }}>{t('Le opzioni proposte quando annulli un appuntamento o segni un no-show', 'The options offered when you cancel an appointment or mark a no-show')}</div>
        </div>
        <button className="dk-iconbtn" onClick={onClose} aria-label={t('Chiudi', 'Close')} style={{ width: 36, height: 36 }}><Icon name="x" size={17} /></button>
      </div>
      <div className="dk-modalbody" style={{ padding: '0 22px 22px' }}>
        {!isOwner && <div style={{ marginBottom: 14 }}><LockNote t={t} msg={t('Solo il titolare può modificare le motivazioni.', 'Only the owner can edit the reasons.')} /></div>}
        <ReasonList t={t} ro={!isOwner} title={t('Annullamento', 'Cancellation')} sub={t('Perché un appuntamento viene cancellato (statistiche e registro attività).', 'Why an appointment is cancelled (statistics and activity log).')} value={cancel} onChange={setCancel} defaults={DEFAULT_CANCEL} />
        <ReasonList t={t} ro={!isOwner} title={t('No-show', 'No-show')} sub={t('Perché una cliente non si è presentata.', 'Why a client did not show up.')} value={noShow} onChange={setNoShow} defaults={DEFAULT_NOSHOW} />
        {isOwner && (
          <button className="dk-btn dk-btn--clay" disabled={saving} style={{ width: '100%', opacity: saving ? 0.6 : 1 }} onClick={save}>
            <Icon name="check" size={17} color="#fff" />{saving ? t('Salvataggio…', 'Saving…') : t('Salva', 'Save')}
          </button>
        )}
      </div>
    </DkDrawer>
  );
}
