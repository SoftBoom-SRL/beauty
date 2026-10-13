// ImportApptsModal — import degli appuntamenti da un altro gestionale (CSV/TSV)
// in quattro passi:
// 1) sorgente: il file, con separatore, codifica e intestazione rilevati
// 2) colonne: ogni colonna del file → un campo, e l'unità della durata
// 3) abbinamenti: i servizi e le operatrici del file → quelli del salone
// 4) verifica: le visite (i servizi in fila della stessa cliente sono una sola)
// → POST /api/agenda/appointments/import a blocchi → esito con errori e avvisi.
// Parsing, riconoscimento e raggruppamento stanno in ../lib/importVisits.js.
import React, { useMemo, useRef, useState } from 'react';
import { Icon, Toggle, apiErrorText, timeLabel } from '@youty/shared';
import DkModal from '../../../ui/DkModal.jsx';
import { useDash } from '../../../ctx.jsx';
import { inputCss, dateLabel } from '../../clienti/helpers.js';
import { EncodingPicker, RowList } from '../../clienti/ImportParts.jsx';
import { decodeCsvBytes, detectDelimiter, fileLineOf, looksMojibake, parseCsvLines } from '../../clienti/importCsv.js';
import { importAppointments } from '../agendaApi.js';
import {
  DURATION_UNITS, FIELDS, REQUIRED, buildRows, distinctNames, groupVisits, guessDurationUnit, guessMapping,
  looksLikeHeader, matchNames, operatorOptions, serviceOptions, visitPayload,
} from '../lib/importVisits.js';

/* Ogni visita rivalida turni e sovrapposizioni sul server: blocchi piccoli,
 * così la barra avanza e una richiesta non resta appesa per un minuto. */
const CHUNK = 50;
const STEPS = 4;

/* Fuori dal componente: ridefinito a ogni render sarebbe un tipo nuovo ogni
 * volta e React rimonterebbe l'elenco a ogni scelta. */
function MatchList({ title, names, options, value, onChange, t }) {
  return (
    <div style={{ flex: 1, minWidth: 300 }}>
      <div className="t-meta" style={{ marginBottom: 6 }}>{title} · {names.length}</div>
      <div className="dk-card" style={{ maxHeight: 300, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
        {names.map(({ name, count }, i) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderTop: i ? '1px solid var(--hair-2)' : 'none', fontSize: 12.5 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name} <span style={{ color: 'var(--muted-2)' }}>· {count}</span></span>
            <select value={value[name] || ''} onChange={(e) => onChange({ ...value, [name]: Number(e.target.value) || null })} aria-label={name}
              style={{ ...inputCss, width: 190, padding: '5px 8px', fontSize: 12.5, fontWeight: value[name] ? 700 : 500, borderColor: value[name] ? 'var(--clay)' : 'var(--warn)' }}>
              <option value="">{t('— non importare —', '— do not import —')}</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ImportApptsModal({ onClose }) {
  const { t, lang, fireToast, services, operators, locationId, setSelClient, setTab } = useDash();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [encoding, setEncoding] = useState('auto');
  const [usedEnc, setUsedEnc] = useState(null);   // quella con cui il file è stato letto
  const [text, setText] = useState('');
  const [hasHeader, setHasHeader] = useState(null); // null = rilevata
  const [mapping, setMapping] = useState(null);
  const [dateOrder, setDateOrder] = useState('dmy');
  const [unit, setUnit] = useState(null);           // null = rilevata
  const [svcPick, setSvcPick] = useState(null);     // null = abbinamento automatico
  const [opPick, setOpPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);
  const FIELD_LIST = FIELDS(t);

  // Durante l'invio la finestra non si chiude (Esc, X, clic fuori): chiusa a
  // metà l'import proseguiva e nessuno ne vedeva l'esito.
  const close = () => { if (!busy) onClose(); };

  const records = useMemo(() => (text ? parseCsvLines(text, detectDelimiter(text)) : []), [text]);
  const table = useMemo(() => records.map((r) => r.cells), [records]);
  const effHeader = hasHeader == null ? (table.length ? looksLikeHeader(table[0]) : false) : hasHeader;
  const header = effHeader ? table[0] : null;
  const dataRows = useMemo(() => (effHeader ? table.slice(1) : table), [table, effHeader]);
  const dataLines = useMemo(() => (effHeader ? records.slice(1) : records).map((r) => r.line), [records, effHeader]);
  const nCols = Math.max(header?.length || 0, ...dataRows.map((r) => r.length), 0);
  const effMapping = useMemo(
    () => (mapping && mapping.length === nCols ? mapping : [...guessMapping(header), ...Array(nCols).fill('ignore')].slice(0, nCols)),
    [mapping, nCols, header],
  );
  const durCol = effMapping.indexOf('duration');
  const effUnit = useMemo(() => unit || guessDurationUnit(dataRows.map((r) => r[durCol])), [unit, dataRows, durCol]);
  const rows = useMemo(
    () => buildRows(dataRows, effMapping, { dateOrder, durationUnit: effUnit, lines: dataLines }),
    [dataRows, effMapping, dateOrder, effUnit, dataLines],
  );
  const svcOptions = useMemo(() => serviceOptions(services, lang), [services, lang]);
  const opOptions = useMemo(() => operatorOptions(operators), [operators]);
  const svcNames = useMemo(() => distinctNames(rows, 'service'), [rows]);
  const opNames = useMemo(() => distinctNames(rows, 'operator'), [rows]);
  // L'abbinamento automatico vale finché nessuno lo tocca; una scelta fatta a
  // mano resta anche tornando indietro a correggere una colonna.
  const svcMap = useMemo(() => ({ ...matchNames(svcNames, svcOptions), ...svcPick }), [svcNames, svcOptions, svcPick]);
  const opMap = useMemo(() => ({ ...matchNames(opNames, opOptions), ...opPick }), [opNames, opOptions, opPick]);
  const { visits, excluded } = useMemo(() => groupVisits(rows, svcMap, opMap), [rows, svcMap, opMap]);
  const skippedRows = rows.filter((r) => r._skip);
  const missingFields = REQUIRED.filter((k) => !effMapping.includes(k));
  const hasClient = ['full_name', 'full_name_rev', 'first_name', 'phone'].some((k) => effMapping.includes(k));
  const unmatched = [...svcNames.filter((n) => !svcMap[n.name]), ...opNames.filter((n) => !opMap[n.name])].length;
  const mojibake = looksMojibake(text);

  /* `fresh`: file nuovo, colonne e abbinamenti da rilevare di nuovo. Lo stesso
   * file riletto in un'altra codifica ha le stesse colonne. */
  const readFile = (f, enc, fresh) => {
    const r = new FileReader();
    r.onload = () => {
      const { text: decoded, encoding: used } = decodeCsvBytes(new Uint8Array(r.result), enc);
      setText(decoded); setUsedEnc(used);
      if (fresh) { setMapping(null); setHasHeader(null); setUnit(null); setSvcPick(null); setOpPick(null); setStep(2); }
    };
    r.readAsArrayBuffer(f);
  };
  const pick = (f) => { if (!f) return; setFile(f); readFile(f, encoding, true); };
  const changeEncoding = (enc) => { setEncoding(enc); if (file) readFile(file, enc, false); };
  const encodingPicker = file && <EncodingPicker encoding={encoding} used={usedEnc} mojibake={mojibake} onChange={changeEncoding} t={t} />;

  const svcLabel = (id) => svcOptions.find((o) => o.id === id)?.label || '—';
  const opLabel = (id) => opOptions.find((o) => o.id === id)?.label || '—';
  const clientName = (v) => `${v.first_name} ${v.last_name}`.trim() || v.phone;

  /* Invio a blocchi. Se un blocco fallisce quelli già entrati restano entrati,
   * e si riprende da lì; ripartire da capo non raddoppia niente comunque (il
   * server riconosce le visite già in agenda). */
  const doImport = async (startAt = 0, before = null) => {
    setBusy(true); setProgress(Math.round((startAt / Math.max(1, visits.length)) * 100)); setResult(null);
    const total = before
      ? { ...before, errors: [...before.errors], warnings: [...before.warnings], failedAt: null, failMsg: null }
      : { created: 0, duplicates: 0, skipped: 0, clients_created: 0, errors: [], warnings: [] };
    let i = startAt;
    try {
      for (; i < visits.length; i += CHUNK) {
        const res = await importAppointments({ visits: visits.slice(i, i + CHUNK).map(visitPayload), location_id: locationId });
        ['created', 'duplicates', 'skipped', 'clients_created'].forEach((k) => { total[k] += res[k] || 0; });
        // Il server numera le visite dentro il blocco: chi corregge il file
        // cerca la riga del FILE, la stessa numerata al passo di verifica.
        const at = (e) => ({ ...e, line: fileLineOf(visits, i, e.row), name: visits[i + e.row] ? clientName(visits[i + e.row]) : '' });
        (res.errors || []).forEach((e) => total.errors.push(at(e)));
        (res.warnings || []).forEach((e) => total.warnings.push(at(e)));
        setProgress(Math.min(100, Math.round(((i + CHUNK) / visits.length) * 100)));
      }
      setResult(total);
      fireToast({ msg: t(`${total.created} appuntamenti importati`, `${total.created} appointments imported`), icon: 'check' });
    } catch (err) {
      const msg = apiErrorText(err, t);
      setResult({ ...total, failedAt: i, failMsg: msg });
      fireToast({ msg, icon: 'alert' });
    } finally { setBusy(false); }
  };

  const openClient = (id) => { setSelClient(id); setTab('clienti'); onClose(); };

  const warnLabel = (w) => {
    const cut = w.indexOf(':');
    const k = cut < 0 ? w : w.slice(0, cut);
    const v = cut < 0 ? '' : w.slice(cut + 1);
    const what = { date: t('data', 'date'), startMin: t('ora', 'time'), durationMin: t('durata', 'duration'), service: t('servizio', 'service'), operator: t('operatrice', 'staff member'), client: t('cliente', 'client') };
    return ({
      date: t(`data non valida: “${v}”`, `invalid date: “${v}”`), time: t(`ora non valida: “${v}”`, `invalid time: “${v}”`),
      duration: t(`durata non valida: “${v}”`, `invalid duration: “${v}”`), price: t(`prezzo illeggibile: “${v}” (vale il listino)`, `unreadable price: “${v}” (list price applies)`),
      past: t('giorno già passato', 'day already past'),
      missing: t(`manca: ${v.split(',').map((x) => what[x] || x).join(', ')}`, `missing: ${v.split(',').map((x) => what[x] || x).join(', ')}`),
    })[k] || w;
  };

  /* ---- esito ---- */
  if (result) {
    const failed = result.failedAt != null;
    const resumeLine = failed ? fileLineOf(visits, result.failedAt, 0) : null;
    return (
      <DkModal open onClose={close} title={failed ? t('Importazione interrotta', 'Import interrupted') : t('Importazione completata', 'Import complete')} width={600}
        foot={<React.Fragment>
          {failed && <button className="dk-btn dk-btn--ghost" onClick={() => doImport(result.failedAt, result)}><Icon name="refresh" size={15} />{t(`Riprendi dalla riga ${resumeLine}`, `Resume from row ${resumeLine}`)}</button>}
          <button className="dk-btn dk-btn--clay" onClick={onClose}><Icon name="check" size={16} color="#fff" />{t('Chiudi', 'Close')}</button>
        </React.Fragment>}>
        {failed && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, background: 'var(--warn-tint)', marginTop: 8, fontSize: 13, lineHeight: 1.45 }}>
            <Icon name="alert" size={15} color="var(--warn)" style={{ marginTop: 2, flexShrink: 0 }} />
            <span>{t(`Si è fermata alla riga ${resumeLine}: ${result.failMsg}. Le visite precedenti sono già in agenda (i conteggi qui sotto); da lì in poi non è stato inviato niente.`, `It stopped at row ${resumeLine}: ${result.failMsg}. Earlier visits are already in the calendar (counts below); nothing from there on was sent.`)}</span>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, padding: '8px 0 14px' }}>
          {[[result.created, t('appuntamenti', 'appointments'), 'plus', 'var(--ok)', 'var(--ok-tint)'], [result.clients_created, t('nuove clienti', 'new clients'), 'user', 'var(--ok)', 'var(--ok-tint)'], [result.duplicates, t('già in agenda', 'already there'), 'refresh', 'var(--warn)', 'var(--warn-tint)'], [result.skipped, t('non importati', 'not imported'), 'x', 'var(--muted)', 'var(--paper-2)']].map(([n, l, icon, c, bg]) => (
            <div key={l} className="dk-card" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: 12, boxShadow: 'none', border: '1px solid var(--hair)' }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: bg, display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name={icon} size={16} color={c} /></div>
              <div><div className="t-num" style={{ fontSize: 21, lineHeight: 1 }}>{n}</div><div className="t-sm" style={{ color: 'var(--muted)', marginTop: 2 }}>{l}</div></div>
            </div>
          ))}
        </div>
        {result.errors.length > 0 && (
          <div>
            <div className="t-meta" style={{ marginBottom: 6 }}>{t('Visite non importate', 'Visits not imported')} · {result.errors.length}</div>
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

  const stepTitle = ['', t('1 · File', '1 · File'), t('2 · Colonne', '2 · Columns'), t('3 · Servizi e operatrici', '3 · Services and staff'), t('4 · Verifica', '4 · Review')][step];
  const next = () => {
    if (!table.length) { fireToast({ msg: t('Carica un file', 'Upload a file'), icon: 'alert' }); return; }
    if (step === 2 && (missingFields.length || !hasClient)) { fireToast({ msg: t('Mancano delle colonne: vedi l’avviso sotto la tabella', 'Some columns are missing: see the notice below the table'), icon: 'alert' }); return; }
    if (step === 3 && !visits.length) { fireToast({ msg: t('Abbina almeno un servizio e un’operatrice', 'Match at least one service and one staff member'), icon: 'alert' }); return; }
    setStep(step + 1);
  };
  const gridCols = '40px 96px 52px 1.1fr 1fr 2fr 56px';

  return (
    <DkModal open onClose={close} title={t('Importa appuntamenti', 'Import appointments')} sub={stepTitle} width={860}
      foot={<React.Fragment>
        <span className="t-sm" style={{ marginRight: 'auto', color: 'var(--muted)' }}>
          {table.length ? t(`${dataRows.length} righe · ${visits.length} visite importabili`, `${dataRows.length} rows · ${visits.length} importable visits`) : ''}
        </span>
        {step > 1 && <button className="dk-btn dk-btn--ghost" onClick={() => setStep(step - 1)} disabled={busy}><Icon name="chevL" size={15} />{t('Indietro', 'Back')}</button>}
        <button className="dk-btn dk-btn--ghost" onClick={onClose} disabled={busy}>{t('Annulla', 'Cancel')}</button>
        {step < STEPS ? (
          <button className="dk-btn dk-btn--clay" aria-disabled={!table.length} onClick={next}>{t('Avanti', 'Next')}<Icon name="chevR" size={15} color="#fff" /></button>
        ) : (
          <button className="dk-btn dk-btn--clay" aria-disabled={!visits.length || busy} onClick={() => visits.length && !busy && doImport()}>
            <Icon name="check" size={16} color="#fff" />{busy ? t(`Importo… ${progress}%`, `Importing… ${progress}%`) : t(`Importa ${visits.length} visit${visits.length === 1 ? 'a' : 'e'}`, `Import ${visits.length} visit${visits.length === 1 ? '' : 's'}`)}
          </button>
        )}
      </React.Fragment>}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[...Array(STEPS)].map((_, n) => <span key={n} style={{ flex: 1, height: 4, borderRadius: 99, background: n < step ? 'var(--clay)' : 'var(--hair)' }} />)}
      </div>

      {/* ── 1. file ── */}
      {step === 1 && (
        <div>
          <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files?.[0]); }}
            onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
            style={{ border: '1.5px dashed var(--line-strong)', borderRadius: 14, padding: '26px 20px', textAlign: 'center', cursor: 'pointer', background: 'var(--surface-2)', marginBottom: 14 }}>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} style={{ display: 'none' }} />
            <Icon name="arrowDn" size={22} color="var(--clay-ink)" style={{ margin: '0 auto 8px' }} />
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>{t('Trascina qui il file, oppure clicca per sceglierlo', 'Drop the file here, or click to choose it')}</div>
            <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 4 }}>{t('L’elenco degli appuntamenti esportato dall’altro gestionale (Treatwell e simili), in CSV: una riga per servizio.', 'The appointment list exported from the other software (Treatwell and the like), as CSV: one row per service.')}</div>
            {file && <div className="t-sm" style={{ marginTop: 8, fontWeight: 700, color: 'var(--ink)' }}>{file.name} · {Math.round(file.size / 1024)} KB</div>}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', lineHeight: 1.5 }}>
            {t('Entrano in agenda solo gli appuntamenti da oggi in poi. Alle clienti non parte nessuna conferma e non viene chiesta nessuna caparra: sono appuntamenti che hanno già. Servizi e operatrici devono esistere nel listino e nello staff: li abbini al passo 3.', 'Only appointments from today onwards are imported. No confirmation is sent to clients and no deposit is requested: these are bookings they already have. Services and staff must exist in your catalogue and team: you match them in step 3.')}
          </div>
        </div>
      )}

      {/* ── 2. colonne ── */}
      {step === 2 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
              <Toggle on={effHeader} onChange={(v) => { setHasHeader(v); setMapping(null); }} />{t('La prima riga è l’intestazione', 'First row is the header')}
            </label>
            {encodingPicker}
            <div style={{ flex: 1 }} />
            <button type="button" onClick={() => setMapping(null)} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--clay-ink)', cursor: 'pointer', background: 'transparent', border: 'none' }}>{t('Rileva di nuovo', 'Auto-detect again')}</button>
          </div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--hair)', borderRadius: 12 }}>
            <table style={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: 12.5 }}>
              <thead>
                <tr style={{ background: 'var(--surface-2)' }}>
                  {[...Array(nCols)].map((_, i) => (
                    <th key={i} style={{ padding: '8px 8px', textAlign: 'left', borderBottom: '1px solid var(--hair)', minWidth: 150, verticalAlign: 'top' }}>
                      <div className="t-sm" style={{ color: 'var(--muted-2)', fontSize: 11, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{(header && header[i]) || t(`Colonna ${i + 1}`, `Column ${i + 1}`)}</div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
            {durCol >= 0 && (
              <label className="t-sm" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>{t('La durata è scritta in', 'Duration is written as')}
                <select value={effUnit} onChange={(e) => setUnit(e.target.value)} style={{ ...inputCss, width: 'auto', padding: '5px 8px', fontSize: 12.5 }}>
                  {DURATION_UNITS(t).map((u) => <option key={u.k} value={u.k}>{u.label}</option>)}
                </select>
              </label>
            )}
            <span className="t-sm" style={{ fontWeight: 600 }}>{t('Date ambigue (es. 03/04):', 'Ambiguous dates (e.g. 03/04):')}</span>
            {[['dmy', t('giorno/mese', 'day/month')], ['mdy', t('mese/giorno', 'month/day')]].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setDateOrder(k)} className={'dk-pill' + (dateOrder === k ? ' dk-pill--on' : '')} style={{ padding: '4px 10px', fontSize: 12 }}>{l}</button>
            ))}
          </div>
          {(missingFields.length > 0 || !hasClient) && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--warn)', fontSize: 12.5, fontWeight: 600 }}>
              <Icon name="alert" size={14} color="var(--warn)" />
              {t('Scegli la colonna di: ', 'Pick the column for: ')}{[...missingFields.map((k) => FIELD_LIST.find((f) => f.k === k).label), ...(hasClient ? [] : [t('Cliente (nome o telefono)', 'Client (name or phone)')])].join(', ')}
            </div>
          )}
        </div>
      )}

      {/* ── 3. servizi e operatrici ── */}
      {step === 3 && (
        <div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>
            {t('A sinistra i nomi come sono scritti nel file (e in quante righe), a destra la voce del salone. Quelli con lo stesso nome sono già abbinati; un nome lasciato su «non importare» lascia fuori le sue righe. Se un servizio o un’operatrice manca, creali prima nel listino o nello staff e riapri l’import.', 'On the left the names as written in the file (and in how many rows), on the right your salon’s entry. Identical names are already matched; a name left on “do not import” leaves its rows out. If a service or staff member is missing, create it first and reopen the import.')}
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <MatchList title={t('Servizi nel file', 'Services in the file')} names={svcNames} options={svcOptions} value={svcMap} onChange={setSvcPick} t={t} />
            <MatchList title={t('Operatrici nel file', 'Staff in the file')} names={opNames} options={opOptions} value={opMap} onChange={setOpPick} t={t} />
          </div>
          {unmatched > 0 && (
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', color: 'var(--warn)', fontSize: 12.5, fontWeight: 600 }}>
              <Icon name="alert" size={14} color="var(--warn)" />{t(`${unmatched} nomi non abbinati: ${excluded} righe resteranno fuori`, `${unmatched} unmatched names: ${excluded} rows will be left out`)}
            </div>
          )}
        </div>
      )}

      {/* ── 4. verifica ── */}
      {step === 4 && (
        <div>
          <div className="dk-card" style={{ overflow: 'hidden', maxHeight: 340, overflowY: 'auto', boxShadow: 'none', border: '1px solid var(--hair)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 12px', background: 'var(--surface-2)', borderBottom: '1px solid var(--hair)', position: 'sticky', top: 0 }}>
              {['#', t('Giorno', 'Day'), t('Ora', 'Time'), t('Cliente', 'Client'), t('Telefono', 'Phone'), t('Servizi · operatrice', 'Services · staff'), t('Durata', 'Length')].map((h) => <span key={h} className="t-meta" style={{ fontSize: 10 }}>{h}</span>)}
            </div>
            {visits.slice(0, 200).map((v) => (
              <div key={v._line} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '7px 12px', borderTop: '1px solid var(--hair-2)', alignItems: 'center', fontSize: 12.5 }}>
                {/* la riga del FILE del primo servizio, la stessa degli errori dell'esito */}
                <span className="t-sm tabnum" style={{ color: 'var(--muted-2)' }}>{v._line}</span>
                <span style={{ color: 'var(--ink-2)' }}>{dateLabel(v._date, lang)}</span>
                <span className="tabnum" style={{ fontWeight: 600 }}>{timeLabel(v._startMin)}</span>
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clientName(v)}</span>
                <span className="tabnum" style={{ color: v.phone ? 'var(--ink-2)' : 'var(--warn)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.phone || t('senza numero', 'no number')}</span>
                <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.items.map((it) => `${svcLabel(it.service_id)} · ${opLabel(it.operator_id)}`).join('\n')}>{v.items.map((it) => `${svcLabel(it.service_id)} · ${opLabel(it.operator_id).split(' ')[0]}`).join(' + ')}</span>
                <span className="tabnum" style={{ color: 'var(--muted)' }}>{v.items.reduce((n, it) => n + it.duration_min, 0)}′</span>
              </div>
            ))}
            {visits.length > 200 && <div className="t-sm" style={{ padding: '8px 12px', color: 'var(--muted-2)' }}>{t(`… e altre ${visits.length - 200} visite`, `… and ${visits.length - 200} more visits`)}</div>}
          </div>
          <div className="t-sm" style={{ color: 'var(--muted)', marginTop: 8, lineHeight: 1.5 }}>
            {t(`${visits.length} visite da ${visits.reduce((n, v) => n + v.items.length, 0)} righe: i servizi in fila della stessa cliente diventano una visita sola.`, `${visits.length} visits from ${visits.reduce((n, v) => n + v.items.length, 0)} rows: back-to-back services of the same client become one visit.`)}
            {excluded > 0 ? t(` ${excluded} righe fuori perché non abbinate.`, ` ${excluded} rows left out as unmatched.`) : ''}
            {' '}{t('Una cliente senza numero entra solo se in rubrica c’è una sola scheda con quel nome; con il numero, se manca viene creata.', 'A client without a number is imported only if exactly one profile has that name; with a number, a missing client is created.')}
          </div>
          {skippedRows.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="t-meta" style={{ marginBottom: 6 }}>{t('Righe che non si possono importare', 'Rows that cannot be imported')} · {skippedRows.length}</div>
              <RowList items={skippedRows.slice(0, 100).map((r) => ({ line: r._line, name: `${r.first_name} ${r.last_name}`.trim(), reason: r._warn.map(warnLabel).join(' · ') }))} onOpen={openClient} t={t} />
            </div>
          )}
        </div>
      )}
    </DkModal>
  );
}
