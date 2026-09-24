// NoteBits.jsx — mattoni condivisi per le note cliente con allegati:
// NoteComposer (testo + visibilità + foto/documenti) e NoteCard (lettura,
// modifica testo, gestione allegati). Usati dalla scheda Note e dallo Storico
// (note di trattamento legate alla visita).
import React, { useEffect, useRef, useState } from 'react';
import { api, Icon, mediaUrl, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { dateTimeLabel, inputCss } from './helpers.js';

const ACCEPT = 'image/*,.pdf,.doc,.docx,.txt';
const isImg = (f) => /^image\//.test(f.type || '');
export const fmtSize = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const isAiVisible = (v) => v === 'ai' || v === 'shared';

export function VisibilityToggle({ shared, onChange, t }) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--paper-2)', borderRadius: 99, padding: 3, gap: 2 }}>
      <button type="button" onClick={() => onChange(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none', background: !shared ? 'var(--surface)' : 'transparent', color: !shared ? 'var(--ink)' : 'var(--muted)', boxShadow: !shared ? 'var(--sh-sm)' : 'none' }}>
        <Icon name="lock" size={12} color={!shared ? 'var(--ink)' : 'var(--muted)'} />{t('Privata', 'Private')}
      </button>
      <button type="button" onClick={() => onChange(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 99, fontSize: 12, fontWeight: 700, cursor: 'pointer', border: 'none', background: shared ? 'var(--surface)' : 'transparent', color: shared ? 'var(--clay-ink)' : 'var(--muted)', boxShadow: shared ? 'var(--sh-sm)' : 'none' }}>
        <Icon name="sparkle" size={12} color={shared ? 'var(--clay-ink)' : 'var(--muted)'} />{t("Visibile all'AI", 'Visible to AI')}
      </button>
    </div>
  );
}

/* anteprima locale dei file scelti prima dell'invio */
function PendingFiles({ files, onRemove }) {
  const [urls, setUrls] = useState([]);
  useEffect(() => {
    const u = files.map((f) => (isImg(f) ? URL.createObjectURL(f) : null));
    setUrls(u);
    return () => u.forEach((x) => x && URL.revokeObjectURL(x));
  }, [files]);
  if (!files.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
      {files.map((f, i) => (
        <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: isImg(f) ? 0 : '6px 10px', borderRadius: 10, border: '1px solid var(--hair)', background: 'var(--surface-2)', maxWidth: 220 }}>
          {isImg(f) && urls[i]
            ? <img src={urls[i]} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 10, display: 'block' }} />
            : <React.Fragment><Icon name="box" size={15} color="var(--muted)" /><span className="t-sm" style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{f.name}</span><span className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11 }}>{fmtSize(f.size)}</span></React.Fragment>}
          <button type="button" onClick={() => onRemove(i)} aria-label="Rimuovi" style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 99, background: 'var(--ink)', color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer', border: '2px solid var(--surface)' }}><Icon name="x" size={10} color="#fff" stroke={3} /></button>
        </div>
      ))}
    </div>
  );
}

/** Composer: nota di trattamento (appointmentId) o nota libera. */
export function NoteComposer({ clientId, appointmentId = null, onSaved, onCancel, placeholder, autoFocus, compact }) {
  const { t, fireToast } = useDash();
  const [text, setText] = useState('');
  const [shared, setShared] = useState(false);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);
  const canSave = (text.trim() || files.length) && !saving;

  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    const bad = incoming.filter((f) => f.size > 15 * 1024 * 1024);
    if (bad.length) fireToast({ msg: t(`File troppo grande (max 15 MB): ${bad[0].name}`, `File too large (max 15 MB): ${bad[0].name}`), icon: 'alert' });
    setFiles((l) => [...l, ...incoming.filter((f) => f.size <= 15 * 1024 * 1024)].slice(0, 10));
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      let note;
      const visibility = shared ? 'ai' : 'private';
      if (files.length) {
        const fd = new FormData();
        fd.append('text', text.trim());
        fd.append('visibility', visibility);
        if (appointmentId) fd.append('appointment_id', String(appointmentId));
        files.forEach((f) => fd.append('files', f, f.name));
        note = await api.postForm(`/api/clients/${clientId}/notes/upload`, fd);
      } else {
        note = await api.post(`/api/clients/${clientId}/notes`, { text: text.trim(), visibility, appointment_id: appointmentId });
      }
      setText(''); setFiles([]); setShared(false);
      fireToast({ msg: files.length ? t('Nota e allegati salvati', 'Note and attachments saved') : t('Nota aggiunta', 'Note added'), icon: 'check' });
      onSaved?.(note);
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally { setSaving(false); }
  };

  return (
    <div className="dk-card" style={{ padding: compact ? 12 : 16, boxShadow: 'none', border: '1.5px solid var(--clay)' }}
      onDragOver={(e) => { e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={compact ? 2 : 3} autoFocus={autoFocus}
        placeholder={placeholder || (appointmentId ? t('Com’è andato il trattamento? Prodotti, tempi, reazioni, cosa rifare la prossima volta…', 'How did the treatment go? Products, timings, reactions, what to repeat next time…') : t('Aggiungi una nota su questo cliente…', 'Add a note about this client…'))}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); }}
        style={{ ...inputCss, border: 'none', padding: 0, resize: 'none', fontSize: 14.5, lineHeight: 1.5, background: 'transparent' }} />
      <PendingFiles files={files} onRemove={(i) => setFiles((l) => l.filter((_, j) => j !== i))} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hair)', flexWrap: 'wrap' }}>
        <input ref={fileRef} type="file" multiple accept={ACCEPT} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
        <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5, padding: '0 11px' }} onClick={() => fileRef.current?.click()} title={t('Foto o documento (immagini, PDF, Word). Puoi anche trascinarli qui.', 'Photo or document (images, PDF, Word). You can also drop them here.')}>
          <Icon name="camera" size={15} />{t('Foto / documento', 'Photo / document')}
        </button>
        <VisibilityToggle shared={shared} onChange={setShared} t={t} />
        <div style={{ flex: 1 }} />
        {onCancel && <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} onClick={onCancel}>{t('Annulla', 'Cancel')}</button>}
        <button type="button" className="dk-btn dk-btn--clay" style={{ height: 34, fontSize: 12.5 }} aria-disabled={!canSave} onClick={save} title="⌘/Ctrl + Invio">
          <Icon name="check" size={15} color="#fff" />{saving ? t('Salvo…', 'Saving…') : t('Salva nota', 'Save note')}
        </button>
      </div>
    </div>
  );
}

/** Griglia allegati: immagini come miniature (clic → apre), documenti come chip. */
export function AttachmentGrid({ attachments, onRemove, size = 76 }) {
  const { t } = useDash();
  if (!attachments?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {attachments.map((a) => (
        <div key={a.id} style={{ position: 'relative' }}>
          <a href={mediaUrl(a.url)} target="_blank" rel="noreferrer" title={`${a.name} · ${fmtSize(a.size)}`}
            style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', color: 'var(--ink-2)', borderRadius: 10, border: '1px solid var(--hair)', background: 'var(--surface-2)', padding: a.is_image ? 0 : '7px 10px', overflow: 'hidden' }}>
            {a.is_image
              ? <img src={mediaUrl(a.url)} alt={a.name} loading="lazy" style={{ width: size, height: size, objectFit: 'cover', display: 'block' }} />
              : <React.Fragment><Icon name={/pdf/.test(a.content_type) ? 'list' : 'box'} size={15} color="var(--muted)" /><span className="t-sm" style={{ fontWeight: 600, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span><span className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11 }}>{fmtSize(a.size)}</span></React.Fragment>}
          </a>
          {onRemove && (
            <button type="button" onClick={() => onRemove(a)} aria-label={t('Rimuovi allegato', 'Remove attachment')} style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 99, background: 'var(--ink)', display: 'grid', placeItems: 'center', cursor: 'pointer', border: '2px solid var(--surface)' }}><Icon name="x" size={10} color="#fff" stroke={3} /></button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Card nota: testo modificabile, allegati gestibili, eliminazione. */
export function NoteCard({ note, clientId, canWrite, onChanged, onDeleted, compact }) {
  const { t, lang, fireToast } = useDash();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const shared = isAiVisible(note.visibility);
  const toastErr = (err) => toastApiError(err, fireToast, t);

  const saveText = async () => {
    if (text.trim() === note.text) { setEditing(false); return; }
    setBusy(true);
    try { const n = await api.put(`/api/clients/${clientId}/notes/${note.id}`, { text: text.trim() }); onChanged?.(n); setEditing(false); }
    catch (err) { toastErr(err); } finally { setBusy(false); }
  };
  const toggleVisibility = async () => {
    try { const n = await api.put(`/api/clients/${clientId}/notes/${note.id}`, { visibility: shared ? 'private' : 'ai' }); onChanged?.(n); }
    catch (err) { toastErr(err); }
  };
  const addFiles = async (list) => {
    const files = Array.from(list || []); if (!files.length) return;
    setBusy(true);
    try {
      const fd = new FormData(); files.forEach((f) => fd.append('files', f, f.name));
      const n = await api.postForm(`/api/clients/${clientId}/notes/${note.id}/attachments`, fd);
      onChanged?.(n); fireToast({ msg: t('Allegati aggiunti', 'Attachments added'), icon: 'check' });
    } catch (err) { toastErr(err); } finally { setBusy(false); }
  };
  const removeAttachment = async (a) => {
    try { await api.del(`/api/clients/${clientId}/notes/${note.id}/attachments/${a.id}`); onChanged?.({ ...note, attachments: note.attachments.filter((x) => x.id !== a.id) }); }
    catch (err) { toastErr(err); }
  };
  const remove = async () => {
    try { await api.del(`/api/clients/${clientId}/notes/${note.id}`); onDeleted?.(note); fireToast({ msg: t('Nota eliminata', 'Note deleted'), icon: 'x' }); }
    catch (err) { toastErr(err); }
  };

  return (
    <div className="dk-card" style={{ padding: compact ? '10px 12px' : 14, boxShadow: 'none', border: '1px solid ' + (shared ? 'color-mix(in srgb, var(--clay) 35%, var(--hair))' : 'var(--hair)'), opacity: busy ? 0.7 : 1 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, display: 'grid', placeItems: 'center', background: shared ? 'var(--clay-tint)' : 'var(--paper-2)' }}>
          <Icon name={shared ? 'sparkle' : 'lock'} size={14} color={shared ? 'var(--clay-ink)' : 'var(--muted)'} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editing ? (
            <div>
              {/* Esc annulla la modifica e basta: preventDefault dice alla pila
                  delle finestre (ui/layers.js) di non chiudere anche quella sotto */}
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus style={{ ...inputCss, fontSize: 14, lineHeight: 1.5 }} onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveText(); if (e.key === 'Escape') { e.preventDefault(); setText(note.text); setEditing(false); } }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} onClick={() => { setText(note.text); setEditing(false); }}>{t('Annulla', 'Cancel')}</button>
                <button type="button" className="dk-btn dk-btn--clay" style={{ height: 32, fontSize: 12.5 }} onClick={saveText}><Icon name="check" size={14} color="#fff" />{t('Salva', 'Save')}</button>
              </div>
            </div>
          ) : (
            note.text ? <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--ink-2)', whiteSpace: 'pre-wrap' }}>{note.text}</div>
              : <div className="t-sm" style={{ color: 'var(--muted-2)', fontStyle: 'italic' }}>{t('Solo allegati', 'Attachments only')}</div>
          )}
          {note.attachments?.length > 0 && <div style={{ marginTop: 10 }}><AttachmentGrid attachments={note.attachments} onRemove={canWrite ? removeAttachment : null} size={compact ? 64 : 84} /></div>}
          <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span>{note.author_name || t('Sistema', 'System')} · {dateTimeLabel(note.created_at, lang)}</span>
            <button type="button" onClick={canWrite ? toggleVisibility : undefined} title={canWrite ? t('Cambia visibilità', 'Toggle visibility') : ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700, cursor: canWrite ? 'pointer' : 'default', background: shared ? 'var(--clay-tint)' : 'var(--paper-2)', color: shared ? 'var(--clay-ink)' : 'var(--muted)', border: 'none' }}>
              <Icon name={shared ? 'sparkle' : 'lock'} size={10} color={shared ? 'var(--clay-ink)' : 'var(--muted)'} />{shared ? t("Visibile all'AI", 'Visible to AI') : t('Privata', 'Private')}
            </button>
          </div>
        </div>
        {canWrite && !editing && (
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <input ref={fileRef} type="file" multiple accept={ACCEPT} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} style={{ display: 'none' }} />
            <button type="button" className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} title={t('Aggiungi foto o documento', 'Add photo or document')} onClick={() => fileRef.current?.click()}><Icon name="camera" size={13} /></button>
            <button type="button" className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} title={t('Modifica testo', 'Edit text')} onClick={() => setEditing(true)}><Icon name="edit" size={13} /></button>
            <button type="button" className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} title={t('Elimina nota', 'Delete note')} onClick={remove}><Icon name="x" size={13} /></button>
          </div>
        )}
      </div>
    </div>
  );
}
