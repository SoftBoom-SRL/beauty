// RailPanel — la colonna di destra della sezione, apribile e richiudibile:
// aperta mostra `children` (RightRail), chiusa una striscia sottile con le
// sue voci e i numeri che chiedono un'azione (slot liberati da richiamare,
// lista d'attesa): chiusa non deve voler dire dimenticata.
import { Icon } from '@youty/shared';

export default function RailPanel({ open, setOpen, t, badges = {}, children }) {
  if (open) {
    return (
      <aside className="dk-rail" style={{ width: 'var(--rail-w)', flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', overflowY: 'auto', padding: '10px 22px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button className="dk-rail-toggle" onClick={() => setOpen(false)} title={t('Comprimi pannello', 'Collapse panel')} style={{ width: 28, height: 28, border: 'none' }}><Icon name="chevR" size={15} /></button>
        </div>
        {children}
      </aside>
    );
  }
  const items = [
    { icon: 'wallet', label: t('Riepilogo di cassa', 'Cash-up'), n: 0 },
    { icon: 'alert', label: t('Slot liberati da richiamare', 'Released slots to call back'), n: badges.released || 0, tone: 'warn' },
    { icon: 'clients', label: t('Lista d\'attesa', 'Waitlist'), n: badges.waitlist || 0 },
  ].filter((x) => x.icon !== 'alert' || x.n > 0);
  return (
    <aside style={{ width: 52, flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 6 }}>
      <button className="dk-rail-toggle" onClick={() => setOpen(true)} title={t('Espandi pannello', 'Expand panel')} style={{ width: 28, height: 28, border: 'none', marginBottom: 6 }}><Icon name="chevL" size={15} /></button>
      {items.map((x) => (
        <button key={x.icon} type="button" onClick={() => setOpen(true)} title={x.label + (x.n ? ` · ${x.n}` : '')} aria-label={x.label + (x.n ? ` · ${x.n}` : '')}
          className="dk-agicon" style={{ position: 'relative', width: 36, height: 36, color: x.tone === 'warn' && x.n ? 'var(--warn)' : 'var(--muted)' }}>
          <Icon name={x.icon} size={18} />
          {x.n > 0 && (
            <span className="tabnum" style={{ position: 'absolute', top: 1, right: 0, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 99, background: x.tone === 'warn' ? 'var(--warn)' : 'var(--clay)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'grid', placeItems: 'center', boxSizing: 'border-box' }}>{x.n}</span>
          )}
        </button>
      ))}
    </aside>
  );
}
