// HistoryTab — "Storico": sales history from GET /api/sales/ (custom envelope {count,kpi,items}),
// KPI header, filters (kind, dates, text, operator), expandable rows loading GET /api/sales/{id}.
import React, { useEffect, useState } from 'react';
import { api, ApiError, Icon } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { inputCss, lineAmount, methodLabel, money, opName, saleDateLabel } from './lib.js';

const LIMIT = 50;

export default function HistoryTab() {
  const { t, lang, operators, fireToast, hasScope } = useDash();

  /* ---- filters ---- */
  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [kind, setKind] = useState('');
  const [opId, setOpId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  useEffect(() => {
    const tm = setTimeout(() => setQDeb(q), 300);
    return () => clearTimeout(tm);
  }, [q]);

  /* ---- data ---- */
  const [data, setData] = useState(null);   // { count, kpi } of the current filter set
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [details, setDetails] = useState({}); // sale id -> SaleDetailOut | 'loading' | 'error'

  const params = (offset) => ({
    kind: kind || null, date_from: dateFrom || null, date_to: dateTo || null,
    q: qDeb || null, operator_id: opId || null, limit: LIMIT, offset,
  });

  useEffect(() => {
    let dead = false;
    setLoading(true);
    setOpenId(null);
    api.get('/api/sales/', { params: params(0) })
      .then((r) => { if (!dead) { setData(r); setItems(r.items || []); } })
      .catch((err) => {
        if (dead) return;
        setData({ count: 0, kpi: { revenue: 0, count: 0, items_count: 0 } });
        setItems([]);
        fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
      })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [kind, dateFrom, dateTo, qDeb, opId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get('/api/sales/', { params: params(items.length) });
      setItems((l) => [...l, ...(r.items || [])]);
    } catch (err) {
      fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleOpen = (id) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (!details[id] || details[id] === 'error') {
      setDetails((d) => ({ ...d, [id]: 'loading' }));
      api.get(`/api/sales/${id}`)
        .then((r) => setDetails((d) => ({ ...d, [id]: r })))
        .catch((err) => {
          setDetails((d) => ({ ...d, [id]: 'error' }));
          fireToast({ msg: err instanceof ApiError ? err.message : t('Errore di rete', 'Network error'), icon: 'alert' });
        });
    }
  };

  if (!hasScope('sales')) {
    return (
      <div className="dk-card" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: 900 }}>
        <Icon name="alert" size={26} color="var(--muted-2)" />
        <div className="t-body" style={{ color: 'var(--muted)', marginTop: 10 }}>
          {t('Serve il permesso "vendite" per vedere lo storico.', 'The "sales" permission is required to view the history.')}
        </div>
      </div>
    );
  }

  const kpi = data?.kpi || { revenue: 0, count: 0, items_count: 0 };
  const lineIcon = (lt) => (lt === 'gift_card' ? 'gift' : lt === 'service' ? 'scissors' : 'box');

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 16 }}>
        {t('Tutte le vendite registrate: check-out appuntamenti e vendite da banco.', 'All recorded sales: appointment check-outs and counter sales.')}
      </div>

      {/* KPI strip (from the API kpi envelope) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 18 }}>
        {loading && !data ? [...Array(3)].map((_, i) => <div key={i} className="skel" style={{ height: 92, borderRadius: 16 }} />) : [
          [t('Incasso totale', 'Total revenue'), money(kpi.revenue, lang), t('per i filtri correnti', 'for the current filters'), 'wallet'],
          [t('N° vendite', 'Sales count'), String(kpi.count), t('vendite registrate', 'recorded sales'), 'box'],
          [t('Articoli venduti', 'Items sold'), String(kpi.items_count), t('righe servizi, prodotti e gift', 'service, product & gift lines'), 'gift'],
        ].map(([l, v, cap, ic], i) => (
          <div key={i} className="dk-card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
              <Icon name={ic} size={15} color="var(--clay-ink)" /><span className="t-meta">{l}</span>
            </div>
            <div className="t-num" style={{ fontSize: 20, fontWeight: 800 }}>{v}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>{cap}</div>
          </div>
        ))}
      </div>

      {/* search + filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="dk-search" style={{ flex: 1, minWidth: 180 }}>
          <Icon name="search" size={17} color="var(--muted-2)" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Cerca per cliente…', 'Search by client…')} />
          {q && <button className="press" onClick={() => setQ('')} style={{ cursor: 'pointer', display: 'grid', placeItems: 'center' }}><Icon name="x" size={14} color="var(--muted-2)" /></button>}
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={{ ...inputCss, cursor: 'pointer', minWidth: 130 }}>
          <option value="">{t('Tutti i tipi', 'All types')}</option>
          <option value="checkout">{t('Check-out', 'Check-out')}</option>
          <option value="pos">{t('Da banco', 'Counter')}</option>
        </select>
        <select value={opId} onChange={(e) => setOpId(e.target.value)} style={{ ...inputCss, cursor: 'pointer', minWidth: 150 }}>
          <option value="">{t('Tutte le operatrici', 'All stylists')}</option>
          {operators.map((o) => <option key={o.id} value={o.id}>{opName(o)}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={inputCss} title={t('Dal', 'From')} />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={inputCss} title={t('Al', 'To')} />
      </div>

      <div className="t-sm" style={{ color: 'var(--muted-2)', marginBottom: 10 }}>
        {loading ? '…' : `${data?.count ?? 0} ${t('vendite', 'sales')}`}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[...Array(5)].map((_, i) => <div key={i} className="skel" style={{ height: 66, borderRadius: 14 }} />)}
        </div>
      ) : (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          {items.map((s, i) => {
            const open = openId === s.id;
            const det = details[s.id];
            const isCheckout = s.kind === 'checkout';
            const depositDeducted = Number(s.deposit_deducted) > 0;
            return (
              <div key={s.id} style={{ borderTop: i ? '1px solid var(--hair)' : 'none' }}>
                <button onClick={() => toggleOpen(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', width: '100%', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 'none' }}>
                  <div style={{ width: 38, height: 38, borderRadius: 10, background: 'var(--clay-tint)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                    <Icon name={isCheckout ? 'scissors' : 'box'} size={17} color="var(--clay-ink)" />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.client_name || t('Da banco', 'Walk-in')}
                    </div>
                    <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, color: 'var(--clay-ink)' }}>{isCheckout ? t('Check-out', 'Check-out') : t('Da banco', 'Counter sale')}</span>
                      {isCheckout && s.appointment_id != null && <span>· {t('app.', 'appt')} #{s.appointment_id}</span>}
                      {depositDeducted && (
                        <span style={{ color: 'var(--ok)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          · <Icon name="wallet" size={13} color="var(--ok)" />{t('caparra', 'deposit')} −{money(s.deposit_deducted, lang)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div className="t-num" style={{ fontSize: 16, fontWeight: 800 }}>{money(s.total, lang)}</div>
                    <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{saleDateLabel(s.created_at, lang)}</div>
                  </div>
                  <Icon name="chevD" size={16} color="var(--muted-2)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms', flexShrink: 0 }} />
                </button>

                {open && (
                  <div style={{ padding: '0 18px 16px 70px' }}>
                    {det === 'loading' || !det ? (
                      <div className="skel" style={{ height: 90, borderRadius: 12 }} />
                    ) : det === 'error' ? (
                      <div className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Dettaglio non disponibile.', 'Detail unavailable.')}</div>
                    ) : (
                      <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '6px 14px' }}>
                        {det.lines.map((l, j) => (
                          <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderTop: j ? '1px solid var(--hair)' : 'none' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 600, minWidth: 0 }}>
                              <Icon name={lineIcon(l.line_type)} size={15} color="var(--muted)" />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {l.line_type === 'gift_card'
                                  ? 'Gift card' + (l.gift_card_code ? ' · ' + l.gift_card_code : '')
                                  : (l.service_name || l.product_name || (l.line_type === 'product' ? t('Prodotto', 'Product') : t('Servizio', 'Service')) + ' #' + (l.service_id ?? l.product_id ?? ''))}
                                {l.qty > 1 ? ' × ' + l.qty : ''}
                              </span>
                              {l.operator_name && <span className="t-sm" style={{ color: 'var(--muted-2)', flexShrink: 0 }}>· {l.operator_name}</span>}
                              {l.discount_pct > 0 && <span className="t-sm" style={{ color: 'var(--clay-ink)', fontWeight: 700, flexShrink: 0 }}>−{l.discount_pct}%</span>}
                            </span>
                            <span className="t-num" style={{ fontWeight: 700, flexShrink: 0, color: l.is_gift ? 'var(--ok)' : 'var(--ink)' }}>
                              {l.is_gift ? t('Omaggio', 'Free') : money(l.amount, lang)}
                            </span>
                          </div>
                        ))}
                        {Number(det.deposit_deducted) > 0 && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--hair)', color: 'var(--ok)' }}>
                            <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Icon name="wallet" size={14} color="var(--ok)" />{t('Caparra detratta', 'Deposit deducted')}
                            </span>
                            <span className="t-num" style={{ fontWeight: 700 }}>−{money(det.deposit_deducted, lang)}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--hair)' }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{t('Totale', 'Total')}</span>
                          <span className="t-num" style={{ fontWeight: 800, fontSize: 16 }}>{money(det.total, lang)}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '4px 0 10px' }}>
                          {det.payments.map((p) => (
                            <span key={p.id} style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--surface)', border: '1px solid var(--hair)', padding: '4px 10px', borderRadius: 99 }}>
                              {methodLabel(p.method, t)} · {money(p.amount, lang)}{p.gift_card_code ? ' · ' + p.gift_card_code : ''}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 8 }}>{t('Registrazione non fiscale', 'Non-fiscal record')} · #{s.id}</div>
                  </div>
                )}
              </div>
            );
          })}
          {!items.length && (
            <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '36px 16px', textAlign: 'center' }}>
              {t('Nessuna vendita per i filtri selezionati.', 'No sales for the selected filters.')}
            </div>
          )}
        </div>
      )}

      {!loading && data && items.length < data.count && (
        <button className="dk-btn dk-btn--ghost" style={{ marginTop: 14, width: '100%' }} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? t('Caricamento…', 'Loading…') : t('Carica altre vendite', 'Load more sales')}
        </button>
      )}
    </div>
  );
}
