// StepLabel — il numero del passo (1 cliente, 2 servizi, 3 orario) col suo
// titolo; il numero diventa una spunta quando il passo è fatto.
import { Icon } from '@youty/shared';

export default function StepLabel({ n, done, children, t }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <span style={{ width: 20, height: 20, borderRadius: 99, display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, background: done ? 'var(--ok)' : 'var(--ink)', color: '#fff' }} aria-label={done ? t('completato', 'done') : ''}>
        {done ? <Icon name="check" size={11} color="#fff" stroke={3} /> : n}
      </span>
      <span className="t-meta" style={{ color: 'var(--ink-2)' }}>{children}</span>
    </div>
  );
}
