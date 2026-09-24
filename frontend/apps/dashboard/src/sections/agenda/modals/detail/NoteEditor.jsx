// NoteEditor — la nota dell'appuntamento: si scrive solo dove la si può anche
// salvare (`itemsEditable`); su una visita chiusa, o senza il permesso
// agenda, il campo era modificabile, il pulsante di salvataggio non compariva
// e l'avviso rimandava a un tasto che non c'era (13-23). Si salva dal piede,
// insieme ai servizi.
import React from 'react';

export default function NoteEditor({ appt, t, itemsEditable, note, setNote, noteDirty }) {
  return (
    <div>
      <div className="t-meta" style={{ marginBottom: 6 }}>{t('Nota appuntamento', 'Appointment note')}</div>
      {itemsEditable ? (
        <React.Fragment>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t('Aggiungi una nota…', 'Add a note…')}
            style={{ width: '100%', border: '1px solid var(--hair)', borderRadius: 12, padding: '10px 12px', fontSize: 13.5, fontFamily: 'var(--sans)', resize: 'vertical', outline: 'none', boxSizing: 'border-box', background: 'var(--surface)' }} />
          {noteDirty && (
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 5 }}>{t('Nota modificata: si salva col pulsante in fondo.', 'Note changed: save it with the button below.')}</div>
          )}
        </React.Fragment>
      ) : (
        <div className="t-sm" style={{ whiteSpace: 'pre-wrap', color: appt.note ? 'var(--ink-2)' : 'var(--muted-2)', padding: '8px 12px', borderRadius: 12, background: 'var(--surface-2)' }}>
          {appt.note || t('Nessuna nota', 'No note')}
        </div>
      )}
    </div>
  );
}
