// components.jsx — shared primitives & icon set for yourang
const { useState, useEffect, useRef } = React;

/* ============================== ICONS ============================== */
const ICON_PATHS = {
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>',
  clients: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5c0-3.2 2.6-5 5.5-5s5.5 1.8 5.5 5"/><path d="M16 5.5a3 3 0 010 5.6M16.5 14.7c2.4.3 4 1.9 4 4.8"/>',
  insights: '<path d="M4 19V5M4 19h16"/><path d="M7.5 15l3-4 3 2.5 4-6"/>',
  bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.4 2"/>',
  mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3.5"/>',
  chevR: '<path d="M9 5l7 7-7 7"/>',
  chevL: '<path d="M15 5l-7 7 7 7"/>',
  chevD: '<path d="M5 9l7 7 7-7"/>',
  chevU: '<path d="M5 15l7-7 7 7"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  phone: '<path d="M6 3.5c1 0 1.7.5 2 1.5l1 2.6c.3.8.1 1.4-.5 1.9l-1 .8c1 2 2.4 3.4 4.4 4.4l.8-1c.5-.6 1.1-.8 1.9-.5l2.6 1c1 .3 1.5 1 1.5 2 0 2.4-2 3.8-4.2 3.3C9.4 18.7 5.3 14.6 3.7 8.2 3.2 6 4.6 3.5 6 3.5z"/>',
  whatsapp: '<path d="M12 3.5a8.5 8.5 0 00-7.3 12.8L3.5 20.5l4.4-1.1A8.5 8.5 0 1012 3.5z"/><path d="M8.6 8.2c.2-.5.4-.5.7-.5h.5c.2 0 .4 0 .6.5l.7 1.6c.1.2 0 .4-.1.6l-.5.6c-.1.2-.2.3 0 .6.3.5.8 1.2 1.5 1.7.6.4.9.5 1.1.4l.6-.5c.2-.2.4-.2.6-.1l1.5.8c.2.1.3.3.3.5 0 1-1 1.8-1.6 1.8-1.5 0-3.5-1.1-4.8-2.5-1.2-1.3-2-2.9-2-4 0-.8.4-1.5 1.1-1.8z" fill="currentColor" stroke="none"/>',
  message: '<path d="M4 5.5h16v11H8l-4 3.5z" /><path d="M8 9.5h8M8 12.5h5"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/><path d="M4 6.5l8 6.5 8-6.5"/>',
  bell: '<path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9z"/><path d="M10 18.5a2 2 0 004 0"/>',
  star: '<path d="M12 3.5l2.5 5.3 5.5.7-4 3.9 1 5.6L12 17l-5 2.9 1-5.6-4-3.9 5.5-.7z"/>',
  cake: '<path d="M4 20.5h16v-7H4z"/><path d="M4 16.5c1.3 0 1.3 1.2 2.7 1.2s1.3-1.2 2.6-1.2 1.3 1.2 2.7 1.2 1.3-1.2 2.7-1.2 1.3 1.2 2.6 1.2"/><path d="M8 13.5v-3M12 13.5v-3M16 13.5v-3M8 7.5v.5M12 7.5v.5M16 7.5v.5"/>',
  gift: '<rect x="4" y="9" width="16" height="4" rx="1"/><path d="M5 13v7.5h14V13M12 9v11.5"/><path d="M12 9C12 6 10.5 5 9 5s-2 2.5 3 4zM12 9c0-3 1.5-4 3-4s2 2.5-3 4z"/>',
  revive: '<path d="M20 12a8 8 0 11-2.3-5.6"/><path d="M20 4v3.5h-3.5"/>',
  gap: '<rect x="3.5" y="5" width="6" height="14" rx="1.5"/><rect x="14.5" y="5" width="6" height="14" rx="1.5"/><path d="M12 9v6M12 9l-1.4 1.4M12 9l1.4 1.4"/>',
  scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18M8 16.5 20 6"/>',
  camera: '<path d="M3.5 8.5h3l1.5-2.2h6L15.5 8.5h3v10.5H3.5z" /><circle cx="11" cy="13.5" r="3.3"/>',
  box: '<path d="M12 3.5 20.5 8v8L12 20.5 3.5 16V8z"/><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8"/>',
  barcode: '<path d="M4 6v12M7 6v12M10 6v9M13 6v12M16 6v9M20 6v12"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.5 5.5l-2 2M7.5 16.5l-2 2M18.5 18.5l-2-2M7.5 7.5l-2-2"/>',
  palette: '<path d="M12 3.5c-4.7 0-8.5 3.6-8.5 8s3.4 7 7 7c1.6 0 2-1 1.6-2-.4-1.2.3-2 1.4-2H16c2.6 0 4.5-1.7 4.5-4.5 0-3.6-3.8-6.5-8.5-6.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="11" cy="7.5" r="1"/><circle cx="15.5" cy="8" r="1"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.3 2.5 14.7 0 17M12 3.5c-2.5 2.3-2.5 14.7 0 17"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDn: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  undo: '<path d="M9 7H6.5a3.5 3.5 0 100 7H12"/><path d="M9 4 6 7l3 3"/>',
  send: '<path d="M4 12 20.5 4.5 16 20.5l-4-6z"/><path d="M12 14.5 20.5 4.5"/>',
  edit: '<path d="M5 19h3l9-9-3-3-9 9z"/><path d="M14 6l3 3"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  play: '<path d="M7 4.5 19 12 7 19.5z" fill="currentColor" stroke="none"/>',
  mapPin: '<path d="M12 21s7-6 7-11a7 7 0 10-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.5"/>',
  alert: '<path d="M12 3.5 21.5 20H2.5z"/><path d="M12 9.5v4.5M12 17v.5"/>',
  wallet: '<rect x="3.5" y="6" width="17" height="13" rx="2.5"/><path d="M3.5 10h17M16 14.5h1.5"/>',
  coupon: '<path d="M3.5 7.5h17v3a1.5 1.5 0 000 3v3h-17v-3a1.5 1.5 0 000-3z"/><path d="M13 7.5v9" stroke-dasharray="1.5 2.5"/>',
  heart: '<path d="M12 20s-7-4.3-7-9.5A4 4 0 0112 8a4 4 0 017 2.5C19 15.7 12 20 12 20z"/>',
  leaf: '<path d="M5 19C4 11 9 5 20 5c0 11-6 16-14 15-1-3 .5-7 4-9"/>',
  drop: '<path d="M12 3.5S5.5 11 5.5 15a6.5 6.5 0 0013 0C18.5 11 12 3.5 12 3.5z"/>',
  filter: '<path d="M3.5 5.5h17l-6.5 8v5l-4 2v-7z"/>',
  drag: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  ext: '<path d="M14 4.5h5.5V10M19 5l-8 8M16 13v6.5H4.5V8H11"/>',
  wand: '<path d="M5 19 15 9M17 7l1.5-1.5M14 4l.5-2M19 9l2-.5M17.5 11.5 19 13M11.5 6.5 13 8"/>',
  bulb: '<path d="M9 17.5h6M9.5 20.5h5"/><path d="M12 3.5A6 6 0 006 9.5c0 2.4 1.5 3.7 2.5 5h7c1-1.3 2.5-2.6 2.5-5a6 6 0 00-6-6z"/>',
  refresh: '<path d="M20 11a8 8 0 10-1 4"/><path d="M20 5v6h-6"/>',
  sparkle: '<path d="M12 3.5l1.6 5.4 5.4 1.6-5.4 1.6L12 17.5l-1.6-5.4L5 10.5l5.4-1.6z"/><path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />',
  trend: '<path d="M3.5 16.5 9 11l3.5 3 8-8.5"/><path d="M14 5.5h6.5V12"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.8 3-6 7-6s7 2.2 7 6"/>',
  home: '<path d="M4 11 12 4l8 7M6 9.5V20h12V9.5"/>',
  list: '<path d="M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01"/>',
  moon: '<path d="M20 13.5A8 8 0 119.5 4 6.5 6.5 0 0020 13.5z"/>',
  voice: '<path d="M4 12v0M8 8v8M12 5v14M16 8v8M20 11v2"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2.2"/><path d="M7.8 10V7.2a4.2 4.2 0 018.4 0V10"/>',
  tag: '<path d="M4 4.5h7.5L20 13l-7 7-8.5-8.5z"/><circle cx="8.5" cy="9" r="1.3" fill="currentColor" stroke="none"/>',
};

function Icon({ name, size = 22, color = 'currentColor', stroke = 1.7, style = {}, className }) {
  const d = ICON_PATHS[name] || '';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}
      stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block', ...style }}
      dangerouslySetInnerHTML={{ __html: d }} />
  );
}

/* ============================== AVATAR ============================== */
function Avatar({ initials, size = 44, color, ring = false, img }) {
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

/* ============================== CHIP / SEG ============================== */
function Chip({ children, active, onClick, icon, style = {} }) {
  return (
    <button className={'chip press' + (active ? ' chip--active' : '')} onClick={onClick} style={style}>
      {icon && <Icon name={icon} size={15} stroke={1.9} />}
      {children}
    </button>
  );
}

function SegBar({ options, value, onChange, style = {} }) {
  return (
    <div style={{ display: 'flex', background: 'var(--paper-2)', borderRadius: 'var(--r-pill)', padding: 3, gap: 2, ...style }}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onChange(o.value)} className="press"
            style={{
              flex: 1, height: 36, borderRadius: 'var(--r-pill)', fontSize: 13.5, fontWeight: 600,
              color: active ? 'var(--ink)' : 'var(--muted)',
              background: active ? 'var(--surface)' : 'transparent',
              boxShadow: active ? 'var(--sh-sm)' : 'none', transition: 'all 180ms var(--ease)',
            }}>{o.label}</button>
        );
      })}
    </div>
  );
}

/* ============================== TOGGLE ============================== */
function Toggle({ on, onChange }) {
  return <button className={'swt press' + (on ? ' swt--on' : '')} onClick={() => onChange(!on)} aria-pressed={on} />;
}

/* ============================== BOTTOM SHEET ============================== */
function Sheet({ open, onClose, children, title, full = false, dark = false }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, zIndex: 200, display: 'flex', flexDirection: 'column',
      justifyContent: 'flex-end', background: 'rgba(33,28,24,0.42)', backdropFilter: 'blur(3px)',
      animation: 'fadeIn 200ms var(--ease)',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: dark ? 'var(--ink)' : 'var(--surface)', color: dark ? '#fff' : 'var(--ink)',
        borderRadius: '26px 26px 0 0', maxHeight: full ? 'calc(100% - 40px)' : '88%',
        boxShadow: 'var(--sh-sheet)', display: 'flex', flexDirection: 'column',
        animation: 'sheetUp 340ms var(--ease-emph)', paddingBottom: 'calc(var(--safe-bottom) + 8px)',
        overflow: 'hidden',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 10 }}>
          <div style={{ width: 40, height: 4.5, borderRadius: 99, background: dark ? 'rgba(255,255,255,0.25)' : 'var(--faint)' }} />
        </div>
        {title && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px 6px' }}>
            <div className="t-title">{title}</div>
            <button className="press" onClick={onClose} style={{ width: 34, height: 34, borderRadius: 99, background: dark ? 'rgba(255,255,255,0.1)' : 'var(--paper-2)', display: 'grid', placeItems: 'center' }}>
              <Icon name="x" size={18} />
            </button>
          </div>
        )}
        <div className="scroll" style={{ overflowY: 'auto', padding: '6px 20px 20px' }}>{children}</div>
      </div>
    </div>
  );
}

/* ============================== TOAST / UNDO ============================== */
function Toast({ toast, onUndo, onDone }) {
  useEffect(() => {
    if (!toast) return;
    const tm = setTimeout(onDone, toast.undo ? 4200 : 2600);
    return () => clearTimeout(tm);
  }, [toast]);
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

/* ============================== MISC VIZ ============================== */
function Sparkline({ data, w = 120, h = 34, color = 'var(--clay)', fill = true }) {
  const min = Math.min(...data), max = Math.max(...data);
  const rng = max - min || 1;
  const pts = data.map((v, i) => [ (i / (data.length - 1)) * w, h - ((v - min) / rng) * (h - 6) - 3 ]);
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

function ProgressBar({ value, color = 'var(--clay)', track = 'var(--paper-2)', h = 8, animate = true }) {
  return (
    <div style={{ height: h, borderRadius: 99, background: track, overflow: 'hidden', width: '100%' }}>
      <div style={{ height: '100%', width: Math.min(100, value) + '%', background: color, borderRadius: 99, animation: animate ? 'growW 800ms var(--ease-emph)' : 'none' }} />
    </div>
  );
}

function Delta({ value, invert = false, light = false }) {
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

Object.assign(window, {
  Icon, Avatar, Chip, SegBar, Toggle, Sheet, Toast, Sparkline, ProgressBar, Delta,
});
