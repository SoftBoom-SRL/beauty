// sell/TotalsBox.jsx — il riepilogo del check-out (SellModal): parziale per
// operatrice (con più di una), lordo, buono, caparra detratta, saldo da
// incassare e l'avviso della caparra eccedente.
import { Icon } from '@youty/shared';
import { centsToEur, money } from '../lib.js';

export default function TotalsBox({ blockIds, opColor, opLabel, opSubtotal, gross, discount, coupon, deposit, deductedCents, due, excessCents, excessNote, t, lang }) {
  return (
    <div style={{ borderRadius: 12, padding: '14px 16px', border: '1px solid var(--hair)', background: 'var(--surface)', marginTop: 16 }}>
      {blockIds.length > 1 && blockIds.map((oid) => (
        <div key={oid} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
          <span className="t-sm" style={{ color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: opColor(oid) }} />{opLabel(oid)}
          </span>
          <span className="t-num" style={{ fontSize: 13 }}>{money(opSubtotal(oid), lang)}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
        <span className="t-sm" style={{ color: 'var(--muted)' }}>{t('Totale lordo', 'Gross total')}</span>
        <span className="t-num" style={{ fontSize: 13 }}>{money(gross, lang)}</span>
      </div>
      {discount > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--clay-ink)' }}>
          <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="coupon" size={14} color="var(--clay-ink)" />{t('Buono', 'Voucher')} {coupon.code}
          </span>
          <span className="t-num" style={{ fontWeight: 700, fontSize: 13 }}>−{money(discount, lang)}</span>
        </div>
      )}
      {deposit > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', color: 'var(--ok)' }}>
          <span className="t-sm" style={{ fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Icon name="wallet" size={14} color="var(--ok)" />{t('Caparra detratta', 'Deposit deducted')}
          </span>
          <span className="t-num" style={{ fontWeight: 700, fontSize: 13 }}>−{money(centsToEur(deductedCents), lang)}</span>
        </div>
      )}
      <div style={{ height: 1, background: 'var(--hair)', margin: '7px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontWeight: 700 }}>{deposit > 0 ? t('Saldo da incassare', 'Balance due') : t('Totale da incassare', 'Total due')}</span>
        <span className="t-num" style={{ fontSize: 24, fontWeight: 800 }}>{money(Math.max(0, due), lang)}</span>
      </div>
      {excessCents > 0 && (
        <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, marginTop: 8 }}>{excessNote}</div>
      )}
    </div>
  );
}
