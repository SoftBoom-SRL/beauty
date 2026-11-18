// VoidSale.jsx — in fondo al dettaglio di una vendita nello Storico: «Annulla
// incasso» per un conto chiuso per sbaglio (POST /api/sales/{id}/void, solo il
// titolare). Prima un conto chiuso male restava per sempre in cassa e nei
// report, senza modo di rifarlo (Beauty Boutique, 11/2026). Annullato, la
// vendita sparisce, i prodotti tornano a magazzino e la visita torna da
// incassare: il conto si rifà dall'agenda (o dal banco). Quando il server dice
// che non si può (gift card, pacchetti, buoni, caparra) si legge il perché.
import { useState } from 'react';
import { Icon, toastApiError } from '@youty/shared';
import { salesApi } from '../../api/sales.js';
import { money } from './lib.js';

export default function VoidSale({ sale, onVoided, fireToast, t, lang }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (sale.void_blocker) {
    return <div className="t-sm" style={{ color: 'var(--muted-2)', padding: '8px 0 4px' }}>{t('Non annullabile:', 'Cannot be voided:')} {sale.void_blocker}</div>;
  }
  const hasVisit = sale.appointment_id != null;
  const doVoid = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await salesApi.void(sale.id);
      fireToast({ msg: t(`Incasso annullato · ${money(sale.total, 'it')}`, `Payment voided · ${money(sale.total, 'en')}`), icon: 'check' });
      onVoided(sale.id);
    } catch (err) {
      toastApiError(err, fireToast, t);
      setBusy(false);
    }
  };
  if (!asking) {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 0 4px' }}>
        <button className="dk-btn dk-btn--danger" style={{ height: 32, fontSize: 12.5 }} onClick={() => setAsking(true)}>
          <Icon name="x" size={14} color="var(--danger)" />{t('Annulla incasso', 'Void payment')}
        </button>
      </div>
    );
  }
  return (
    <div style={{ padding: '10px 12px', margin: '8px 0 4px', borderRadius: 10, background: 'var(--danger-tint)' }}>
      <div className="t-sm" style={{ fontWeight: 600, color: 'var(--ink)' }}>
        {t('La vendita sparisce da storico, cassa del giorno e report; i prodotti tornano a magazzino.', 'The sale disappears from history, the day’s register and reports; products go back to stock.')}
        {' '}{hasVisit
          ? t('La visita torna «in corso»: rifai il conto dall’agenda.', 'The visit goes back to «in progress»: redo the bill from the calendar.')
          : t('Se serve, rifai la vendita dal banco.', 'If needed, redo the sale at the counter.')}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        <button className="dk-btn dk-btn--ghost" style={{ height: 32, fontSize: 12.5 }} disabled={busy} onClick={() => setAsking(false)}>{t('Indietro', 'Back')}</button>
        <button className="dk-btn dk-btn--danger" style={{ height: 32, fontSize: 12.5 }} disabled={busy} onClick={doVoid}>
          <Icon name="x" size={14} color="var(--danger)" />{busy ? t('Annullamento…', 'Voiding…') : t('Sì, annulla l’incasso', 'Yes, void it')}
        </button>
      </div>
    </div>
  );
}
