// CheckoutDone.jsx — il check-out registrato (SellModal): totale, caparra
// detratta o da restituire, pagamenti e ripartizione per operatrice
// (CheckoutOut.breakdown).
import { Avatar, Icon } from '@youty/shared';
import DkModal from '../../ui/DkModal.jsx';
import { centsToEur, methodLabel, money, toCents } from './lib.js';

/* `depositCents`: la caparra che il conto detraeva (saleTotals); gli aiuti
 * op* sono quelli della modale, per nome, colore e iniziali. */
export default function CheckoutDone({ result, depositCents, clientName, onClose, opInitials, opColor, opLabel, t, lang }) {
  const { sale, breakdown } = result;
  // Quello che il server non ha detratto della caparra torna alla cliente.
  const returnedCents = Math.max(0, depositCents - toCents(sale.deposit_deducted));
  return (
    <DkModal open onClose={onClose} title={t('Check-out completato', 'Check-out complete')} sub={clientName} width={520}
      foot={<button className="dk-btn dk-btn--clay" onClick={onClose}><Icon name="check" size={16} color="#fff" />{t('Chiudi', 'Close')}</button>}>
      <div style={{ textAlign: 'center', padding: '10px 0 6px' }}>
        <div style={{ width: 62, height: 62, borderRadius: 99, background: 'var(--ok-tint)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
          <Icon name="check" size={30} color="var(--ok)" stroke={2.4} />
        </div>
        <div className="t-num" style={{ fontSize: 28, fontWeight: 800 }}>{money(sale.total, lang)}</div>
        {Number(sale.deposit_deducted) > 0 && (
          <div className="t-sm" style={{ color: 'var(--ok)', fontWeight: 700, marginTop: 4 }}>
            {t('Caparra detratta', 'Deposit deducted')} −{money(sale.deposit_deducted, lang)}
          </div>
        )}
        {returnedCents > 0 && (
          <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 700, marginTop: 4 }}>
            {t('Caparra eccedente da restituire', 'Excess deposit to return')}: {money(centsToEur(returnedCents), lang)}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {sale.payments.map((p) => (
            <span key={p.id} style={{ fontSize: 12, fontWeight: 700, color: 'var(--ink-2)', background: 'var(--surface-2)', border: '1px solid var(--hair)', padding: '4px 10px', borderRadius: 99 }}>
              {methodLabel(p.method, t)} · {money(p.amount, lang)}
            </span>
          ))}
        </div>
      </div>
      <div className="t-meta" style={{ margin: '18px 0 8px' }}>{t('Ripartizione per operatrice', 'Split by stylist')}</div>
      <div style={{ border: '1px solid var(--hair)', borderRadius: 12, padding: '4px 14px', marginBottom: 8 }}>
        {breakdown.map((b, i) => (
          <div key={b.operator_id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: i ? '1px solid var(--hair)' : 'none' }}>
            <Avatar initials={opInitials(b.operator_id)} size={28} color={opColor(b.operator_id)} />
            <span style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{b.operator_name || opLabel(b.operator_id)}</span>
            <span className="t-num" style={{ fontWeight: 700 }}>{money(b.amount, lang)}</span>
          </div>
        ))}
      </div>
    </DkModal>
  );
}
