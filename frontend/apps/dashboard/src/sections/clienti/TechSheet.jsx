// TechSheet.jsx — technical sheet card (read-only: sheets are IMMUTABLE on the
// API, no update/delete route) and creation form. Shared by the profile tab
// and the registry TechSheetModal. Prototype TECH_FIELDS mapped onto the
// API's flat TechnicalSheet columns (see helpers.js).
import React, { useEffect, useRef, useState } from 'react';
import { ApiError, Avatar, Icon, mediaUrl, nameIn, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { TECH_FIELDS, dateTimeLabel, initialsOf, inputCss, sheetVal } from './helpers.js';
import { techSheetsApi } from '../../api/clients.js';

export function TechSheetCard({ sheet: initial, defaultOpen }) {
  const { t, lang, hasScope, fireToast } = useDash();
  const [sheet, setSheet] = useState(initial);
  const [open, setOpen] = useState(!!defaultOpen);
  const fileRef = useRef(null);
  const fields = TECH_FIELDS(t);
  const canWrite = hasScope('clients');
  const uploadPhoto = async (file) => {
    if (!file) return;
    try {
      const updated = await techSheetsApi.uploadPhoto(sheet.client_id, sheet.id, file);
      setSheet(updated);
      fireToast({ msg: t('Foto salvata nella scheda', 'Photo saved to the sheet'), icon: 'check' });
    } catch (err) { toastApiError(err, fireToast, t); }
  };
  return (
    <div className="dk-card" style={{ padding: 0, boxShadow: 'none', border: '1px solid var(--hair)', overflow: 'hidden' }}>
      <button className="dk-row" onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 18px', width: '100%', textAlign: 'left', background: 'transparent', cursor: 'pointer', border: 'none' }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="edit" size={16} color="var(--clay-ink)" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{sheet.treatment || t('Trattamento', 'Treatment')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            {sheet.author_name && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Avatar initials={initialsOf(sheet.author_name)} size={17} />{sheet.author_name}</span>}
            <span>· {dateTimeLabel(sheet.created_at, lang)}</span>
            {sheet.category && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 7px', borderRadius: 99 }}>{sheet.category}</span>}
          </div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, color: 'var(--muted-2)', flexShrink: 0 }}><Icon name="lock" size={12} color="var(--muted-2)" />{t('Sola lettura', 'Read-only')}</span>
        <Icon name="chevD" size={15} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
      </button>
      {open && (
        <div style={{ padding: '4px 18px 18px', borderTop: '1px solid var(--hair)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px', paddingTop: 14 }}>
            {fields.map((f) => {
              const val = sheetVal(sheet, f.k);
              return (
                <div key={f.k} style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : 'auto' }}>
                  <div className="t-meta" style={{ marginBottom: 4 }}>{f.label}</div>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: val ? 'var(--ink-2)' : 'var(--muted-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{val || '—'}</div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'flex-end', gap: 12 }}>
            {sheet.photo && (
              <div>
                <div className="t-meta" style={{ marginBottom: 8 }}>{t('Foto', 'Photo')}</div>
                <a href={mediaUrl(sheet.photo)} target="_blank" rel="noreferrer"><img src={mediaUrl(sheet.photo)} alt="" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--hair)', display: 'block' }} /></a>
              </div>
            )}
            {canWrite && (
              <React.Fragment>
                <input ref={fileRef} type="file" accept="image/*" onChange={(e) => { uploadPhoto(e.target.files?.[0]); e.target.value = ''; }} style={{ display: 'none' }} />
                <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} onClick={() => fileRef.current?.click()}>
                  <Icon name="camera" size={14} />{sheet.photo ? t('Sostituisci foto', 'Replace photo') : t('Aggiungi foto', 'Add photo')}
                </button>
              </React.Fragment>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function TechSheetForm({ clientId, appointmentId = null, defaultCategory, onSaved, onCancel }) {
  const { t, lang, serviceCategories, fireToast } = useDash();
  const fields = TECH_FIELDS(t);
  const catOptions = serviceCategories.map((sc) => nameIn(sc, lang));
  const [category, setCategory] = useState(defaultCategory || catOptions[0] || t('Generale', 'General'));
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [photo, setPhoto] = useState(null);
  /* L'anteprima era creata dentro il JSX: una URL nuova a ogni render, quindi a
   * ogni carattere battuto in un qualsiasi campo della scheda, e nessuna veniva
   * mai rilasciata. Con una foto da qualche megabyte la memoria cresceva
   * finché la scheda restava aperta. */
  const [photoUrl, setPhotoUrl] = useState(null);
  useEffect(() => {
    if (!photo) { setPhotoUrl(null); return undefined; }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);
  const photoRef = useRef(null);
  const setV = (k, v) => setValues((o) => ({ ...o, [k]: v }));
  const canSave = !!(values.treatment || '').trim() && !!category;

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        appointment_id: appointmentId,
        category,
        treatment: (values.treatment || '').trim(),
        zone: values.zone || '',
        products: values.products || '',
        params: (values.params || '').trim() ? { text: values.params.trim() } : {},
        outcome: values.outcome || '',
        duration_hold: values.duration_hold || '',
        advice: values.advice || '',
        protocol: values.protocol || '',
        next_step: values.next_step || '',
      };
      let sheet = await techSheetsApi.create(clientId, body);
      if (photo) {
        try { sheet = await techSheetsApi.uploadPhoto(clientId, sheet.id, photo); }
        catch (err) { fireToast({ msg: t('Scheda salvata, ma la foto non è stata caricata: ', 'Sheet saved, but the photo failed to upload: ') + (err instanceof ApiError ? err.message : ''), icon: 'alert' }); }
      }
      onSaved && onSaved(sheet);
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--clay-tint)', borderRadius: 12, marginBottom: 16 }}>
        <Icon name="info" size={15} color="var(--clay-ink)" />
        <span className="t-sm" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>{t('Una volta salvata, la scheda diventa di sola lettura e resta nella cronologia.', 'Once saved, the sheet becomes read-only and stays in the history.')}</span>
      </div>
      {/* category — free string on the API; the service-category catalog gives the sensible options */}
      <div style={{ marginBottom: 14 }}>
        <div className="t-meta" style={{ marginBottom: 6 }}>{t('Categoria', 'Category')}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
          {[...new Set([...(defaultCategory ? [defaultCategory] : []), ...catOptions])].map((name) => {
            const on = category === name;
            return (
              <button key={name} type="button" onClick={() => setCategory(name)} className={'dk-pill' + (on ? ' dk-pill--on' : '')} style={{ padding: '5px 12px', fontSize: 12.5 }}>{name}</button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {fields.map((f) => (
          <div key={f.k} style={{ gridColumn: f.type === 'textarea' ? '1 / -1' : 'auto' }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{f.label}{f.required && <span style={{ color: 'var(--danger)' }}> *</span>}</div>
            {f.type === 'textarea' ? (
              <textarea value={values[f.k] || ''} onChange={(e) => setV(f.k, e.target.value)} rows={2} placeholder={f.ph || ''} style={{ ...inputCss, resize: 'none', lineHeight: 1.5 }} />
            ) : f.type === 'select' ? (
              <select value={values[f.k] || ''} onChange={(e) => setV(f.k, e.target.value)} style={{ ...inputCss, cursor: 'pointer' }}>
                <option value="">{t('— seleziona —', '— select —')}</option>
                {f.opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input value={values[f.k] || ''} onChange={(e) => setV(f.k, e.target.value)} placeholder={f.ph || ''} style={inputCss} />
            )}
          </div>
        ))}
      </div>
      {/* foto facoltativa (prima/dopo, dettaglio del lavoro) */}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px dashed var(--line-strong)', borderRadius: 12 }}>
        <input ref={photoRef} type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] || null)} style={{ display: 'none' }} />
        {photo && photoUrl ? <img src={photoUrl} alt="" style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8 }} /> : <div style={{ width: 52, height: 52, borderRadius: 8, background: 'var(--surface-2)', display: 'grid', placeItems: 'center' }}><Icon name="camera" size={18} color="var(--muted-2)" /></div>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Foto del lavoro', 'Photo of the work')} <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 500 }}>· {t('facoltativa', 'optional')}</span></div>
          <div className="t-sm" style={{ color: 'var(--muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{photo ? photo.name : t('Prima/dopo, tonalità, dettaglio: resta nello storico.', 'Before/after, shade, detail: kept in the history.')}</div>
        </div>
        <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => photoRef.current?.click()}>{photo ? t('Cambia', 'Change') : t('Scegli', 'Choose')}</button>
        {photo && <button type="button" className="dk-iconbtn" style={{ width: 32, height: 32, borderRadius: 8 }} onClick={() => setPhoto(null)} aria-label={t('Rimuovi', 'Remove')}><Icon name="x" size={14} /></button>}
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="dk-btn dk-btn--ghost" style={{ flex: 1 }} onClick={onCancel}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" style={{ flex: 1, opacity: canSave && !saving ? 1 : 0.4 }} disabled={!canSave || saving} onClick={save}>
          <Icon name="check" size={16} color="#fff" />{saving ? t('Salvo…', 'Saving…') : t('Salva scheda', 'Save sheet')}
        </button>
      </div>
    </div>
  );
}
