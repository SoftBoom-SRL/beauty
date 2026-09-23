// components.jsx — small presentational pieces shared inside the clienti section.
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@youty/shared';
import { DkModal } from '../../ui/index.js';
import { relMeta, MONTHS_IT, MONTHS_EN, parseBirthday, birthdayEdit, daysInMonth as daysIn } from './helpers.js';
import GenderPickerUi from '../../ui/GenderPicker.jsx';

/* Reliability ring (ported RelRing). */
export function RelRing({ score, color, size = 46 }) {
  const r = size * 18 / 46, circ = 2 * Math.PI * r, c = size / 2;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--paper-2)" strokeWidth={size * 5 / 46} />
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeWidth={size * 5 / 46} strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ * (1 - Math.min(100, Math.max(0, score)) / 100)} />
      </svg>
      <span className="t-num" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: size * 13 / 46, color }}>{score}</span>
    </div>
  );
}

/* Compact reliability badge for list rows. */
export function RelBadge({ score, t, sm }) {
  const m = relMeta(score, t);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: sm ? 10.5 : 11.5, fontWeight: 700, color: m.color, background: `color-mix(in srgb, ${m.color} 14%, transparent)`, padding: sm ? '2px 8px' : '4px 10px', borderRadius: 99, whiteSpace: 'nowrap' }}>
      {score}<span style={{ fontWeight: 600 }}>· {m.label}</span>
    </span>
  );
}

/* Category label chip (client categories carry a name + color from the API). */
export function CatChip({ cat, sm, onRemove, removeTitle }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: sm ? 10.5 : 11.5, fontWeight: 700, color: 'var(--ink-2)', background: `color-mix(in srgb, ${cat.color || 'var(--hair)'} 45%, transparent)`, padding: onRemove ? '4px 6px 4px 10px' : (sm ? '2px 8px' : '4px 10px'), borderRadius: 99, whiteSpace: 'nowrap' }}>
      <span style={{ width: sm ? 7 : 8, height: sm ? 7 : 8, borderRadius: 99, background: cat.color || 'var(--muted-2)', boxShadow: '0 0 0 1px rgba(0,0,0,0.06) inset' }} />
      {cat.name}
      {onRemove && (
        <button onClick={onRemove} title={removeTitle} style={{ width: 16, height: 16, borderRadius: 99, display: 'grid', placeItems: 'center', cursor: 'pointer', background: 'rgba(0,0,0,0.08)', border: 'none' }}>
          <Icon name="x" size={10} color="var(--ink-2)" stroke={2.6} />
        </button>
      )}
    </span>
  );
}

/* KPI stat card (ported ProfStat). */
export function ProfStat({ label, value, hint = null }) {
  return (
    <div className="dk-card" style={{ padding: 16, boxShadow: 'none', border: '1px solid var(--hair)' }}>
      <div className="t-meta" style={{ marginBottom: 6 }}>{label}</div>
      <div className="t-num" style={{ fontSize: 24 }}>{value}</div>
      {/* La nota serve a dire «non ti e permesso vedere» invece di far passare
          un trattino per uno zero. */}
      {hint && <div className="t-meta" style={{ marginTop: 4, opacity: 0.7 }}>{hint}</div>}
    </div>
  );
}

/* Deterministic decorative QR glyph for gift-card codes (ported QrGlyph). */
export function QrGlyph({ code, size = 44 }) {
  let h = 0; for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
  const cells = [];
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { h = (h * 1103515245 + 12345) >>> 0; if ((h >> 16) % 5 < 2 || (x < 2 && y < 2) || (x > 4 && y < 2) || (x < 2 && y > 4)) cells.push([x, y]); }
  const u = size / 7;
  return (
    <svg width={size} height={size} style={{ display: 'block', borderRadius: 6, background: '#fff', border: '1px solid var(--hair)', flexShrink: 0 }} aria-hidden="true">
      {cells.map(([x, y], i) => <rect key={i} x={x * u + 1.5} y={y * u + 1.5} width={u - 3} height={u - 3} rx={1} fill="var(--ink)" />)}
    </svg>
  );
}

/* Confirm dialog (local — the registry has no generic confirm modal). */
export function ConfirmModal({ title, sub, body, confirmLabel, danger = true, busy, onConfirm, onClose, t }) {
  return (
    <DkModal open onClose={onClose} title={title} sub={sub} width={420}
      foot={<React.Fragment>
        <button className="dk-btn dk-btn--ghost" onClick={onClose}>{t('Annulla', 'Cancel')}</button>
        <button className="dk-btn dk-btn--clay" disabled={busy} onClick={onConfirm}
          style={danger ? { background: 'var(--danger)', borderColor: 'var(--danger)', opacity: busy ? 0.6 : 1 } : { opacity: busy ? 0.6 : 1 }}>
          <Icon name={danger ? 'alert' : 'check'} size={16} color="#fff" />{confirmLabel}
        </button>
      </React.Fragment>}>
      <div className="t-body" style={{ color: 'var(--ink-2)', lineHeight: 1.5, padding: '4px 0 10px' }}>{body}</div>
    </DkModal>
  );
}

/* Field wrapper for forms (ported NCField). */
export function Field({ label, hint, children }) {
  return (
    <div>
      <div className="t-meta" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        {label}
        {hint && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: 'var(--muted-2)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/* Genere: pillole a scelta singola (componente condiviso in ui/). */
export function GenderPicker(props) { return <GenderPickerUi {...props} />; }

/* Compleanno: giorno + mese obbligatori insieme, anno facoltativo.
 * value: 'YYYY-MM-DD' | '--MM-DD' | ''  →  onChange(stringa API).
 * Lo stato parziale (es. solo il mese scelto) resta nei selettori, così
 * l'ordine di compilazione è libero; intanto il valore è '' (vedi
 * birthdayEdit in helpers.js). */
export function BirthdayInput({ value, onChange, t, lang, disabled }) {
  const fromValue = (v) => { const b = parseBirthday(v); return b ? { d: String(b.d), m: String(b.m), y: b.y ? String(b.y) : '' } : { d: '', m: '', y: '' }; };
  const [part, setPart] = useState(() => fromValue(value));
  // Il valore emesso da qui non si riapplica ai selettori (uno stato parziale
  // emette '' e verrebbe cancellato mentre lo si compila): solo un valore
  // cambiato da fuori li riallinea.
  const emitted = useRef(value || '');
  useEffect(() => {
    if ((value || '') !== emitted.current) { emitted.current = value || ''; setPart(fromValue(value)); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const months = lang === 'en' ? MONTHS_EN : MONTHS_IT;
  const update = (patch) => {
    const { part: next, value: v } = birthdayEdit(part, patch);
    setPart(next);
    if (v !== emitted.current) { emitted.current = v; onChange(v); }
  };
  const sel = { border: '1px solid var(--hair)', borderRadius: 10, padding: '9px 10px', fontSize: 14, fontFamily: 'var(--sans)', background: 'var(--surface)', color: 'var(--ink)', outline: 'none', cursor: disabled ? 'default' : 'pointer' };
  const daysInMonth = daysIn(part.m, part.y);
  const complete = part.d && part.m;
  const partial = !complete && (part.d || part.m || part.y);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr 96px', gap: 8 }}>
        <select value={part.d} disabled={disabled} onChange={(e) => update({ d: e.target.value })} style={sel} aria-label={t('Giorno', 'Day')}>
          <option value="">{t('Giorno', 'Day')}</option>
          {[...Array(daysInMonth)].map((_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
        </select>
        <select value={part.m} disabled={disabled} onChange={(e) => update({ m: e.target.value })} style={sel} aria-label={t('Mese', 'Month')}>
          <option value="">{t('Mese', 'Month')}</option>
          {months.map((name, i) => <option key={i + 1} value={String(i + 1)}>{name}</option>)}
        </select>
        <input value={part.y} disabled={disabled} inputMode="numeric" maxLength={4} placeholder={t('Anno', 'Year')} aria-label={t('Anno (facoltativo)', 'Year (optional)')}
          onChange={(e) => update({ y: e.target.value.replace(/\D/g, '').slice(0, 4) })}
          onBlur={() => { if (part.y && part.y.length < 4) update({ y: '' }); }}
          style={{ ...sel, cursor: 'text' }} />
      </div>
      <div className="t-sm" style={{ color: partial ? 'var(--warn)' : 'var(--muted-2)', marginTop: 5, fontSize: 11.5, fontWeight: partial ? 600 : 400 }}>
        {partial
          ? t('Scegli giorno e mese: senza tutti e due il compleanno non si salva.', 'Pick both day and month: otherwise no birthday is saved.')
          : complete && !part.y
          ? t('Solo giorno e mese: niente età, ma gli auguri arrivano lo stesso.', 'Day and month only: no age, birthday wishes still go out.')
          : t('L\u2019anno è facoltativo: chi non vuole dire l\u2019età può dare solo il giorno.', 'Year is optional: clients who prefer not to share their age can give just the day.')}
      </div>
    </div>
  );
}
