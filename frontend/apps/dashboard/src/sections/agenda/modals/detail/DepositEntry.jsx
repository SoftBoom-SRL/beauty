// DepositEntry — quanto ha versato la cliente e come: l'importo (scrivibile)
// e un pulsante per metodo, che registra subito la caparra. Lo usano la
// caparra chiesta dalle regole (DepositCard, importo già scritto) e quella
// registrata a mano su una visita che non la chiedeva (AddDepositCard).
// Senza hook: l'importo lo tiene useDepositActions.
import { Icon, fmtEur } from '@youty/shared';
import { toCents, centsToEur } from '../../../pos/money.js';
import { DEPOSIT_METHODS, cleanAmount, depositIssue } from '../../lib/deposit.js';

export default function DepositEntry({ amount, setAmount, maxCents, busy, onCash, t, lang }) {
  const issue = depositIssue(amount, maxCents);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid ' + (issue === 'over' ? 'var(--danger)' : 'var(--hair)'), borderRadius: 9, padding: '5px 8px', background: 'var(--surface)', width: 92, boxSizing: 'border-box' }}>
          <span style={{ color: 'var(--muted-2)', fontWeight: 700, fontSize: 12.5 }}>€</span>
          <input type="text" inputMode="decimal" value={amount} placeholder="0,00" aria-label={t('Importo della caparra', 'Deposit amount')}
            onChange={(e) => setAmount(cleanAmount(e.target.value))}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13, width: '100%' }} />
        </div>
        {DEPOSIT_METHODS.map((m) => (
          <button key={m.id} className="dk-btn dk-btn--ghost" disabled={busy || !!issue} style={{ height: 30, fontSize: 12 }}
            onClick={() => onCash(m.id)}
            title={t('Segna la caparra versata: il posto non si libera più, l’incasso entra in cassa oggi e al conto si detrae', 'Mark the deposit as paid: the slot is no longer freed, the money enters the till today and is deducted at checkout')}>
            <Icon name="wallet" size={13} />{t('Incassata: ', 'Cashed: ') + (lang === 'en' ? m.en : m.it)}
          </button>
        ))}
      </div>
      {issue === 'over' && (
        <div className="t-sm" style={{ color: 'var(--danger)', marginTop: 5 }}>
          {t('Più del totale della visita', 'More than the visit total')} ({fmtEur(centsToEur(maxCents), lang)})
        </div>
      )}
    </div>
  );
}

/** Il totale della visita in centesimi, per il controllo dell'importo. */
export const visitMaxCents = (appt) => toCents(appt?.total_price ?? 0);
