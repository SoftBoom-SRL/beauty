// ImportParts.jsx — i pezzi comuni alle finestre di import da file (clienti,
// appuntamenti): la scelta della codifica e l'elenco delle righe dell'esito.
import { inputCss } from './helpers.js';

const ENC_LABEL = { 'utf-8': 'UTF-8', 'windows-1252': 'Windows-1252', 'iso-8859-1': 'ISO-8859-1' };

/* Codifica del file, in ogni passo: stava solo nel primo, che caricando un
 * file si salta, e un CSV di Excel italiano entrava con «�» al posto degli
 * accenti senza che nessuno lo vedesse (14-08). */
export function EncodingPicker({ encoding, used, mojibake, onChange, t }) {
  return (
    <label className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{t('Codifica', 'Encoding')}
      <select value={encoding} onChange={(e) => onChange(e.target.value)} style={{ ...inputCss, width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
        <option value="auto">{t('automatica', 'auto')}{encoding === 'auto' && used ? ` (${ENC_LABEL[used] || used})` : ''}</option>
        <option value="utf-8">UTF-8</option><option value="windows-1252">Windows-1252 (Excel IT)</option><option value="iso-8859-1">ISO-8859-1</option>
      </select>
      {mojibake && <span style={{ color: 'var(--warn)', fontWeight: 700 }}>{t('accenti strani? prova un’altra codifica', 'odd accents? try another encoding')}</span>}
    </label>
  );
}

/* Righe dell'esito (errori o avvisi del server), col numero di riga del file.
 * `client_id` indica la scheda coinvolta (archiviata, email di un'altra
 * persona): si apre invece di lasciare un vicolo cieco. */
export function RowList({ items, onOpen, t }) {
  return (
    <div className="dk-card" style={{ maxHeight: 200, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
      {items.map((e, i) => (
        <div key={i} className="t-sm" style={{ padding: '7px 12px', borderTop: i ? '1px solid var(--hair)' : 'none', display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ flex: 1 }}><b>{t('Riga', 'Row')} {e.line}</b>{e.name ? ` · ${e.name}` : ''} — {e.reason}</span>
          {e.client_id && <button type="button" onClick={() => onOpen(e.client_id)} style={{ fontSize: 12, fontWeight: 700, color: 'var(--clay-ink)', background: 'transparent', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap' }}>{t('Apri scheda', 'Open profile')}</button>}
        </div>
      ))}
    </div>
  );
}
