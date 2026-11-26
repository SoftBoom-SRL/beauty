// ExclusiveSub.jsx — Promozioni → Exclusive Card: le iscritte con la scadenza,
// filtro «in scadenza» (entro 30 giorni) per chiamarle a rinnovare. Si iscrive
// e si rinnova dalla scheda cliente (Portafoglio) e anche da qui con «Nuova
// Exclusive Card»: chi apriva questa sezione per crearne una non trovava il
// pulsante. Quote e sconto in Impostazioni → Exclusive Card.
import { useState } from 'react';
import { EmptyState, Icon, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { useResource } from '../../hooks/useResource.js';
import { exclusiveApi } from '../../api/marketing.js';
import { dateLabel } from '../clienti/helpers.js';
import ExclusiveCardBox from '../clienti/tabs/ExclusiveCardBox.jsx';
import ClientPicker from './ClientPicker.jsx';

export default function ExclusiveSub() {
  const { t, lang, settings, hasScope, fireToast } = useDash();
  const [status, setStatus] = useState('expiring');
  const [rev, setRev] = useState(0);
  const [adding, setAdding] = useState(null);   // null chiuso, {} senza cliente, { client } scelta
  const canSell = !!settings?.exclusive_card?.enabled && hasScope('sales');
  const { data, loading } = useResource(() => exclusiveApi.list(status ? { status } : {}), [status, rev], {
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
      {canSell && (adding ? (
        <div data-exclusive-new="" className="dk-card" style={{ padding: '14px 16px', boxShadow: 'none', border: '1px solid var(--hair)', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{ flex: 1, fontWeight: 700 }}>{t('Nuova Exclusive Card', 'New Exclusive Card')}</div>
            <button className="dk-iconbtn" aria-label={t('Chiudi', 'Close')} onClick={() => setAdding(null)}><Icon name="x" size={18} /></button>
          </div>
          <ClientPicker client={adding.client || null} onChange={(client) => setAdding({ client })}
            placeholder={t('Cerca la cliente da iscrivere…', 'Search the client to enrol…')} t={t} />
          {adding.client && (
            <div style={{ marginTop: 12 }}>
              <ExclusiveCardBox key={adding.client.id} clientId={adding.client.id} autoOpen
                onSubscribed={() => { setAdding(null); setRev((n) => n + 1); }} />
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="dk-btn dk-btn--clay" onClick={() => setAdding({})}>
            <Icon name="plus" size={16} color="#fff" />{t('Nuova Exclusive Card', 'New Exclusive Card')}
          </button>
        </div>
      ))}
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
