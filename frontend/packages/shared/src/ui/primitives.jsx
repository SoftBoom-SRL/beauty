// primitives.jsx — shared UI primitives ported from prototype components.jsx + shared.jsx
import { useEffect } from 'react';
import { Icon } from './Icon.jsx';

/* ============================== AVATAR ============================== */
export function Avatar({ initials, size = 44, color, ring = false, img }) {
  const base = color || 'var(--paper-2)';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: img ? `center/cover ${base}` : 'var(--paper-2)',
      backgroundImage: img ? `url(${img})` : undefined,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--ink-2)', fontWeight: 700, fontSize: size * 0.34,
      border: ring ? `2px solid ${base}` : '1px solid var(--hair)',
      letterSpacing: '0.02em',
    }}>{!img && initials}</div>
  );
}

/* ============================== TOGGLE ============================== */
export function Toggle({ on, onChange }) {
  return <button className={'swt press' + (on ? ' swt--on' : '')} onClick={() => onChange(!on)} aria-pressed={on} />;
}

/* ============================== MISC VIZ ============================== */
export function Sparkline({ data, w = 120, h = 34, color = 'var(--clay)', fill = true }) {
  const min = Math.min(...data), max = Math.max(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / rng) * (h - 6) - 3]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L${w} ${h} L0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
      {fill && <path d={area} fill={color} opacity="0.1" />}
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={color} />
    </svg>
  );
}

export function ProgressBar({ value, color = 'var(--clay)', track = 'var(--paper-2)', h = 8, animate = true }) {
  return (
    <div style={{ height: h, borderRadius: 99, background: track, overflow: 'hidden', width: '100%' }}>
      <div style={{ height: '100%', width: Math.min(100, value) + '%', background: color, borderRadius: 99, animation: animate ? 'growW 800ms var(--ease-emph)' : 'none' }} />
    </div>
  );
}

export function Delta({ value, invert = false, light = false }) {
  const up = value >= 0;
  const good = invert ? !up : up;
  const c = good ? 'var(--ok)' : 'var(--danger)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: light ? (up ? '#A7C4A0' : '#E0A59E') : c, fontWeight: 700, fontSize: 13 }}>
      <Icon name={up ? 'arrowUp' : 'arrowDn'} size={13} stroke={2.4} />
      {Math.abs(value)}%
    </span>
  );
}

/* ============================== LAYOUT HELPERS ============================== */
export function EmptyState({ icon, title, sub, action, onAction }) {
  return (
    <div style={{ textAlign: 'center', padding: '40px 24px' }}>
      <div style={{ width: 64, height: 64, borderRadius: 20, background: 'var(--paper-2)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
        <Icon name={icon} size={28} color="var(--muted-2)" />
      </div>
      <div className="t-title" style={{ marginBottom: 6 }}>{title}</div>
      {sub && <div className="t-body" style={{ color: 'var(--muted)', maxWidth: 240, margin: '0 auto 16px' }}>{sub}</div>}
      {action && <button className="btn btn--clay press" onClick={onAction} style={{ margin: '0 auto' }}>{action}</button>}
    </div>
  );
}

/* ============================== TOAST ============================== */
/** Mobile-style toast (absolute within the app frame). Use with useToastHost:
 *    const { fireToast, toastProps } = useToastHost();
 *    ... <Toast {...toastProps} />
 *  fireToast({ msg, icon?, undo?: 'Annulla', undoFn?: () => {} })
 */
export function Toast({ toast, onUndo, onDone }) {
  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(onDone, toast.undo ? 4200 : 2600);
    return () => clearTimeout(tm);
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div style={{
      position: 'absolute', left: 16, right: 16, bottom: 'calc(var(--safe-bottom) + 86px)', zIndex: 300,
      background: 'var(--ink)', color: '#fff', borderRadius: 'var(--r-md)', padding: '13px 16px',
      display: 'flex', alignItems: 'center', gap: 12, boxShadow: 'var(--sh-pop)',
      animation: 'slideUp 280ms var(--ease-emph)',
    }}>
      {toast.icon && <Icon name={toast.icon} size={19} color="#fff" />}
      <div style={{ flex: 1, fontSize: 14, fontWeight: 500, lineHeight: 1.35 }}>{toast.msg}</div>
      {toast.undo && (
        <button className="press" onClick={onUndo} style={{ color: 'var(--clay-tint)', fontWeight: 700, fontSize: 14, letterSpacing: '0.02em' }}>{toast.undo}</button>
      )}
    </div>
  );
}
