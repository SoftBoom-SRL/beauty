// StoricoSub.jsx — global movement history: GET /api/inventory/movements
// (paginated, server-side kind/date filters). MOVE_META styling per kind.
import React, { useEffect, useMemo, useState } from 'react';
import { api, EmptyState, Icon, mediaUrl } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { MOVE_META, errMsg, fmtQty, fmtWhen, num } from './lib.js';
import { Pager, SkelRows } from './bits.jsx';

const PAGE = 30;

export default function StoricoSub({ allProds }) {
  const { t, lang, fireToast } = useDash();
  const [kindF, setKindF] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null); // {items, count}
  const [loading, setLoading] = useState(true);

  const prodById = useMemo(() => {
    const m = new Map();
    (allProds || []).forEach((p) => m.set(p.id, p));
    return m;
  }, [allProds]);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api.get('/api/inventory/movements', {
      params: {
        kind: kindF !== 'all' ? kindF : undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        limit: PAGE, offset,
      },
    })
      .then((r) => { if (!dead) setData(r); })
      .catch((err) => { if (!dead) { setData({ items: [], count: 0 }); fireToast({ msg: errMsg(err, t), icon: 'alert' }); } })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [kindF, dateFrom, dateTo, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  const tabs = [
    ['all', t('Tutti', 'All')],
    ['load', t('Carico', 'Stock in')],
    ['sale', t('Vendite', 'Sales')],
    ['internal_use', t('Uso interno', 'Internal use')],
    ['adjustment', t('Rettifiche', 'Adjustments')],
    ['transfer', t('Trasferimenti', 'Transfers')],
    ['return_supplier', t('Resi', 'Returns')],
  ];
  const dateCss = { border: '1px solid var(--hair)', borderRadius: 9, outline: 'none', fontSize: 13, padding: '7px 10px', fontFamily: 'var(--sans)', background: 'var(--surface)', color: 'var(--ink-2)' };
  const items = data?.items || [];

  return (
    <React.Fragment>
      <div style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {tabs.map(([k, l]) => {
          const on = kindF === k;
          return <button key={k} onClick={() => { setKindF(k); setOffset(0); }} style={{ padding: '7px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>;
        })}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="t-meta">{t('Dal', 'From')}</span>
          <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setOffset(0); }} style={dateCss} />
          <span className="t-meta">{t('Al', 'To')}</span>
          <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setOffset(0); }} style={dateCss} />
          {(dateFrom || dateTo) && (
            <button className="dk-iconbtn" onClick={() => { setDateFrom(''); setDateTo(''); setOffset(0); }} title={t('Azzera date', 'Clear dates')} style={{ width: 32, height: 32, borderRadius: 9 }}><Icon name="x" size={14} /></button>
          )}
        </div>
      </div>

      <div className="dk-card" style={{ overflow: 'hidden' }}>
        {data === null && loading ? (
          <SkelRows n={6} />
        ) : (
          <React.Fragment>
            <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity 120ms' }}>
              {items.map((m, i) => {
                const meta = MOVE_META[m.kind] || MOVE_META.adjustment;
                const d = num(m.qty);
                const unit = prodById.get(m.product_id)?.package_unit || t('unità', 'units');
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 20px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 10, background: meta.tint, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={meta.icon} size={16} color={meta.color} /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.product_name}</div>
                      <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {meta[lang]}{m.reason ? ' · ' + m.reason : ''}{m.operator_name ? ` · ${t('operatrice', 'stylist')} ${m.operator_name}` : ''}{m.order_id ? ` · ${t('ordine', 'order')} #${m.order_id}` : ''} · {fmtWhen(m.created_at, lang)}{m.author_name ? ' · ' + m.author_name : ''}
                      </div>
                    </div>
                    {m.invoice_url && (
                      <a href={mediaUrl(m.invoice_url)} target="_blank" rel="noreferrer" title={t('Fattura allegata', 'Attached invoice')} className="dk-iconbtn" style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                        <Icon name="ext" size={14} color="var(--clay-ink)" />
                      </a>
                    )}
                    <div className="t-num" style={{ fontSize: 15, fontWeight: 700, color: d > 0 ? 'var(--ok)' : 'var(--ink-2)', flexShrink: 0 }}>{d > 0 ? '+' : ''}{fmtQty(d, lang)} {unit}</div>
                  </div>
                );
              })}
            </div>
            {!items.length && <div style={{ padding: '36px 22px' }}><EmptyState icon="clock" title={t('Nessun movimento', 'No movements')} sub={t('Carichi, vendite e rettifiche compariranno qui.', 'Restocks, sales and adjustments will appear here.')} /></div>}
            <Pager count={data?.count || 0} offset={offset} limit={PAGE} onPage={setOffset} t={t} />
          </React.Fragment>
        )}
      </div>
    </React.Fragment>
  );
}
