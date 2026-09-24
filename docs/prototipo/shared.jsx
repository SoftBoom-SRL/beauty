// shared.jsx — app context + cross-screen helpers
const AppCtx = React.createContext(null);
const useApp = () => React.useContext(AppCtx);

// currency / time / duration formatting
function fmtEur(n, lang) {
  if (n === 0) return lang === 'en' ? 'Free' : 'Gratis';
  return '€' + n.toLocaleString(lang === 'en' ? 'en-GB' : 'it-IT');
}
function timeLabel(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function fmtDur(min, lang) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
const svcName = (s, lang) => s.name[lang] || s.name.it;
const catName = (c, lang) => c.name[lang] || c.name.it;

// appointment status metadata
function statusMeta(status, t) {
  switch (status) {
    case 'checkin':    return { label: t('Check-in', 'Checked in'), color: 'var(--ok)',     tint: 'var(--ok-tint)',     icon: 'check' };
    case 'corso':      return { label: t('In corso', 'In progress'), color: 'var(--info)',   tint: 'var(--info-tint)',   icon: 'clock' };
    case 'arrivo':     return { label: t('In arrivo', 'Arriving'),    color: 'var(--warn)',   tint: 'var(--warn-tint)',   icon: 'mapPin' };
    case 'noshow':     return { label: t('No-show', 'No-show'),       color: 'var(--danger)', tint: 'var(--danger-tint)', icon: 'alert' };
    default:           return { label: t('Confermato', 'Confirmed'),  color: 'var(--muted)',  tint: 'var(--paper-2)',     icon: 'calendar' };
  }
}
function depositMeta(dep, t) {
  if (dep === 'paid') return { label: t('Deposito versato', 'Deposit paid'), color: 'var(--ok)', dot: 'var(--ok)' };
  if (dep === 'req')  return { label: t('Deposito richiesto', 'Deposit due'), color: 'var(--warn)', dot: 'var(--warn)' };
  return null;
}
function segMeta(seg, t) {
  switch (seg) {
    case 'vip':       return { label: 'VIP', color: 'var(--op-lina)' };
    case 'fedele':    return { label: t('Fedele', 'Loyal'), color: 'var(--ok)' };
    case 'nuovo':     return { label: t('Nuovo', 'New'), color: 'var(--info)' };
    case 'dormiente': return { label: t('Dormiente', 'Dormant'), color: 'var(--muted-2)' };
    default:          return { label: seg, color: 'var(--muted)' };
  }
}

// section label
function SectionLabel({ children, action, onAction }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '0 0 12px' }}>
      <div className="t-meta">{children}</div>
      {action && <button className="press" onClick={onAction} style={{ fontSize: 13, fontWeight: 600, color: 'var(--clay-ink)' }}>{action}</button>}
    </div>
  );
}

// empty-state block
function EmptyState({ icon, title, sub, action, onAction }) {
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

// generic full-screen sub-view header with back
function SubHeader({ title, onBack, right, sub }) {
  return (
    <div style={{
      paddingTop: 'var(--safe-top)', padding: '0 16px', background: 'var(--paper)',
      position: 'sticky', top: 0, zIndex: 30,
    }}>
      <div style={{ paddingTop: 'var(--safe-top)' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12 }}>
        <button className="press" onClick={onBack} style={{ width: 40, height: 40, marginLeft: -6, borderRadius: 99, display: 'grid', placeItems: 'center' }}>
          <Icon name="chevL" size={24} />
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-h3" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</div>
          {sub && <div className="t-sm" style={{ color: 'var(--muted)' }}>{sub}</div>}
        </div>
        {right}
      </div>
    </div>
  );
}

Object.assign(window, {
  AppCtx, useApp, fmtEur, timeLabel, fmtDur, svcName, catName,
  statusMeta, depositMeta, segMeta, SectionLabel, EmptyState, SubHeader,
});
