// lib.jsx — local shared helpers for the impostazioni section.
// NOTE: DkDrop / DkCondRow are LOCAL COPIES of the automazioni prototype builder
// (desktop-automazioni.jsx). The automazioni section keeps its own copy: flag for
// a future shared extraction.
import React, { useEffect, useRef, useState } from 'react';
import { Icon, NumInput } from '@youty/shared';
import DkSeg from '../../ui/DkSeg.jsx';
import { dropCurrent } from './rules.js';

// logica pura delle regole caparra: vive in rules.js (provata con node --test)
export { depositFields, ruleSentence, amountForType } from './rules.js';

/* ---------------- Google-Docs-like palette (GD_PALETTE port) ---------------- */
export function gdHexFromHSL(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
const GD_HUES = [0, 22, 45, 90, 140, 175, 205, 230, 265, 300];
export const GD_PALETTE = (() => {
  const rows = [];
  rows.push(['#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF']);
  rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 78, 50)));
  [92, 84, 74].forEach((l) => rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 70, l))));
  [40, 30, 20].forEach((l) => rows.push(GD_HUES.map((h) => gdHexFromHSL(h, 65, l))));
  return rows;
})();

export function PaletteGrid({ value, onChange, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 280, ...style }}>
      {GD_PALETTE.map((row, ri) => (
        <div key={ri} style={{ display: 'flex', gap: 3 }}>
          {row.map((c) => {
            const on = (value || '').toLowerCase() === c.toLowerCase();
            return (
              <button key={c} onClick={() => onChange(c)} title={c}
                style={{ width: 22, height: 22, borderRadius: 5, background: c, cursor: 'pointer', border: '1px solid ' + (c.toUpperCase() === '#FFFFFF' ? 'var(--hair)' : 'transparent'), outline: on ? '2px solid var(--ink)' : 'none', outlineOffset: 1, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
                {on && <Icon name="check" size={12} color={ri === 0 && row.indexOf(c) > 6 ? 'var(--ink)' : '#fff'} stroke={2.6} />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------------- common bits ---------------- */
export const inputCss = {
  border: '1px solid var(--hair)', borderRadius: 10, outline: 'none', fontSize: 14,
  padding: '10px 12px', fontFamily: 'var(--sans)', background: 'var(--surface)', color: 'var(--ink)',
};

export function LockNote({ t, msg }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 15px', background: 'var(--surface-2)', borderRadius: 12, border: '1px solid var(--hair)' }}>
      <Icon name="lock" size={16} color="var(--muted)" />
      <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 600 }}>
        {msg || t('Sezione riservata al titolare.', 'This section is reserved to the owner.')}
      </span>
    </div>
  );
}

export function CopyField({ value, t, fireToast }) {
  const copy = () => {
    try { navigator.clipboard && navigator.clipboard.writeText(value); } catch { /* ignore */ }
    fireToast && fireToast({ msg: t('Copiato negli appunti', 'Copied to clipboard'), icon: 'check' });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 6px 0 12px', height: 40, background: 'var(--surface-2)' }}>
      <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      <button onClick={copy} className="dk-btn dk-btn--soft" style={{ height: 30, padding: '0 12px', fontSize: 12.5, flexShrink: 0 }} title={t('Copia', 'Copy')}>
        <Icon name="tag" size={13} />{t('Copia', 'Copy')}
      </button>
    </div>
  );
}

/* ---------------- condition builder (local copy — see note at top) ----------------
   Works directly on the API rule shape: { field, cmp, value }
   cmp ∈ eq,neq,lt,lte,gt,gte,contains */
const CMP_NUM = [['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['eq', '=']];

export function DkDrop({ value, onChange, options, narrow, missingLabel, loose }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    // Esc con il menu aperto chiude il menu e basta (preventDefault: vedi ui/layers.js)
    const k = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  // Un valore salvato che non è fra le opzioni si vede com'è, in evidenza: non
  // la prima opzione della lista (15-07).
  const cur = dropCurrent(options, value, { missingLabel, loose });
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title={cur.missing ? cur.label : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: narrow ? '0 10px' : '0 12px', border: '1px solid ' + (cur.missing ? 'var(--warn)' : 'var(--hair)'), borderRadius: 9, background: cur.missing ? 'var(--warn-tint)' : 'var(--surface)', cursor: 'pointer', fontSize: narrow ? 16 : 13.5, fontWeight: 700, color: cur.missing ? 'var(--warn)' : 'var(--ink)' }}>
        {cur.missing && <Icon name="alert" size={13} color="var(--warn)" />}{cur.label}<Icon name="chevD" size={13} color="var(--muted)" />
      </button>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, minWidth: narrow ? 64 : 200, padding: 5, zIndex: 30, boxShadow: 'var(--sh-pop)' }}>
          {options.map((o) => {
            const on = cur.option === o;
            return (
              <button key={String(o.value)} className="dk-row" onClick={() => { onChange(o.value); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 9px', borderRadius: 8, textAlign: 'left', cursor: 'pointer' }}>
                <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: narrow ? 15 : 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{o.label}</span>
                {on && <Icon name="check" size={14} color="var(--clay-ink)" stroke={2.4} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function DkCondRow({ rule, onChange, onRemove, t, lang, fields }) {
  const f = fields.find((x) => x.id === rule.field) || fields[0];
  const unitTxt = typeof f.unit === 'object' ? f.unit[lang] : f.unit;
  const onField = (fid) => {
    const nf = fields.find((x) => x.id === fid) || fields[0];
    if (nf.type === 'bool') onChange({ field: fid, cmp: 'eq', value: true });
    else if (nf.type === 'enum') onChange({ field: fid, cmp: nf.cmp || 'eq', value: nf.options.length ? nf.options[0].value : '' });
    else onChange({ field: fid, cmp: nf.defaultCmp || 'gt', value: nf.defaultValue != null ? nf.defaultValue : (nf.type === 'money' ? 100 : 1) });
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', padding: '11px 13px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--hair)' }}>
      <span style={{ fontWeight: 800, fontSize: 11.5, letterSpacing: '0.08em', color: 'var(--clay-ink)', background: 'var(--clay-tint)', padding: '3px 8px', borderRadius: 6 }}>{t('SE', 'IF')}</span>
      <DkDrop value={rule.field} onChange={onField} options={fields.map((x) => ({ value: x.id, label: x.label[lang] || x.label.it }))} />
      {f.type === 'bool' ? (
        <React.Fragment>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>{t('è', 'is')}</span>
          <DkSeg value={rule.value ? 'y' : 'n'} onChange={(v) => onChange({ value: v === 'y' })} options={[{ value: 'y', label: t('Sì', 'Yes') }, { value: 'n', label: 'No' }]} style={{ padding: 3 }} />
        </React.Fragment>
      ) : f.type === 'enum' ? (
        <React.Fragment>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--muted)' }}>{f.cmp === 'contains' ? t('include', 'includes') : t('è', 'is')}</span>
          <DkDrop value={rule.value} onChange={(v) => onChange({ value: v })} options={f.options} missingLabel={f.missingLabel} loose={f.loose} />
        </React.Fragment>
      ) : (
        <React.Fragment>
          <DkDrop value={rule.cmp} onChange={(v) => onChange({ cmp: v })} options={CMP_NUM.map(([k, s]) => ({ value: k, label: s }))} narrow />
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--hair)', borderRadius: 9, padding: '0 10px', height: 36, background: 'var(--surface)' }}>
            {f.type === 'money' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>}
            <NumInput integer min={0} value={rule.value} onChange={(value) => onChange({ value })} style={{ width: 52, border: 'none', outline: 'none', background: 'transparent', fontSize: 14.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} />
            {unitTxt && f.type !== 'money' && <span className="t-sm" style={{ color: 'var(--muted-2)', fontWeight: 700 }}>{unitTxt}</span>}
          </div>
        </React.Fragment>
      )}
      <div style={{ flex: 1 }} />
      <button className="dk-iconbtn" onClick={onRemove} aria-label="remove" style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 9, cursor: 'pointer', color: 'var(--muted)' }}><Icon name="x" size={16} /></button>
    </div>
  );
}
