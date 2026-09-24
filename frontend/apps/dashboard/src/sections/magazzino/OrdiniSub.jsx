// OrdiniSub.jsx — purchase orders: GET /api/inventory/orders, generate drafts from
// below-threshold products, edit draft lines (PUT, qty 0 deletes), send (POST /send),
// receive with per-line quantities (POST /receive → discrepancies).
// Line prices/VAT are not stored on order lines — they are enriched client-side from
// the products snapshot (purchase price net of supplier discount).
import React, { useEffect, useMemo, useState } from 'react';
import { EmptyState, Icon, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { Pager, SkelRows } from './bits.jsx';
import { ordersApi } from '../../api/inventory.js';
import OrderCard from './OrderCard.jsx';

const PAGE = 20;

export default function OrdiniSub({ suppliers, allProds, canWrite, refreshShared, liveTick }) {
  const { t, lang, fireToast, salon } = useDash();

  const [statusF, setStatusF] = useState('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null); // {items, count}
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [generating, setGenerating] = useState(false);

  const prodById = useMemo(() => {
    const m = new Map();
    (allProds || []).forEach((p) => m.set(p.id, p));
    return m;
  }, [allProds]);
  const supById = useMemo(() => {
    const m = new Map();
    (suppliers || []).forEach((s) => m.set(s.id, s));
    return m;
  }, [suppliers]);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    ordersApi.list({ status: statusF !== 'all' ? statusF : undefined, limit: PAGE, offset })
      .then((r) => { if (!dead) setData(r); })
      .catch((err) => { if (!dead) { setData({ items: [], count: 0 }); toastApiError(err, fireToast, t); } })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [statusF, offset, tick, liveTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => setTick((n) => n + 1);
  const replaceOrder = (order) => setData((d) => (d ? { ...d, items: d.items.map((o) => (o.id === order.id ? order : o)) } : d));

  const generate = async () => {
    if (!canWrite || generating) return;
    setGenerating(true);
    try {
      const orders = await ordersApi.generate();
      if (orders.length) {
        fireToast({ msg: t(`${orders.length} bozze d'ordine generate dai prodotti sotto soglia`, `${orders.length} order drafts generated from below-threshold products`), icon: 'check' });
        setStatusF('all'); setOffset(0); refresh();
      } else {
        fireToast({ msg: t('Nessun riordino necessario · tutti i prodotti sono sopra soglia', 'No reorders needed · all products are above threshold'), icon: 'check' });
      }
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      setGenerating(false);
    }
  };

  const chips = [['all', t('Tutti', 'All')], ['draft', t('Bozze', 'Drafts')], ['sent', t('Inviati', 'Sent')], ['partial', t('Parziali', 'Partial')], ['received', t('Ricevuti', 'Received')]];
  const items = data?.items || [];

  return (
    <React.Fragment>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
        <div className="t-sm" style={{ color: 'var(--muted)', flex: 1 }}>
          {t("Bozze d'ordine generate automaticamente dai prodotti sotto soglia, raggruppate per fornitore. Regola le quantità, invia con il metodo preferito o scarica il PDF da inoltrare.", 'Purchase-order drafts auto-generated from below-threshold products, grouped by supplier. Adjust quantities, send via the preferred method or download the PDF to forward.')}
        </div>
        {canWrite && <button className="dk-btn dk-btn--clay" onClick={generate} disabled={generating} style={{ flexShrink: 0 }}><Icon name="refresh" size={16} color="#fff" />{t('Genera ordini', 'Generate orders')}</button>}
      </div>

      <div style={{ display: 'flex', gap: 7, marginBottom: 18, flexWrap: 'wrap' }}>
        {chips.map(([k, l]) => {
          const on = statusF === k;
          return <button key={k} onClick={() => { setStatusF(k); setOffset(0); }} style={{ padding: '7px 14px', borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? 'var(--ink)' : 'var(--hair)'), background: on ? 'var(--ink)' : 'var(--surface)', color: on ? '#fff' : 'var(--ink-2)' }}>{l}</button>;
        })}
      </div>

      {data === null && loading ? (
        <SkelRows n={3} height={150} />
      ) : !items.length ? (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '40px 22px' }}>
            <EmptyState icon="check" title={statusF === 'all' ? t('Nessun ordine', 'No orders') : t('Nessun ordine in questo stato', 'No orders with this status')}
              sub={t('Genera le bozze dai prodotti sotto soglia.', 'Generate drafts from below-threshold products.')}
              action={canWrite ? t('Genera ordini', 'Generate orders') : undefined} onAction={canWrite ? generate : undefined} />
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, opacity: loading ? 0.55 : 1, transition: 'opacity 120ms' }}>
          {items.map((o) => (
            <OrderCard key={o.id} order={o} prodById={prodById} supplier={supById.get(o.supplier_id)} salonName={salon?.name}
              canWrite={canWrite} t={t} lang={lang} fireToast={fireToast}
              onChanged={replaceOrder} onStockChanged={refreshShared} />
          ))}
        </div>
      )}
      {data && <Pager count={data.count} offset={offset} limit={PAGE} onPage={setOffset} t={t} />}
    </React.Fragment>
  );
}

