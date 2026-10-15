// DepositPaid — «Caparra già versata» in fondo a «Nuova prenotazione»: la
// cliente ha pagato la caparra fuori da beauty (bonifico o link di un'altra
// banca come Nexi, contanti o POS al momento della prenotazione) e chi prende
// l'appuntamento lo scrive qui. L'appuntamento nasce con la caparra pagata,
// l'incasso entra in cassa oggi, al conto si detrae, e alla cliente non parte
// nessun link di pagamento. Chiuso è un pulsante solo; aperto propone metà del
// totale, che segue i servizi finché nessuno scrive un importo (`auto`).
// Senza hook: `deposit` ({ amount, method, auto } o null) lo tiene il drawer.
import { Icon, fmtEur } from '@youty/shared';
import { centsToEur } from '../../../pos/money.js';
import { DEPOSIT_METHODS, cleanAmount, depositIssue, halfDeposit } from '../../lib/deposit.js';

export default function DepositPaid({ deposit, setDeposit, maxCents, stepRef, t, lang }) {
  if (!deposit) {
    return (
      <div ref={stepRef} style={{ marginTop: 12 }}>
        <button type="button" className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }}
          onClick={() => setDeposit({ amount: halfDeposit(maxCents, lang), method: 'transfer', auto: true })}>
          <Icon name="wallet" size={14} />{t('Caparra già versata', 'Deposit already paid')}
        </button>
      </div>
    );
  }
  const issue = depositIssue(deposit.amount, maxCents);
  const pill = (on) => ({
    height: 30, padding: '0 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: '1px solid ' + (on ? 'var(--clay)' : 'var(--hair)'), background: on ? 'var(--clay-tint)' : 'var(--surface)',
    color: on ? 'var(--clay-ink)' : 'var(--ink-2)',
  });
  return (
    <div ref={stepRef} style={{ marginTop: 12, padding: '10px 13px', background: 'var(--surface-2)', borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="wallet" size={17} color="var(--clay-ink)" />
        <div style={{ flex: 1, fontWeight: 600, fontSize: 13.5 }}>{t('Caparra già versata', 'Deposit already paid')}</div>
        <button type="button" className="dk-iconbtn" onClick={() => setDeposit(null)} aria-label={t('Togli la caparra', 'Remove the deposit')} style={{ width: 28, height: 28 }}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3, border: '1px solid ' + (issue === 'over' ? 'var(--danger)' : 'var(--hair)'), borderRadius: 9, padding: '6px 9px', background: 'var(--surface)', width: 96, boxSizing: 'border-box' }}>
          <span style={{ color: 'var(--muted-2)', fontWeight: 700 }}>€</span>
          <input type="text" inputMode="decimal" value={deposit.amount} placeholder="0,00" aria-label={t('Importo della caparra', 'Deposit amount')}
            onChange={(e) => setDeposit({ ...deposit, amount: cleanAmount(e.target.value), auto: false })}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontFamily: 'ui-monospace, monospace', fontWeight: 700, fontSize: 13.5, width: '100%' }} />
        </div>
        {DEPOSIT_METHODS.map((m) => (
          <button key={m.id} type="button" aria-pressed={deposit.method === m.id} style={pill(deposit.method === m.id)}
            onClick={() => setDeposit({ ...deposit, method: m.id })}>
            {lang === 'en' ? m.en : m.it}
          </button>
        ))}
      </div>
      <div className="t-sm" style={{ marginTop: 6, color: issue === 'over' ? 'var(--danger)' : 'var(--muted)', fontSize: 12 }}>
        {issue === 'over'
          ? t('Più del totale della visita', 'More than the visit total') + ` (${fmtEur(centsToEur(maxCents), lang)})`
          : t('Entra in cassa oggi e al conto si detrae. Alla cliente non parte nessun link di pagamento.', 'It enters the till today and is deducted at checkout. No payment link is sent to the client.')}
      </div>
    </div>
  );
}
