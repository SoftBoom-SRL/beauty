// MissingAppt.jsx — Sposta e Annulla aperti senza un appuntamento.

/** Il testo `text` e il pulsante per tornare alle prenotazioni (`onBookings`). */
export function MissingAppt({ t, text, onBookings }) {
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 30, textAlign: 'center' }}>
      <div className="t-body" style={{ color: 'var(--muted)', marginBottom: 18 }}>
        {text}
      </div>
      <button className="btn btn--brand press" onClick={onBookings}>{t('Le tue prenotazioni', 'Your bookings')}</button>
    </div>
  );
}
