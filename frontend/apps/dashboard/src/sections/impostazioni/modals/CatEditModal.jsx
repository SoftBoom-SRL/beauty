// CatEditModal.jsx — crea o modifica una categoria, dentro la gestione
// categorie (CategoriesManagerModal): nome (bilingue per i servizi) e colore.
import React from 'react';
import { Icon } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import HexInput from '../../../ui/HexInput.jsx';
import PaletteGrid from '../../../ui/PaletteGrid.jsx';
import { inputCss } from '../lib.jsx';

export default function CatEditModal({ draft, setDraft, cfg, onSave, saving, onDelete, onClose, t }) {
  const canSave = !saving && (cfg.bilingual ? (draft.name_it || '').trim() : (draft.name || '').trim());
  return (
    <DkModal open onClose={onClose} title={draft._new ? t('Nuova categoria', 'New category') : t('Modifica categoria', 'Edit category')} width={440}
      foot={<React.Fragment>
        {!draft._new && <button className="dk-btn dk-btn--ghost" style={{ color: 'var(--danger)', borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--hair))', marginRight: 'auto' }} onClick={onDelete}><Icon name="x" size={16} color="var(--danger)" />{t('Elimina', 'Delete')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={!canSave} onClick={() => canSave && onSave(draft)}><Icon name="check" size={17} color="#fff" />{t('Salva', 'Save')}</button>
      </React.Fragment>}>
      {cfg.bilingual ? (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nome (italiano)', 'Name (Italian)')}</div>
          <input value={draft.name_it || ''} onChange={(e) => setDraft((d) => ({ ...d, name_it: e.target.value }))} placeholder={t('Nome categoria', 'Category name')} autoFocus style={{ ...inputCss, width: '100%', boxSizing: 'border-box', fontSize: 15, padding: '11px 13px', marginBottom: 14 }} />
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nome (inglese)', 'Name (English)')}</div>
          <input value={draft.name_en || ''} onChange={(e) => setDraft((d) => ({ ...d, name_en: e.target.value }))} placeholder={t('Facoltativo', 'Optional')} style={{ ...inputCss, width: '100%', boxSizing: 'border-box', fontSize: 15, padding: '11px 13px', marginBottom: 18 }} />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 8 }}>{t('Nome categoria', 'Category name')}</div>
          <input value={draft.name || ''} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder={t('Nome categoria', 'Category name')} autoFocus style={{ ...inputCss, width: '100%', boxSizing: 'border-box', fontSize: 15, padding: '11px 13px', marginBottom: 18 }} />
        </React.Fragment>
      )}

      {cfg.hasColor && (
        <React.Fragment>
          <div className="t-meta" style={{ marginBottom: 10 }}>{t('Colore', 'Colour')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <label title={t('Ruota dei colori', 'Colour wheel')} style={{ position: 'relative', width: 48, height: 48, borderRadius: 12, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--hair)', background: draft.color || '#888' }}>
              <input type="color" value={draft.color || '#888888'} onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value.toUpperCase() }))} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
            </label>
            <div style={{ flex: 1 }}>
              <div className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, marginBottom: 4 }}>{t('Codice esadecimale', 'Hex code')}</div>
              <HexInput value={draft.color} onChange={(c) => setDraft((d) => ({ ...d, color: c }))} />
            </div>
          </div>
          <PaletteGrid value={draft.color} onChange={(c) => setDraft((d) => ({ ...d, color: c }))} />
        </React.Fragment>
      )}
    </DkModal>
  );
}
