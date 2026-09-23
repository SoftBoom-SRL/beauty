// BulkImportModal — import clienti da CSV/TSV o testo incollato in tre passi:
// 1) sorgente: file o incolla, con delimitatore, codifica e intestazione rilevati
// 2) mappatura: ogni colonna del file → un campo (suggerita dai titoli o dal
//    contenuto), con anteprima dei valori
// 3) verifica: righe normalizzate (telefono, genere, compleanno con o senza
//    anno, etichette), avvisi per riga, scelta se aggiornare gli esistenti
// → POST /api/clients/import a blocchi → esito con errori e avvisi per riga.
// Parsing, riconoscimento e normalizzazione stanno in ../importCsv.js.
import React, { useMemo, useRef, useState } from 'react';
import { api, ApiError, Icon, Toggle, isPlausiblePhone } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import { inputCss, formatBirthday, dateLabel } from '../helpers.js';
import {
  FIELDS, buildRows, decodeCsvBytes, detectDelimiter, fileLineOf, guessMapping,
  looksLikeHeader, looksMojibake, parseCsvLines,
} from '../importCsv.js';

/* ---------- componente ---------- */
/* Fuori dal componente: ridefinito a ogni render sarebbe un tipo nuovo ogni
 * volta e React rimonterebbe la barra a ogni tasto premuto. */
const Steps = ({ step }) => (
  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
    {[1, 2, 3].map((n) => <span key={n} style={{ flex: 1, height: 4, borderRadius: 99, background: n <= step ? 'var(--clay)' : 'var(--hair)' }} />)}
  </div>
);

const ENC_LABEL = { 'utf-8': 'UTF-8', 'windows-1252': 'Windows-1252', 'iso-8859-1': 'ISO-8859-1' };

/* Codifica del file, in ogni passo: stava solo nel primo, che caricando un
 * file si salta, e un CSV di Excel italiano entrava con «�» al posto degli
 * accenti senza che nessuno lo vedesse (14-08). */
function EncodingPicker({ encoding, used, mojibake, onChange, t }) {
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
function RowList({ items, onOpen, t }) {
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

const CHUNK = 250;

export default function BulkImportModal({ onClose }) {
  const { t, lang, fireToast, setSelClient, setTab, tab } = useDash();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [encoding, setEncoding] = useState('auto');
  const [usedEnc, setUsedEnc] = useState(null);   // quella con cui il file è stato letto
  const [text, setText] = useState('');
  const [delim, setDelim] = useState(null);      // null = auto
  const [hasHeader, setHasHeader] = useState(null); // null = auto
  const [mapping, setMapping] = useState(null);
  const [dateOrder, setDateOrder] = useState('dmy');
  const [updateExisting, setUpdateExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const FIELD_LIST = FIELDS(t);

  // Durante l'invio la finestra non si chiude (Esc, X, clic fuori): chiusa a
  // metà l'import proseguiva in background e nessuno ne vedeva l'esito (14-18).
  const close = () => { if (!busy) onClose(); };

  const effDelim = delim || (text ? detectDelimiter(text) : ',');
  const records = useMemo(() => (text ? parseCsvLines(text, effDelim) : []), [text, effDelim]);
  const table = useMemo(() => records.map((r) => r.cells), [records]);
  const headerAuto = table.length ? looksLikeHeader(table[0]) : false;
  const effHeader = hasHeader == null ? headerAuto : hasHeader;
  const header = effHeader ? table[0] : null;
  const dataRows = useMemo(() => (effHeader ? table.slice(1) : table), [table, effHeader]);
  // numero di riga nel FILE di ogni riga di dati (intestazione e righe vuote comprese)
  const dataLines = useMemo(() => (effHeader ? records.slice(1) : records).map((r) => r.line), [records, effHeader]);
  const nCols = Math.max(header?.length || 0, ...dataRows.map((r) => r.length), 0);
  const effMapping = useMemo(
    () => (mapping && mapping.length === nCols ? mapping : guessMapping(header, dataRows)),
    [mapping, nCols, header, dataRows],
  );
  const rows = useMemo(
    () => buildRows(dataRows, effMapping, { dateOrder, lines: dataLines, plausiblePhone: isPlausiblePhone }),
    [dataRows, effMapping, dateOrder, dataLines],
  );
  const ready = rows.filter((r) => !r._skip);
  const mappedKeys = new Set(effMapping);
  const mojibake = looksMojibake(text);

  /* `fresh`: file nuovo, colonne da rilevare di nuovo. Lo stesso file riletto
   * in un'altra codifica ha le stesse colonne: la mappatura scelta resta. */
  const readFile = (f, enc, fresh) => {
    const r = new FileReader();
    r.onload = () => {
      const { text: decoded, encoding: used } = decodeCsvBytes(new Uint8Array(r.result), enc);
      setText(decoded); setUsedEnc(used);
      if (fresh) { setMapping(null); setStep(2); }
    };
    r.readAsArrayBuffer(f);
  };
  const onFile = (e) => { const f = e.target.files?.[0]; if (!f) return; setFile(f); readFile(f, encoding, true); e.target.value = ''; };
  const changeEncoding = (enc) => { setEncoding(enc); if (file) readFile(file, enc, false); };
  const encodingPicker = file && <EncodingPicker encoding={encoding} used={usedEnc} mojibake={mojibake} onChange={changeEncoding} t={t} />;

  /* Invio a blocchi. Se un blocco fallisce, quelli già entrati restano entrati:
   * l'esito lo dice e si riprende da lì. Rilanciare tutto da capo con
   * «aggiorna esistenti» ricreava ogni nota già importata (14-18). */
  const doImport = async (startAt = 0, before = null) => {
    const payload = ready.map(({ _idx, _line, _warn, _skip, ...r }) => r);
    setBusy(true); setProgress(Math.round((startAt / Math.max(1, payload.length)) * 100)); setResult(null);
    const total = before
      ? { created: before.created, updated: before.updated, skipped: before.skipped, errors: [...before.errors], warnings: [...before.warnings] }
      : { created: 0, updated: 0, skipped: 0, errors: [], warnings: [] };
    let i = startAt;
    try {
      for (; i < payload.length; i += CHUNK) {
        const res = await api.post('/api/clients/import', { rows: payload.slice(i, i + CHUNK), update_existing: updateExisting });
        total.created += res.created; total.updated += res.updated; total.skipped += res.skipped || 0;
        // Il server numera le righe dentro il blocco inviato, che salta le
        // righe scartate: chi corregge il file cerca la riga del FILE, la
        // stessa numerata nell'anteprima del passo 3.
        const at = (e) => ({
          ...e,
          line: fileLineOf(ready, i, e.row),
          name: `${payload[i + e.row]?.first_name || ''} ${payload[i + e.row]?.last_name || ''}`.trim(),
        });
        (res.errors || []).forEach((e) => total.errors.push(at(e)));
        // righe entrate lasciando fuori un dato illeggibile (server con `warnings`)
        (res.warnings || []).forEach((e) => total.warnings.push(at(e)));
        setProgress(Math.min(100, Math.round(((i + CHUNK) / payload.length) * 100)));
      }
      total.skipped += rows.length - ready.length;
      setResult(total);
      fireToast({ msg: t(`Importati ${total.created} nuovi · ${total.updated} aggiornati`, `${total.created} added · ${total.updated} updated`), icon: 'check' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : t('Errore di rete', 'Network error');
      setResult({ ...total, failedAt: i, failMsg: msg });
      fireToast({ msg, icon: 'alert' });
    } finally { setBusy(false); }
  };

  const openClient = (id) => { setSelClient(id); if (tab !== 'clienti') setTab('clienti'); onClose(); };

  const warnLabel = (w) => {
    const cut = w.indexOf(':');
    const k = cut < 0 ? w : w.slice(0, cut);
    const v = cut < 0 ? '' : w.slice(cut + 1);
    return ({
      name: t('nome mancante', 'missing name'), nophone: t('senza telefono: verrà cercato per email', 'no phone: matched by email only'), phone: t('telefono non valido', 'invalid phone'),
      badphone: t(`telefono da controllare: “${v}” (entra così com’è)`, `phone to check: “${v}” (imported as is)`),
      phonesci: t(`numero rovinato da Excel: “${v}” — esporta la colonna come testo`, `number mangled by Excel: “${v}” — export the column as text`),
      gender: t(`genere non riconosciuto: “${v}”`, `unrecognised gender: “${v}”`), birthday: t(`data non valida: “${v}”`, `invalid date: “${v}”`), email: t(`email non valida: “${v}”`, `invalid email: “${v}”`),
      since: t(`«cliente dal» non valido: “${v}” (serve una data con l’anno, non futura)`, `invalid “client since”: “${v}” (needs a full, non-future date)`),
      dup: t(`stesso telefono della riga ${v}`, `same phone as row ${v}`),
    })[k] || w;
  };

  /* ---- esito ---- */
  if (result) {
    const failed = result.failedAt != null;
    const resumeLine = failed ? fileLineOf(ready, result.failedAt, 0) : null;
    return (
      <DkModal open onClose={close} title={failed ? t('Importazione interrotta', 'Import interrupted') : t('Importazione completata', 'Import complete')} width={560}
        foot={<React.Fragment>
          {failed && <button className="dk-btn dk-btn--ghost" onClick={() => doImport(result.failedAt, result)}><Icon name="refresh" size={15} />{t(`Riprendi dalla riga ${resumeLine}`, `Resume from row ${resumeLine}`)}</button>}
          <button className="dk-btn dk-btn--clay" onClick={onClose}><Icon name="check" size={16} color="#fff" />{t('Chiudi', 'Close')}</button>
        </React.Fragment>}>
        {failed && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--warn-tint)', marginTop: 8, fontSize: 13, lineHeight: 1.45 }}>
            <Icon name="alert" size={15} color="var(--warn)" style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{t(`Si è fermata alla riga ${resumeLine}: ${result.failMsg}. Le righe precedenti sono già in rubrica (i conteggi qui sotto); da lì in poi non è stato inviato niente.`, `It stopped at row ${resumeLine}: ${result.failMsg}. Earlier rows are already saved (counts below); nothing from there on was sent.`)}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '8px 0 14px' }}>
          {[[result.created, t('nuovi clienti', 'new clients'), 'plus', 'var(--ok)', 'var(--ok-tint)'], [result.updated, t('aggiornati', 'updated'), 'refresh', 'var(--warn)', 'var(--warn-tint)'], [result.skipped, t('saltati', 'skipped'), 'x', 'var(--muted)', 'var(--paper-2)']].map(([n, l, icon, c, bg]) => (
            <div key={l} className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: 14, boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center' }}><Icon name={icon} size={17} color={c} /></div>
              <div><div className="t-num" style={{ fontSize: 22, lineHeight: 1 }}>{n}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{l}</div></div>
            </div>
          ))}
        </div>
        {result.errors.length > 0 && (
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Righe non importate', 'Rows not imported')} · {result.errors.length}</div>
            <RowList items={result.errors} onOpen={openClient} t={t} />
          </div>
        )}
        {result.warnings.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Importate con un avviso', 'Imported with a warning')} · {result.warnings.length}</div>
            <RowList items={result.warnings} onOpen={openClient} t={t} />
          </div>
        )}
      </DkModal>
    );
  }

  const stepTitle = ['', t('1 · Sorgente', '1 · Source'), t('2 · Colonne', '2 · Columns'), t('3 · Verifica', '3 · Review')][step];
  const showSince = mappedKeys.has('since');
  const gridCols = `40px 1fr 1fr 1fr 1.2fr 44px 1fr${showSince ? ' 0.9fr' : ''} 1fr`;

  return (
    <DkModal open onClose={close} title={t('Importa clienti', 'Import clients')} sub={stepTitle} width={820}
      foot={<React.Fragment>
        <span className="t-sm" style={{ marginRight: 'auto', color: 'var(--muted)' }}>
          {table.length ? t(`${dataRows.length} righe · ${ready.length} importabili`, `${dataRows.length} rows · ${ready.length} importable`) : ''}
        </span>
        {step > 1 && <button className="dk-btn dk-btn--ghost" onClick={() => setStep(step - 1)} disabled={busy}><Icon name="chevL" size={15} />{t('Indietro', 'Back')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose} disabled={busy}>{t('Annulla', 'Cancel')}</button>
        {step < 3 ? (
          <button className="dk-btn dk-btn--clay" aria-disabled={!table.length} onClick={() => { if (!table.length) { fireToast({ msg: t('Carica un file o incolla i dati', 'Upload a file or paste data'), icon: 'alert' }); return; } if (step === 2 && !mappedKeys.has('phone') && !mappedKeys.has('email')) { fireToast({ msg: t('Serve almeno la colonna Telefono (o Email)', 'Map at least the Phone (or Email) column'), icon: 'alert' }); return; } setStep(step + 1); }}>
            {t('Avanti', 'Next')}<Icon name="chevR" size={15} color="#fff" />
          </button>
        ) : (
          <button className="dk-btn dk-btn--clay" aria-disabled={!ready.length || busy} onClick={() => ready.length && !busy && doImport()}>
            <Icon name="check" size={16} color="#fff" />{busy ? t(`Importo… ${progress}%`, `Importing… ${progress}%`) : t(`Importa ${ready.length} client${ready.length === 1 ? 'e' : 'i'}`, `Import ${ready.length} client${ready.length === 1 ? '' : 's'}`)}
          </button>
        )}
      </React.Fragment>}>
      <Steps step={step} />

      {/* ── 1. sorgente ── */}
      {step === 1 && (
        <div>
          <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) { setFile(f); readFile(f, encoding, true); } }}
            onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
            style={{ border: '1.5px dashed var(--line-strong)', borderRadius: 14, padding: '22px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--surface-2)', marginBottom: 14 }}>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={onFile} style={{ display: 'none' }} />
            <Icon name="arrowDn" size={22} color="var(--clay-ink)" style={{ margin: '0 auto 8px' }} />
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>{t('Trascina qui il file, oppure clicca per sceglierlo', 'Drop the file here, or click to choose it')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('CSV, TSV o testo: da Excel, Numbers, Google Fogli, altri gestionali. Le colonne le scegli al passo dopo.', 'CSV, TSV or text: from Excel, Numbers, Google Sheets, other software. You pick the columns next.')}</div>
            {file && <div className="t-sm" style={{ marginTop: 8, fontWeight: 700, color: 'var(--ink)' }}>{file.name} · {Math.round(file.size / 1024)} KB</div>}
          </div>
          <div className="t-meta" style={{ marginBottom: 6 }}>{t('oppure incolla', 'or paste')}</div>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setMapping(null); setFile(null); setUsedEnc(null); }} rows={6} placeholder={'Nome;Cognome;Telefono;Email;Genere;Compleanno\nSofia;Ricci;+39 348 221 0094;sofia@email.it;F;15/03\nGiada;Neri;333 118 4420;;donna;24/12/1990'} style={{ ...inputCss, fontFamily: 'var(--mono, monospace)', fontSize: 12.5, resize: 'vertical' }} />
          {text && (
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <label className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{t('Separatore', 'Delimiter')}
                <select value={delim || 'auto'} onChange={(e) => { setDelim(e.target.value === 'auto' ? null : e.target.value); setMapping(null); }} style={{ ...inputCss, width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
                  <option value="auto">{t('automatico', 'auto')} ({effDelim === '\t' ? 'TAB' : effDelim})</option><option value=",">,</option><option value=";">;</option><option value={'\t'}>TAB</option><option value="|">|</option>
                </select>
              </label>
              {encodingPicker}
              <span className="t-sm" style={{ color: 'var(--muted)' }}>{table.length} {t('righe rilevate', 'rows detected')}</span>
            </div>
          )}
        </div>
      )}

      {/* ── 2. mappatura colonne ── */}
      {step === 2 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
              <Toggle on={effHeader} onChange={(v) => { setHasHeader(v); setMapping(null); }} />{t('La prima riga è l’intestazione', 'First row is the header')}
              {hasHeader == null && <span className="t-sm" style={{ color: 'var(--muted-2)' }}>· {t('rilevato', 'detected')}</span>}
            </label>
            {encodingPicker}
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setMapping(null)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Rileva di nuovo', 'Auto-detect again')}</button>
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 10 }}>{t('Per ogni colonna del file scegli il campo di destinazione. “Nome e cognome” si divide dopo la prima parola, “Cognome e nome” dopo il cognome (de, di, della… compresi): al passo 3 nome e cognome si vedono separati. Le etichette si separano con virgola, punto e virgola o barra.', 'For each file column pick the destination field. “First and last name” is split after the first word, “Last and first name” after the surname (de, di, della… included): step 3 shows first and last name apart. Labels may be separated by comma, semicolon or slash.')}</div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--hair)', borderRadius: 12 }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  {[...Array(nCols)].map((_, i) => (
                    <th key={i} style={{ padding: '8px 8px', textAlign: 'left', borderBottom: '1px solid var(--hair)', minWidth: 150, verticalAlign: 'top' }}>
                      <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{header ? header[i] || t(`Colonna ${i + 1}`, `Column ${i + 1}`) : t(`Colonna ${i + 1}`, `Column ${i + 1}`)}</div>
                      <select value={effMapping[i]} onChange={(e) => { const m = [...effMapping]; m[i] = e.target.value; setMapping(m); }}
                        style={{ ...inputCss, padding: '6px 8px', fontSize: 12.5, fontWeight: effMapping[i] === 'ignore' ? 500 : 700, color: effMapping[i] === 'ignore' ? 'var(--muted)' : 'var(--ink)', borderColor: effMapping[i] === 'ignore' ? 'var(--hair)' : 'var(--clay)' }}>
                        {FIELD_LIST.map((f) => <option key={f.k} value={f.k}>{f.label}</option>)}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.slice(0, 5).map((r, ri) => (
                  <tr key={ri}>{[...Array(nCols)].map((_, i) => <td key={i} style={{ padding: '6px 8px', borderTop: '1px solid var(--hair-2)', color: effMapping[i] === 'ignore' ? 'var(--muted-2)' : 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{r[i] || <span style={{ color: 'var(--faint)' }}>—</span>}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {(mappedKeys.has('birthday') || mappedKeys.has('since')) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <span className="t-sm" style={{ fontWeight: 600 }}>{t('Date numeriche ambigue (es. 03/04):', 'Ambiguous numeric dates (e.g. 03/04):')}</span>
              {[['dmy', t('giorno/mese/anno', 'day/month/year')], ['mdy', t('mese/giorno/anno', 'month/day/year')]].map(([k, l]) => (
                <button key={k} type="button" onClick={() => setDateOrder(k)} className={'dk-pill' + (dateOrder === k ? ' dk-pill--on' : '')} style={{ padding: '4px 10px', fontSize: 12 }}>{l}</button>
              ))}
              <span className="t-sm" style={{ color: 'var(--muted-2)' }}>{t('Accettati anche 15/03 senza anno, 2024-03-15, “15 marzo 1990”.', 'Also accepted: 15/03 without year, 2024-03-15, “15 March 1990”.')}</span>
            </div>
          )}
          {!mappedKeys.has('phone') && <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--warn)', fontSize: 12.5, fontWeight: 600 }}><Icon name="alert" size={14} color="var(--warn)" />{t('Nessuna colonna Telefono: i nuovi clienti non possono essere creati senza numero (gli esistenti si aggiornano per email).', 'No Phone column: new clients cannot be created without a number (existing ones update by email).')}</div>}
        </div>
      )}

      {/* ── 3. verifica ── */}
      {step === 3 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
              <Toggle on={updateExisting} onChange={setUpdateExisting} />
              <span>{t('Aggiorna i clienti già in rubrica', 'Update clients already on file')} <span className="t-sm" style={{ color: 'var(--muted)', fontWeight: 500 }}>· {t('stesso telefono o email; i campi vuoti nel file non cancellano nulla', 'same phone or email; blank cells never erase data')}</span></span>
            </label>
            <div style={{ flex: 1 }} />
            {encodingPicker}
          </div>
          <div className="dk-card" style={{ overflow: 'hidden', maxHeight: 340, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hair)', position: 'sticky', top: 0 }}>
              {['#', t('Nome', 'First name'), t('Cognome', 'Last name'), t('Telefono', 'Phone'), 'Email', t('Gen.', 'Gen.'), t('Compleanno', 'Birthday'), ...(showSince ? [t('Cliente dal', 'Since')] : []), t('Etichette / note', 'Labels / notes')].map((h) => <span key={h} className="t-meta" style={{ fontSize: 10 }}>{h}</span>)}
            </div>
            {rows.slice(0, 200).map((r) => (
              <div key={r._idx} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '7px 12px', borderTop: '1px solid var(--hair-2)', alignItems: 'center', fontSize: 12.5, opacity: r._skip ? 0.55 : 1, background: r._skip ? 'var(--danger-tint)' : r._warn.length ? 'color-mix(in srgb, var(--warn-tint) 60%, transparent)' : 'transparent' }}>
                {/* la riga del FILE, la stessa degli errori dell'esito (14-17) */}
                <span className="t-sm tabnum" style={{ color: 'var(--muted-2)' }}>{r._line}</span>
                {/* nome e cognome separati: concatenati sembravano giusti anche
                    quando «ROSSI MARIA» finiva con nome ROSSI (14-16) */}
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.first_name || <span style={{ color: 'var(--danger)' }}>{t('nome mancante', 'missing name')}</span>}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: r.last_name ? 'var(--ink-2)' : 'var(--muted-2)' }}>{r.last_name || '—'}</span>
                <span className="tabnum" style={{ color: r.phone ? 'var(--ink-2)' : 'var(--muted-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.phone || '—'}</span>
                <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email || '—'}</span>
                <span style={{ color: 'var(--muted)' }}>{r.gender === 'female' ? '♀' : r.gender === 'male' ? '♂' : r.gender === 'other' ? '⚧' : '—'}</span>
                <span style={{ color: 'var(--muted)' }}>{r.birthday ? formatBirthday(r.birthday, lang) : '—'}</span>
                {showSince && <span style={{ color: 'var(--muted)' }}>{r.since ? dateLabel(r.since, lang) : '—'}</span>}
                <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={[...r.categories, r.note].filter(Boolean).join(' · ')}>{[...r.categories, r.note ? '📝' : ''].filter(Boolean).join(', ') || '—'}</span>
                {r._warn.length > 0 && <div style={{ gridColumn: '2 / -1', display: 'flex', gap: 6, flexWrap: 'wrap' }}>{r._warn.map((w) => <span key={w} style={{ fontSize: 11, fontWeight: 600, color: r._skip && (w === 'name' || w === 'nophone') ? 'var(--danger)' : 'var(--warn)', display: 'inline-flex', alignItems: 'center', gap: 3 }}><Icon name="alert" size={10} color="currentColor" />{warnLabel(w)}</span>)}</div>}
              </div>
            ))}
            {rows.length > 200 && <div className="t-sm" style={{ padding: '8px 12px', color: 'var(--muted-2)' }}>{t(`… e altre ${rows.length - 200} righe`, `… and ${rows.length - 200} more rows`)}</div>}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8 }}>
            {t(`${ready.length} righe verranno importate`, `${ready.length} rows will be imported`)}{rows.length - ready.length > 0 ? t(` · ${rows.length - ready.length} saltate (senza nome o senza telefono/email)`, ` · ${rows.length - ready.length} skipped (no name or no phone/email)`) : ''}. {t('Le etichette non ancora esistenti vengono create; le note diventano note private sulla scheda.', 'Labels that do not exist yet are created; notes become private notes on the profile.')}
          </div>
        </div>
      )}
    </DkModal>
  );
}
