// RegisterTab — «Cassa»: la cassa di un giorno da GET /api/sales/register.
// Ogni pagamento arrivato quel giorno (anche saldi di conti vecchi e caparre),
// i totali per metodo e la divisione con/senza scontrino. Il denaro si conta
// quando arriva, con la stessa regola del riepilogo in agenda (`cash_in`).
import { useEffect, useState } from 'react';
import { Icon, fmtTime, todayStr, toastApiError } from '@youty/shared';
import { useDash } from '../../ctx.jsx';
import { inputCss, methodLabel, money, payMethods } from './lib.js';
import { salesApi } from '../../api/sales.js';
import { useLatestRequest } from '../../hooks/useLatestRequest.js';
import NoReceiptBadge from './NoReceiptBadge.jsx';

export default function RegisterTab() {
  const { t, lang, fireToast, hasScope } = useDash();
  const [day, setDay] = useState(todayStr());
  const [data, setData] = useState(null);
  const req = useLatestRequest();

  useEffect(() => {
    if (!hasScope('sales') || !day) return;
    const seq = req.begin();
    setData(null);
    salesApi.register(day)
      .then((r) => { if (req.isLatest(seq)) setData(r); })
      .catch((err) => { if (req.isLatest(seq)) toastApiError(err, fireToast, t); });
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasScope('sales')) {
    return (
      <div className="dk-card" style={{ padding: '36px 24px', textAlign: 'center', maxWidth: 900 }}>
        <Icon name="alert" size={26} color="var(--muted-2)" />
        <div className="t-body" style={{ color: 'var(--muted)', marginTop: 10 }}>
          {t('Serve il permesso "vendite" per vedere la cassa.', 'The "sales" permission is required to view the register.')}
        </div>
      </div>
    );
  }

  const kpis = data ? [
    [t('Incassato', 'Cashed in'), money(data.cash_in, lang), t('denaro entrato nel giorno', 'money received that day'), 'wallet'],
    [t('Venduto', 'Sold'), money(data.sold, lang), Number(data.due_left) > 0 ? t(`di cui ${money(data.due_left, 'it')} da saldare`, `${money(data.due_left, 'en')} left to pay`) : t('conti del giorno', 'bills of the day'), 'box'],
    [t('Con scontrino', 'With receipt'), money(data.receipt, lang), t('pagamenti del giorno', 'payments of the day'), 'check'],
    [t('Senza scontrino', 'Without receipt'), money(data.no_receipt, lang), t('pagamenti del giorno', 'payments of the day'), 'alert'],
  ] : [];
  const methods = data ? payMethods(t).filter(([k]) => Number(data.by_method[k] || 0) !== 0) : [];

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="t-sm" style={{ color: 'var(--muted)', flex: 1, minWidth: 220 }}>
          {t('Tutti i pagamenti arrivati nel giorno: conti, vendite da banco, saldi e caparre.', 'Every payment received that day: bills, counter sales, balances and deposits.')}
        </div>
        <input type="date" value={day} max={todayStr()} onChange={(e) => setDay(e.target.value)} style={inputCss} aria-label={t('Giorno', 'Day')} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
        {!data ? [...Array(4)].map((_, i) => <div key={i} className="skel" style={{ height: 92, borderRadius: 16 }} />) : kpis.map(([l, v, cap, ic]) => (
          <div key={l} className="dk-card" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
              <Icon name={ic} size={15} color="var(--clay-ink)" /><span className="t-meta">{l}</span>
            </div>
            <div className="t-num" style={{ fontSize: 20, fontWeight: 800 }}>{v}</div>
            <div className="t-sm" style={{ color: 'var(--muted-2)', marginTop: 2 }}>{cap}</div>
          </div>
        ))}
      </div>

      {data && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {methods.map(([k, label]) => (
            <span key={k} className="dk-pill" data-method={k} style={{ padding: '6px 12px', fontSize: 13, cursor: 'default' }}>
              {label} <b className="t-num">{money(data.by_method[k], lang)}</b>
            </span>
          ))}
          {Number(data.refunded) > 0 && (
            <span className="dk-pill" style={{ padding: '6px 12px', fontSize: 13, cursor: 'default', color: 'var(--danger)' }}>
              {t('Caparre restituite', 'Deposits refunded')} <b className="t-num">−{money(data.refunded, lang)}</b>
            </span>
          )}
          {!methods.length && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Nessun incasso in questo giorno.', 'No payments on this day.')}</span>}
        </div>
      )}

      {data && data.payments.length > 0 && (
        <div className="dk-card" style={{ overflow: 'hidden' }}>
          {data.payments.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
              <span className="t-num t-sm" style={{ color: 'var(--muted)', width: 44, flexShrink: 0 }}>{fmtTime(p.created_at)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.client_name || t('Da banco', 'Walk-in')}
                </div>
                <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, color: 'var(--clay-ink)' }}>
                    {p.is_deposit ? t('Caparra', 'Deposit') : p.is_settlement ? t('Saldo conto precedente', 'Earlier bill balance') : p.kind === 'checkout' ? t('Check-out', 'Check-out') : t('Da banco', 'Counter sale')}
                  </span>
                  <span>· #{p.sale_id}</span>
                  {!p.receipt_issued && <NoReceiptBadge t={t} />}
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--surface-2)', padding: '4px 10px', borderRadius: 99, flexShrink: 0 }}>
                {methodLabel(p.method, t)}{p.gift_card_code ? ' · ' + p.gift_card_code : ''}
              </span>
              <span className="t-num" style={{ fontSize: 15, fontWeight: 800, width: 80, textAlign: 'right', flexShrink: 0 }}>{money(p.amount, lang)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
