// ConfirmPaymentModal.jsx — «Sei sicura di voler completare il pagamento?»
// prima di registrare un check-out o una vendita al banco. Mentre la vendita
// si registra non si chiude.
import { Icon } from '@youty/shared';
import DkModal from '../../ui/DkModal.jsx';

/* `summary`: la riga sotto la domanda (importo, cliente o operatrice);
 * `note`: un avviso in più (la caparra eccedente del check-out). */
export default function ConfirmPaymentModal({ open, saving, onBack, onConfirm, summary, note, t }) {
  return (
    <DkModal open={open} onClose={() => { if (!saving) onBack(); }}
      title={t('Conferma pagamento', 'Confirm payment')} width={440}
      foot={(
        <>
          <button className="dk-btn dk-btn--ghost" onClick={onBack} disabled={saving}>{t('Torna indietro', 'Go back')}</button>
          <button className="dk-btn dk-btn--clay" onClick={onConfirm} disabled={saving}>
            <Icon name="check" size={16} color="#fff" />{saving ? t('Registrazione…', 'Recording…') : t('Conferma', 'Confirm')}
          </button>
        </>
      )}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
        {t('Sei sicura di voler completare il pagamento?', 'Are you sure you want to complete the payment?')}
      </div>
      <div className="t-sm" style={{ color: 'var(--muted)' }}>
        {summary}
      </div>
      {note && (
        <div className="t-sm" style={{ color: 'var(--warn)', fontWeight: 600, marginTop: 8 }}>{note}</div>
      )}
    </DkModal>
  );
}
