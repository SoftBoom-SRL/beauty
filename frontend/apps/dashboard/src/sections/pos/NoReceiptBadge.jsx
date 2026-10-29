// Segno di una vendita registrata senza scontrino fiscale (`receipt_issued` falso):
// lo usano storico vendite, cassa del giorno e storico cliente.
export default function NoReceiptBadge({ t }) {
  return (
    <span style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--ink-2)', background: 'var(--surface-2)', border: '1px dashed var(--muted-2)', padding: '1px 8px', borderRadius: 99, whiteSpace: 'nowrap' }}>
      {t('Senza scontrino', 'No receipt')}
    </span>
  );
}
