// «Scontrino emesso»: acceso di norma. Spento, l'incasso resta registrato
// (cassa del giorno, storico cliente) ma segnato senza scontrino fiscale.
export default function ReceiptToggle({ value, onChange, t, style }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13.5, fontWeight: 600, cursor: 'pointer', ...style }}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--clay)' }} />
      {t('Scontrino emesso', 'Receipt issued')}
      {!value && <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 500 }}>· {t('registrato senza scontrino', 'recorded without receipt')}</span>}
    </label>
  );
}
