// controls.jsx — small local controls for the Automazioni builder.
// Il menu a tendina dei campi e degli operatori è quello comune, ui/DkDrop.jsx.
import { useCallback, useRef, useState } from 'react';
import { Icon, NumInput } from '@youty/shared';
import { useClickAway } from '../../hooks/useClickAway.js';

/* ---- number stepper for the timing offset ---- */
export function DkStepper({ value, onChange }) {
  const dec = () => onChange(Math.max(0, value - 1));
  const inc = () => onChange(value + 1);
  const btn = { width: 34, height: 40, display: 'grid', placeItems: 'center', cursor: 'pointer', color: 'var(--ink)', background: 'transparent' };
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', border: '1px solid var(--hair)', borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
      <button style={btn} onClick={dec} aria-label="−"><span style={{ fontSize: 19, fontWeight: 600, lineHeight: 1 }}>−</span></button>
      <NumInput integer min={0} value={value} onChange={onChange} style={{ width: 44, textAlign: 'center', border: 'none', borderLeft: '1px solid var(--hair)', borderRight: '1px solid var(--hair)', outline: 'none', background: 'transparent', fontSize: 15, fontWeight: 700, height: 40, fontVariantNumeric: 'tabular-nums' }} />
      <button style={btn} onClick={inc} aria-label="+"><span style={{ fontSize: 18, fontWeight: 600, lineHeight: 1 }}>+</span></button>
    </div>
  );
}

/* ---- read-only field with copy button (webhook url) ---- */
export function DkCopyField({ value, onCopy, t }) {
  const copy = () => {
    try { navigator.clipboard && navigator.clipboard.writeText(value); } catch { /* ignore */ }
    if (onCopy) onCopy();
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hair)', borderRadius: 10, padding: '0 6px 0 12px', height: 42, background: 'var(--surface-2)' }}>
      <span style={{ flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      <button onClick={copy} className="dk-btn dk-btn--soft" style={{ height: 32, padding: '0 12px', fontSize: 12.5, flexShrink: 0 }} title={t('Copia', 'Copy')}><Icon name="tag" size={14} />{t('Copia', 'Copy')}</button>
    </div>
  );
}

/* ---- trigger sub-step shell (labelled a / b / c) ---- */
export function DkTrigStep({ n, title, hint, children, last }) {
  return (
    <div className="dk-card" style={{ padding: '16px 20px 18px', marginBottom: last ? 0 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 26, height: 26, borderRadius: 8, background: 'var(--ink)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0, fontFamily: 'var(--serif)' }}>{n}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1 }}>{hint}</div>
        </div>
      </div>
      <div style={{ paddingLeft: 38 }}>{children}</div>
    </div>
  );
}

/* ---- mini reporting metric card ---- */
export function MiniMetric({ label, value, sub, wide }) {
  return (
    <div className="dk-card" style={{ padding: '12px 16px', boxShadow: 'none', border: '1.5px solid var(--hair)', flex: wide ? 2 : 1, textAlign: 'left' }}>
      <div className="t-meta" style={{ marginBottom: 4 }}>{label}</div>
      <div className="t-num" style={{ fontSize: 22 }}>{value}</div>
      {sub && <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

/* ---- event selector dropdown (events from the API catalog) ---- */
export function DkEventMenu({ value, onChange, events, icons, t, lang }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useClickAway(ref, open, close);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button className="dk-btn dk-btn--soft" style={{ height: 38, fontSize: 13.5 }} onClick={() => setOpen((o) => !o)}><Icon name="edit" size={15} />{t('Cambia', 'Change')}</button>
      {open && (
        <div className="dk-card" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 300, padding: 6, zIndex: 30, boxShadow: 'var(--sh-pop)' }}>
          {events.map((e) => {
            const on = e.value === value;
            return (
              <button key={e.value} className="dk-row" onClick={() => { onChange(e.value); setOpen(false); }} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', borderRadius: 9, textAlign: 'left' }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: on ? 'var(--clay-tint)' : 'var(--surface-2)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={icons(e.value)} size={16} color={on ? 'var(--clay-ink)' : 'var(--muted)'} /></div>
                <span style={{ flex: 1, fontWeight: on ? 700 : 600, fontSize: 13.5, color: on ? 'var(--ink)' : 'var(--ink-2)' }}>{lang === 'en' ? e.label_en : e.label_it}</span>
                {on && <Icon name="check" size={15} color="var(--clay-ink)" stroke={2.4} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
