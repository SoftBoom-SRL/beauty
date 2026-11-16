// ExclusiveSub.jsx — Promozioni → Exclusive Card: le iscritte con la scadenza,
// filtro «in scadenza» (entro 30 giorni) per chiamarle a rinnovare. Si iscrive
// e si rinnova dalla scheda cliente (Portafoglio); quote e sconto in
// Impostazioni → Exclusive Card.
import { useState } from 'react';
import { EmptyState, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { useResource } from '../../hooks/useResource.js';
import { exclusiveApi } from '../../api/marketing.js';
import { dateLabel } from '../clienti/helpers.js';

export default function ExclusiveSub() {
  const { t, lang, settings, fireToast } = useDash();
  const [status, setStatus] = useState('expiring');
  const { data, loading } = useResource(() => exclusiveApi.list(status ? { status } : {}), [status], {
    fallback: [], onError: (err) => toastApiError(err, fireToast, t),
  });
  const rows = data || [];
  const filters = [
    ['expiring', t('In scadenza (30 giorni)', 'Expiring (30 days)')],
    ['active', t('Attive', 'Active')],
    ['expired', t('Scadute', 'Expired')],
    ['', t('Tutte', 'All')],
  ];
  const left = (r) => (!r.active ? t(`scaduta da ${-r.days_left} gg`, `expired ${-r.days_left} d ago`)
    : r.days_left === 0 ? t('scade oggi', 'expires today') : t(`${r.days_left} gg`, `${r.days_left} d`));

  return (
    <div>
      {!settings?.exclusive_card?.enabled && (
        <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12 }}>
          {t('La Exclusive Card non è attiva: si attiva in Impostazioni → Exclusive Card.', 'The Exclusive Card is off: turn it on in Settings → Exclusive Card.')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {filters.map(([k, l]) => (
          <button key={k || 'all'} type="button" className="dk-pill" aria-pressed={status === k} onClick={() => setStatus(k)}
            style={{ padding: '6px 12px', fontSize: 12.5, fontWeight: 700, background: status === k ? 'var(--info)' : undefined, borderColor: status === k ? 'var(--info)' : undefined, color: status === k ? '#fff' : undefined }}>{l}</button>
        ))}
      </div>
      {loading && !rows.length ? <div className="skel" style={{ height: 70, borderRadius: 12 }} />
        : !rows.length ? <EmptyState icon="star" title={t('Nessuna iscritta', 'No members')} />
        : (
          <div className="dk-card" style={{ padding: 0, boxShadow: 'none', border: '1px solid var(--hair)' }}>
            {rows.map((r, i) => (
              <div key={r.id} data-exclusive-row="" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? '1px solid var(--hair)' : 'none', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 140 }}>
                  <div style={{ fontWeight: 700 }}>{r.client_name}</div>
                  <div className="t-sm" style={{ color: 'var(--muted)' }}>{r.phone || '—'}</div>
                </div>
                <div className="t-sm" style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700 }}>{t('Scade il ', 'Expires ')}{dateLabel(r.expires_on, lang)}</div>
                  <div style={{ color: r.active ? (r.days_left <= 30 ? 'var(--warn, var(--clay-ink))' : 'var(--ok)') : 'var(--muted-2)' }}>{left(r)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
