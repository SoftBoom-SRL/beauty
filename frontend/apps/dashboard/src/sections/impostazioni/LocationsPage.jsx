// LocationsPage.jsx — sedi CRUD on /api/core/locations.
// Reads: any staff. Writes: owner-only (lock state otherwise).
// Deleting the only location → 400 from the API, surfaced as toast.
import React, { useCallback, useEffect, useState } from 'react';
import { api, Icon, PhoneInput } from '@youty/shared';
import DkModal from '../../ui/DkModal.jsx';
import DkConfirm from '../../ui/DkConfirm.jsx';
import { useDash } from '../../ctx.jsx';
import { inputCss, toastErr, LockNote } from './lib.jsx';

export default function LocationsPage({ onBack }) {
  const { t, lang, session, reload, fireToast } = useDash();
  const isOwner = !!session?.is_owner;
  const [list, setList] = useState(null); // null = loading
  const [edit, setEdit] = useState(null); // draft {id?, name, address, phone, is_default}
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setList(await api.get('/api/core/locations')); }
    catch (err) { toastErr(err, fireToast, t); setList([]); }
  }, [fireToast, t]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!edit || saving) return;
    const payload = { name: edit.name.trim(), address: edit.address || '', phone: edit.phone || '', is_default: !!edit.is_default };
    if (!payload.name) return;
    setSaving(true);
    try {
      if (edit.id) await api.put(`/api/core/locations/${edit.id}`, payload);
      else await api.post('/api/core/locations', payload);
      await Promise.all([load(), reload.salon()]);
      setEdit(null);
      fireToast({ msg: t('Sede salvata', 'Location saved'), icon: 'check' });
    } catch (err) { toastErr(err, fireToast, t); }
    finally { setSaving(false); }
  };

  // Eliminare una sede tocca operatrici e appuntamenti collegati: si chiede
  // prima, perché partiva al primo clic e non si torna indietro.
  const [confirmDel, setConfirmDel] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const del = async () => {
    const target = confirmDel;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      await api.del(`/api/core/locations/${target.id}`);
      await Promise.all([load(), reload.salon()]);
      setEdit(null);
      setConfirmDel(null);
      fireToast({ msg: t('Sede eliminata', 'Location deleted'), icon: 'x' });
    } catch (err) { toastErr(err, fireToast, t); } // 400 "only one" → toast
    finally { setDeleting(false); }
  };

  return (
    <div className="dk-page" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <button className="dk-iconbtn" onClick={onBack} style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', border: '1px solid var(--hair)', background: 'var(--surface)' }}><Icon name="chevL" size={18} /></button>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500 }}>{t('Sedi', 'Locations')}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{t('Le sedi del salone. La sede predefinita è usata dove non specificato.', 'Your salon locations. The default one is used where not specified.')}</div>
        </div>
        {isOwner && (
          <button className="dk-btn dk-btn--clay" onClick={() => setEdit({ name: '', address: '', phone: '', is_default: false })}>
            <Icon name="plus" size={16} color="#fff" />{t('Nuova sede', 'New location')}
          </button>
        )}
      </div>

      {!isOwner && <div style={{ marginBottom: 14 }}><LockNote t={t} msg={t('Solo il titolare può modificare le sedi.', 'Only the owner can edit locations.')} /></div>}

      {list === null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[0, 1].map((i) => <div key={i} className="skel" style={{ height: 72, borderRadius: 14 }} />)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {list.map((l) => (
            <div key={l.id} className="dk-card dk-row" onClick={isOwner ? () => setEdit({ ...l }) : undefined}
              style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '15px 17px', boxShadow: 'none', border: '1px solid var(--hair)', cursor: isOwner ? 'pointer' : 'default' }}>
              <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="mapPin" size={18} color="var(--clay-ink)" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14.5 }}>{l.name}</span>
                  {l.is_default && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '1px 8px', borderRadius: 99 }}>{t('predefinita', 'default')}</span>}
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {[l.address, l.phone].filter(Boolean).join(' · ') || t('Nessun dettaglio', 'No details')}
                </div>
              </div>
              {isOwner && <Icon name="chevR" size={15} color="var(--faint)" />}
            </div>
          ))}
          {!list.length && <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '10px 2px' }}>{t('Nessuna sede.', 'No locations.')}</div>}
        </div>
      )}

      {edit && (
        <DkModal open onClose={() => setEdit(null)} width={440}
          title={edit.id ? t('Modifica sede', 'Edit location') : t('Nuova sede', 'New location')}
          foot={<React.Fragment>
            {edit.id && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={() => setConfirmDel(edit)}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
            <button className="dk-btn dk-btn--ghost" onClick={() => setEdit(null)}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--clay" disabled={!edit.name.trim() || saving} onClick={save}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
          </React.Fragment>}>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nome sede', 'Location name')}</div>
          <input value={edit.name} autoFocus onChange={(e) => setEdit((d) => ({ ...d, name: e.target.value }))} placeholder={t('es. Firenze centro', 'e.g. Downtown')} style={{ ...inputCss, width: '100%', boxSizing: 'border-box', marginBottom: 14 }} />
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Indirizzo', 'Address')}</div>
          <input value={edit.address || ''} onChange={(e) => setEdit((d) => ({ ...d, address: e.target.value }))} placeholder={t('Via, numero, città', 'Street, number, city')} style={{ ...inputCss, width: '100%', boxSizing: 'border-box', marginBottom: 14 }} />
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Telefono', 'Phone')}</div>
          <div style={{ marginBottom: 16 }}>
            <PhoneInput value={edit.phone || ''} onChange={(v) => setEdit((d) => ({ ...d, phone: v }))} lang={lang} ariaLabel={t('Telefono', 'Phone')} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '11px 13px', background: 'var(--surface-2)', borderRadius: 11 }}>
            <input type="checkbox" checked={!!edit.is_default} onChange={(e) => setEdit((d) => ({ ...d, is_default: e.target.checked }))} />
            <span style={{ fontWeight: 600, fontSize: 13.5 }}>{t('Sede predefinita', 'Default location')}</span>
          </label>
        </DkModal>
      )}
      <DkConfirm
        open={!!confirmDel}
        busy={deleting}
        onClose={() => setConfirmDel(null)}
        onConfirm={del}
        title={t('Eliminare la sede?', 'Delete this location?')}
        message={t(`«${confirmDel?.name || ''}» verrà eliminata.`, `“${confirmDel?.name || ''}” will be deleted.`)}
        detail={t('Le operatrici assegnate e gli appuntamenti di questa sede resteranno senza sede.',
          'Stylists assigned here and this location’s appointments will be left without a location.')}
        confirmLabel={t('Elimina', 'Delete')}
        cancelLabel={t('Annulla', 'Cancel')}
      />
    </div>
  );
}
