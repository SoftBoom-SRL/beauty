// AddDepositCard — «Registra caparra versata» su una visita che non la
// chiedeva: la cliente l'ha pagata fuori da beauty (bonifico o link Nexi,
// contanti o POS) e chi la riceve la scrive qui. Chiuso è un pulsante solo,
// per non ingombrare il dettaglio; aperto, importo e metodo (DepositEntry).
// Senza hook: `draft` (null = chiuso) lo tiene useDepositActions.
import { Icon } from '@youty/shared';
import DepositEntry, { visitMaxCents } from './DepositEntry.jsx';

export default function AddDepositCard({ appt, draft, setDraft, busy, cashDeposit, t, lang }) {
  if (draft == null) {
    return (
      <div>
        <button className="dk-btn dk-btn--ghost" style={{ height: 30, fontSize: 12 }} onClick={() => setDraft('')}
          title={t('La cliente ha già versato una caparra (bonifico, Nexi, contanti, POS): registrala qui', 'The client already paid a deposit (transfer, Nexi, cash, card): record it here')}>
          <Icon name="wallet" size={13} />{t('Registra caparra versata', 'Record a paid deposit')}
        </button>
      </div>
    );
  }
  return (
    <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--hair)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="wallet" size={15} color="var(--clay-ink)" />
        <div style={{ flex: 1, fontWeight: 700, fontSize: 13.5 }}>{t('Caparra versata', 'Deposit paid')}</div>
        <button className="dk-btn dk-btn--ghost" style={{ height: 26, width: 26, padding: 0 }} onClick={() => setDraft(null)} aria-label={t('Chiudi', 'Close')}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <DepositEntry amount={draft} setAmount={setDraft} maxCents={visitMaxCents(appt)} busy={busy} onCash={cashDeposit} t={t} lang={lang} />
    </div>
  );
}
