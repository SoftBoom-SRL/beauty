// RailPanel — la colonna di destra della sezione, apribile e richiudibile:
// aperta mostra `children` (RightRail), chiusa solo il bottone per riaprirla.
import { Icon } from '@youty/shared';

export default function RailPanel({ open, setOpen, t, children }) {
  if (open) {
    return (
      <aside className="dk-rail" style={{ width: 'var(--rail-w)', flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', overflowY: 'auto', padding: '14px 22px 22px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button className="dk-rail-toggle" onClick={() => setOpen(false)} title={t('Comprimi pannello', 'Collapse panel')} style={{ width: 30, height: 30, border: 'none' }}><Icon name="chevR" size={16} /></button>
        </div>
        {children}
      </aside>
    );
  }
  return (
    <aside style={{ width: 52, flexShrink: 0, borderLeft: '1px solid var(--hair)', background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 14, gap: 4 }}>
      <button className="dk-rail-toggle" onClick={() => setOpen(true)} title={t('Espandi pannello', 'Expand panel')} style={{ width: 30, height: 30, border: 'none' }}><Icon name="chevL" size={16} /></button>
      <Icon name="calendar" size={18} color="var(--muted-2)" style={{ marginTop: 10 }} />
    </aside>
  );
}
