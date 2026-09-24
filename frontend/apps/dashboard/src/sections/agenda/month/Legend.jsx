// Legend — la legenda dell'occupazione del mese: libero, carico, pieno, con
// le soglie di monthLib.
import { LOAD_FULL, LOAD_TONES, LOAD_WARN } from '../monthLib.js';

export default function Legend({ t }) {
  const items = [
    ['ok', t('Libero', 'Light'), `< ${Math.round(LOAD_WARN * 100)}%`],
    ['warn', t('Carico', 'Busy'), `${Math.round(LOAD_WARN * 100)}–${Math.round(LOAD_FULL * 100)}%`],
    ['full', t('Pieno', 'Full'), `> ${Math.round(LOAD_FULL * 100)}%`],
  ];
  return (
    <div role="group" aria-label={t('Legenda occupazione', 'Occupancy legend')} style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 6 }}>
      {items.map(([tone, label, range]) => (
        <span key={tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
          <span style={{ width: 8, height: 8, borderRadius: 99, background: LOAD_TONES[tone].color }} />
          {label} <span className="tabnum" style={{ color: 'var(--muted-2)', fontWeight: 500 }}>{range}</span>
        </span>
      ))}
    </div>
  );
}
