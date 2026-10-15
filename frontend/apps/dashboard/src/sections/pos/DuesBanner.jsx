// DuesBanner.jsx — i conti della cliente ancora da saldare, in cima alla cassa
// (check-out e banco): quanto deve e da quando, con «Salda adesso». Il saldo
// si ripartisce sui conti dal più vecchio (allocateSettlement, money.js) e
// parte con un POST /api/sales/{id}/settle per conto: il denaro entra nella
// cassa di oggi, il venduto resta del giorno di ciascun conto.
// Chi lo usa lo monta con `key={clientId}`: cambiando cliente il pannello
// riparte chiuso e senza il pagamento di un'altra.
import { useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import PaymentsPanel from './PaymentsPanel.jsx';
import { salesApi } from '../../api/sales.js';
import { useResource } from '../../hooks/useResource.js';
import {
  allocateSettlement, centsToEur, emptyPayments, money, paymentsError, resolvePayments, saleDateLabel, toCents,
} from './lib.js';

export default function DuesBanner({ clientId, enabled = true, onSettled, t, lang, fireToast, style }) {
  const [rev, setRev] = useState(0);
  const { data } = useResource(() => salesApi.dues(clientId), [clientId, rev], { enabled: enabled && !!clientId, fallback: null });
  const [open, setOpen] = useState(false);
  const [pay, setPay] = useState(emptyPayments());
  const [busy, setBusy] = useState(false);

  const dues = data && data.client_id === clientId ? data : null;
  const dueCents = toCents(dues?.amount_due || 0);
  if (!enabled || !clientId || !(dueCents > 0)) return null;

  const sales = dues.sales || [];
  const payErr = paymentsError(pay, dueCents, t);
  const payments = resolvePayments(pay, dueCents);
  const paidCents = payments.reduce((s, p) => s + toCents(p.amount), 0);

  const settle = async () => {
    if (busy) return;
    if (payErr) { fireToast({ msg: payErr, icon: 'alert' }); return; }
    if (!(paidCents > 0)) { fireToast({ msg: t('Indica quanto paga la cliente', 'Enter how much the client pays'), icon: 'alert' }); return; }
    setBusy(true);
    try {
      // Un conto alla volta, dal più vecchio: se uno fallisce (una gift card
      // senza saldo) quelli prima restano saldati, e l'elenco si rilegge.
      for (const step of allocateSettlement(sales, payments)) {
        await salesApi.settle(step.sale_id, { payments: step.payments });
      }
      fireToast({ msg: t(`Saldo registrato · ${money(centsToEur(paidCents), 'it')}`, `Balance recorded · ${money(centsToEur(paidCents), 'en')}`), icon: 'check' });
      setOpen(false);
      setPay(emptyPayments());
      onSettled?.();
    } catch (err) {
      toastApiError(err, fireToast, t);
    } finally {
      setBusy(false);
      setRev((r) => r + 1);
    }
  };

  const oldest = sales[0];
  return (
    <div style={{ borderRadius: 12, background: 'var(--warn-tint)', padding: '10px 12px', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="clock" size={16} color="var(--warn)" />
        <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
          <b>{t('Da saldare', 'Left to pay')} {money(dues.amount_due, lang)}</b>
          <div className="t-sm" style={{ color: 'var(--ink-2)', marginTop: 2 }}>
            {sales.length === 1 ? t('Un conto precedente', 'One earlier bill') : t(`${sales.length} conti precedenti`, `${sales.length} earlier bills`)}
            {oldest ? ' · ' + t('dal', 'since') + ' ' + saleDateLabel(oldest.created_at, lang) : ''}
          </div>
        </div>
        {!open && (
          <button className="dk-btn dk-btn--soft" style={{ height: 32, fontSize: 12.5, flexShrink: 0 }} onClick={() => setOpen(true)}>
            <Icon name="wallet" size={14} />{t('Salda adesso', 'Settle now')}
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--hair)' }}>
          <PaymentsPanel value={pay} onChange={setPay} dueCents={dueCents} t={t} lang={lang} compact
            allowDue dueToggleLabel={t('Paga solo una parte', 'Pay only part')} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            <button className="dk-btn dk-btn--ghost" style={{ height: 34, fontSize: 12.5 }} disabled={busy}
              onClick={() => { setOpen(false); setPay(emptyPayments()); }}>{t('Annulla', 'Cancel')}</button>
            <button className="dk-btn dk-btn--clay" style={{ height: 34, fontSize: 12.5 }} disabled={busy || !!payErr || !(paidCents > 0)} onClick={settle}
              title={payErr || undefined}>
              <Icon name="check" size={14} color="#fff" />
              {busy ? t('Registrazione…', 'Recording…') : <>{t('Incassa saldo', 'Collect balance')} {money(centsToEur(paidCents), lang)}</>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
