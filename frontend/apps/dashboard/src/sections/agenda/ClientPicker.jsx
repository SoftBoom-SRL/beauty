// ClientPicker — ricerca cliente (nome/telefono) + creazione rapida inline.
// Usato dal drawer "nuova prenotazione" e dalla prenotazione di gruppo: un solo
// componente, stessa UX. Tastiera: ↑/↓ scorrono, Invio seleziona, Esc chiude.
// "Nuovo cliente" apre un mini-form (nome, cognome, telefono) precompilato con
// quanto digitato: si crea e si seleziona senza uscire dalla prenotazione.
import React, { useEffect, useRef, useState } from 'react';
import { api, ApiError, Avatar, Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { initialsOf } from './lib.js';
import { GenderPicker } from '../../ui/index.js';

const looksLikePhone = (s) => /^[+\d][\d\s./-]{4,}$/.test(String(s || '').trim());

export default function ClientPicker({ value, onChange, autoFocus = false, placeholder }) {
  const { t, fireToast, hasScope } = useDash();
  const canCreate = hasScope('clients');

  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState(null); // null = caricamento
  const [hi, setHi] = useState(0);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ first_name: '', last_name: '', phone: '', gender: '' });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const firstRef = useRef(null);
  const blurTimer = useRef(null);

  useEffect(() => { if (autoFocus && !value) inputRef.current?.focus(); }, [autoFocus, value]);

  /* ricerca (debounced) — anche a query vuota: mostra gli ultimi clienti */
  useEffect(() => {
    if (!open || value) return;
    let alive = true;
    setResults(null);
    const tm = setTimeout(() => {
      api.get('/api/clients/', { params: { q: q.trim() || undefined, limit: 7, is_active: true } })
        .then((res) => { if (alive) { setResults(res.items || []); setHi(0); } })
        .catch(() => { if (alive) setResults([]); });
    }, 180);
    return () => { alive = false; clearTimeout(tm); };
  }, [q, open, value]);

  const pick = (c) => { onChange(c); setQ(''); setOpen(false); setCreating(false); setErr(''); };

  const startCreate = () => {
    const raw = q.trim();
    const d = { first_name: '', last_name: '', phone: '', gender: '' };
    if (looksLikePhone(raw)) d.phone = raw;
    else { const [first, ...rest] = raw.split(/\s+/).filter(Boolean); d.first_name = first || ''; d.last_name = rest.join(' '); }
    setDraft(d); setErr(''); setCreating(true); setOpen(false);
    requestAnimationFrame(() => (d.first_name ? null : firstRef.current)?.focus?.());
  };

  const create = async () => {
    const first = draft.first_name.trim(), last = draft.last_name.trim(), phone = draft.phone.trim();
    if (!first) { setErr(t('Il nome è obbligatorio', 'First name is required')); return; }
    if (!phone) { setErr(t('Il telefono è obbligatorio', 'Phone is required')); return; }
    setSaving(true); setErr('');
    try {
      const c = await api.post('/api/clients/', { first_name: first, last_name: last, phone, gender: draft.gender || '' });
      fireToast({ msg: t(`Cliente creato: ${c.full_name}`, `Client created: ${c.full_name}`), icon: 'check' });
      pick(c);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : t('Errore di rete', 'Network error'));
    } finally { setSaving(false); }
  };

  const onKey = (e) => {
    if (!open) { if (e.key === 'ArrowDown') setOpen(true); return; }
    const n = (results || []).length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(n, i + 1)); } // n = riga "nuovo cliente"
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (results && hi < n) pick(results[hi]);
      else if (canCreate) startCreate();
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  const inputCss = { border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 13.5, padding: '9px 11px', fontFamily: 'var(--sans)', background: 'var(--surface)', boxSizing: 'border-box', width: '100%' };

  /* ---- selezionato ---- */
  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 12, background: 'var(--clay-tint)', border: '1.5px solid color-mix(in srgb, var(--clay) 40%, transparent)' }}>
        <Avatar initials={initialsOf(value.full_name)} size={34} color="var(--clay-tint2)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value.full_name}</div>
          <div className="t-sm tabnum" style={{ color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
            {value.phone && <span>{value.phone}</span>}
            {value.deposit_always && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-tint)', padding: '1px 7px', borderRadius: 99 }}>{t('Caparra sempre', 'Deposit always')}</span>}
          </div>
        </div>
        <button type="button" onClick={() => { onChange(null); setTimeout(() => inputRef.current?.focus(), 30); }} className="dk-btn dk-btn--ghost" style={{ height: 30, padding: '0 10px', fontSize: 12.5, borderRadius: 9 }}>{t('Cambia', 'Change')}</button>
      </div>
    );
  }

  /* ---- creazione rapida ---- */
  if (creating) {
    return (
      <div style={{ border: '1.5px solid var(--clay)', borderRadius: 12, padding: 12, background: 'var(--surface)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center' }}><Icon name="user" size={15} color="var(--clay-ink)" /></div>
          <div style={{ flex: 1, fontWeight: 700, fontSize: 13.5 }}>{t('Nuovo cliente', 'New client')}</div>
          <button type="button" onClick={() => { setCreating(false); setOpen(true); setTimeout(() => inputRef.current?.focus(), 30); }} className="dk-iconbtn" style={{ width: 28, height: 28, borderRadius: 8 }} aria-label={t('Annulla', 'Cancel')}><Icon name="x" size={14} /></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
          <input ref={firstRef} autoFocus={!draft.first_name} value={draft.first_name} onChange={(e) => setDraft((d) => ({ ...d, first_name: e.target.value }))} placeholder={t('Nome *', 'First name *')} style={inputCss} onKeyDown={(e) => e.key === 'Enter' && create()} />
          <input value={draft.last_name} onChange={(e) => setDraft((d) => ({ ...d, last_name: e.target.value }))} placeholder={t('Cognome', 'Last name')} style={inputCss} onKeyDown={(e) => e.key === 'Enter' && create()} />
        </div>
        <input value={draft.phone} inputMode="tel" onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} placeholder={t('Telefono * (es. 333 1234567)', 'Phone * (e.g. 333 1234567)')} style={{ ...inputCss, marginBottom: 8 }} onKeyDown={(e) => e.key === 'Enter' && create()} autoFocus={!!draft.first_name} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600, fontSize: 12 }}>{t('Genere', 'Gender')}</span>
          <GenderPicker value={draft.gender} onChange={(g) => setDraft((d) => ({ ...d, gender: g }))} t={t} compact />
        </div>
        {err && <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: 'var(--danger)', marginBottom: 8 }}><Icon name="alert" size={14} color="var(--danger)" />{err}</div>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="t-sm" style={{ color: 'var(--muted-2)', flex: 1 }}>{t('Il resto della scheda si completa dopo.', 'You can complete the profile later.')}</span>
          <button type="button" className="dk-btn dk-btn--clay" style={{ height: 36, fontSize: 13 }} onClick={create} disabled={saving}>
            <Icon name="check" size={15} color="#fff" />{saving ? t('Creazione…', 'Creating…') : t('Crea e seleziona', 'Create & select')}
          </button>
        </div>
      </div>
    );
  }

  /* ---- ricerca ---- */
  const list = results || [];
  return (
    <div style={{ position: 'relative' }}>
      <div className="dk-search" style={{ width: '100%', height: 40, borderRadius: 12, borderColor: open ? 'var(--line-strong)' : undefined }}>
        <Icon name="search" size={16} color="var(--muted-2)" />
        <input
          ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          placeholder={placeholder || t('Cerca per nome o telefono…', 'Search by name or phone…')}
          onFocus={() => { clearTimeout(blurTimer.current); setOpen(true); }}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 160); }}
          onKeyDown={onKey}
          aria-expanded={open} aria-autocomplete="list" role="combobox"
        />
        {q && <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => { setQ(''); inputRef.current?.focus(); }} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
      </div>
      {open && (
        <div className="dk-card" role="listbox" onMouseDown={(e) => e.preventDefault()} style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 30, padding: 6, boxShadow: 'var(--sh-pop)', maxHeight: 320, overflowY: 'auto' }}>
          {results === null && [...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 42, borderRadius: 10, marginBottom: 4 }} />)}
          {list.map((c, i) => (
            <button key={c.id} type="button" role="option" aria-selected={hi === i} onMouseEnter={() => setHi(i)} onClick={() => pick(c)} className="dk-row"
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '7px 9px', borderRadius: 10, textAlign: 'left', border: 'none', background: hi === i ? 'var(--surface-2)' : 'transparent', cursor: 'pointer' }}>
              <Avatar initials={initialsOf(c.full_name)} size={30} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.full_name}</span>
                <span className="t-sm tabnum" style={{ color: 'var(--muted)', fontSize: 12 }}>{c.phone}{c.reliability != null && c.reliability < 60 ? ' · ' + t('affidabilità bassa', 'low reliability') : ''}</span>
              </span>
              {c.deposit_always && <Icon name="coupon" size={14} color="var(--warn)" title={t('Caparra sempre', 'Deposit always')} />}
            </button>
          ))}
          {results && !list.length && (
            <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '8px 10px' }}>{q.trim() ? t('Nessun cliente trovato', 'No client found') : t('Nessun cliente in anagrafica', 'No clients yet')}</div>
          )}
          {canCreate && results !== null && (
            <button type="button" role="option" aria-selected={hi === list.length} onMouseEnter={() => setHi(list.length)} onClick={startCreate}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 9px', borderRadius: 10, textAlign: 'left', border: 'none', marginTop: list.length ? 4 : 0, background: hi === list.length ? 'var(--clay-tint)' : 'transparent', cursor: 'pointer', borderTop: list.length ? '1px solid var(--hair)' : 'none' }}>
              <span style={{ width: 30, height: 30, borderRadius: 99, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="plus" size={15} color="var(--clay-ink)" stroke={2.4} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: 'var(--clay-ink)' }}>{t('Nuovo cliente', 'New client')}{q.trim() ? ` “${q.trim()}”` : ''}</span>
                <span className="t-sm" style={{ color: 'var(--muted)', fontSize: 12 }}>{t('Nome e telefono, il resto dopo', 'Name and phone, the rest later')}</span>
              </span>
              <span className="dk-kbd">↵</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
